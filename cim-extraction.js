const EXTRACTION_MODEL = process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-flash';
const { isTrustedBlobUrl } = require('./blob-storage');

let getBlob = null;

try {
  ({ get: getBlob } = require('@vercel/blob'));
} catch {
  getBlob = null;
}

const EXTRACTION_PROMPT = `You are extracting financial data from a bankers' sellside CIM / management plan PDF.

Your job:
- Extract historical and forecast Revenue, Gross Profit, and EBITDA from the main financial summary / plan tables in the document.
- Focus on consolidated company figures unless the document clearly only presents segment figures.
- Preserve the source currency and units exactly as stated in the document.
- Distinguish historical periods from forecast periods.
- Prefer the most complete summary table if multiple similar tables exist.
- Do not infer or invent values that are not explicitly present.
- If a value is unavailable, return null.
- Include source page references for every extracted row where possible.
- Include confidence and notes for ambiguous rows.
- Add warnings if:
  - multiple inconsistent tables are present
  - units are unclear
  - reported vs adjusted EBITDA is unclear
  - gross profit is not explicitly shown
  - forecast case selection is ambiguous

Prioritize tables/pages with titles similar to:
- Financial Summary
- Historical Financials
- Forecast
- Business Plan
- Management Case
- Base Case
- Revenue Build
- EBITDA Bridge

Ignore marketing pages and narrative pages unless needed to clarify labels.`;

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    company_name: { type: ['string', 'null'] },
    source_table_name: { type: ['string', 'null'] },
    currency: { type: ['string', 'null'] },
    units: {
      type: ['string', 'null'],
      enum: ['ones', 'thousands', 'millions', 'billions', null],
    },
    assumptions: {
      type: 'array',
      items: { type: 'string' },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
    historical_years: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          period_label: { type: 'string' },
          revenue: { type: ['number', 'null'] },
          gross_profit: { type: ['number', 'null'] },
          ebitda: { type: ['number', 'null'] },
          source_page: { type: ['integer', 'null'] },
          confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
          notes: { type: ['string', 'null'] },
        },
        required: ['period_label', 'revenue', 'gross_profit', 'ebitda', 'source_page', 'confidence', 'notes'],
      },
    },
    forecast_years: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          period_label: { type: 'string' },
          revenue: { type: ['number', 'null'] },
          gross_profit: { type: ['number', 'null'] },
          ebitda: { type: ['number', 'null'] },
          source_page: { type: ['integer', 'null'] },
          confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
          notes: { type: ['string', 'null'] },
        },
        required: ['period_label', 'revenue', 'gross_profit', 'ebitda', 'source_page', 'confidence', 'notes'],
      },
    },
  },
  required: [
    'company_name',
    'source_table_name',
    'currency',
    'units',
    'assumptions',
    'warnings',
    'historical_years',
    'forecast_years',
  ],
};

function assertApiKey() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }
  return apiKey;
}

function isPdfFile(file) {
  const filename = (file.filename || '').toLowerCase();
  const mimeType = (file.mimeType || '').toLowerCase();
  const hasPdfExtension = filename.endsWith('.pdf');
  const hasPdfMime = mimeType === 'application/pdf';
  const hasPdfSignature = file.buffer?.subarray(0, 4).toString('utf8') === '%PDF';
  return hasPdfExtension || hasPdfMime || hasPdfSignature;
}

async function loadPdfFromSource(source) {
  if (source?.buffer) {
    return source;
  }

  const downloadUrl = source?.downloadUrl || source?.blobDownloadUrl || '';
  if (!isTrustedBlobUrl(downloadUrl)) {
    throw new Error('Stored PDF URL is invalid or not trusted.');
  }

  if (!getBlob) {
    throw new Error('Private blob retrieval is not available.');
  }

  const result = await getBlob(downloadUrl, {
    access: 'private',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });

  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error(`Failed to fetch stored PDF: ${result?.statusCode || 404}`);
  }

  const reader = result.stream.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }

  return {
    filename: source?.filename || 'cim.pdf',
    mimeType: source?.mimeType || result.blob?.contentType || 'application/pdf',
    buffer: Buffer.concat(chunks),
  };
}

async function uploadGeminiFile({ apiKey, file }) {
  const startResponse = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(file.buffer.length),
      'X-Goog-Upload-Header-Content-Type': 'application/pdf',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file: {
        display_name: file.filename || 'cim.pdf',
      },
    }),
  });

  if (!startResponse.ok) {
    const body = await startResponse.text();
    throw new Error(`Gemini file upload initialization failed: ${body || startResponse.status}`);
  }

  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini file upload initialization did not return an upload URL.');
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(file.buffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: file.buffer,
  });

  if (!uploadResponse.ok) {
    const body = await uploadResponse.text();
    throw new Error(`Gemini file upload failed: ${body || uploadResponse.status}`);
  }

  const uploadJson = await uploadResponse.json();
  return uploadJson.file || uploadJson;
}

function normalizeGeminiFileName(fileName) {
  const normalized = String(fileName || '').trim();
  if (!normalized) {
    throw new Error('Gemini file upload did not return a file name.');
  }

  if (normalized.startsWith('files/')) {
    return normalized;
  }

  return `files/${normalized}`;
}

async function waitForFileActive({ apiKey, fileName }) {
  const normalizedName = normalizeGeminiFileName(fileName);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${normalizedName}`, {
      headers: {
        'x-goog-api-key': apiKey,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini file status check failed: ${body || response.status}`);
    }

    const payload = await response.json();
    const file = payload.file || payload;
    const state = (file.state || '').toUpperCase();

    if (state === 'ACTIVE' || !state) {
      return file;
    }

    if (state === 'FAILED') {
      throw new Error('Gemini file processing failed.');
    }

    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  throw new Error('Gemini file processing timed out.');
}

async function deleteGeminiFile({ apiKey, fileName }) {
  if (!fileName) return;
  const normalizedName = normalizeGeminiFileName(fileName);
  try {
    await fetch(`https://generativelanguage.googleapis.com/v1beta/${normalizedName}`, {
      method: 'DELETE',
      headers: {
        'x-goog-api-key': apiKey,
      },
    });
  } catch {
    // Cleanup should not fail the request.
  }
}

function getResponseText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts
    .map(part => part?.text || '')
    .join('')
    .trim();
}

function stripMarkdownCodeFences(value) {
  const trimmed = String(value || '').trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function sanitizeJsonCandidate(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function extractFirstJsonObject(value) {
  const text = stripMarkdownCodeFences(value);
  const start = text.indexOf('{');

  if (start === -1) {
    console.error('Gemini extraction parse failure: no JSON object found in response:', text.slice(0, 2000));
    throw new Error('Gemini returned invalid JSON.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  console.error('Gemini extraction parse failure: JSON object appears truncated:', text.slice(start, Math.min(text.length, start + 2000)));
  throw new Error('Gemini returned invalid JSON.');
}

function parseGeminiJsonResponse(responseText) {
  const candidate = extractFirstJsonObject(responseText);

  try {
    return JSON.parse(candidate);
  } catch {
    const sanitizedCandidate = sanitizeJsonCandidate(candidate);

    try {
      return JSON.parse(sanitizedCandidate);
    } catch {
      console.error('Gemini extraction parse failure:', candidate.slice(0, 1000));
      throw new Error('Gemini returned invalid JSON.');
    }
  }
}

function isNumberOrNull(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isIntegerOrNull(value) {
  return value === null || Number.isInteger(value);
}

function isConfidenceOrNull(value) {
  return value === null || (typeof value === 'number' && value >= 0 && value <= 1);
}

function ensureStringArray(value, fieldName) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${fieldName} must be an array of strings.`);
  }
}

function validatePeriodRows(rows, fieldName) {
  if (!Array.isArray(rows)) {
    throw new Error(`${fieldName} must be an array.`);
  }

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      throw new Error(`${fieldName} contains an invalid row.`);
    }

    if (!row.period_label || typeof row.period_label !== 'string') {
      throw new Error(`${fieldName} rows must include period_label.`);
    }

    if (!isNumberOrNull(row.revenue)) throw new Error(`${fieldName}.${row.period_label}.revenue must be a number or null.`);
    if (!isNumberOrNull(row.gross_profit)) throw new Error(`${fieldName}.${row.period_label}.gross_profit must be a number or null.`);
    if (!isNumberOrNull(row.ebitda)) throw new Error(`${fieldName}.${row.period_label}.ebitda must be a number or null.`);
    if (!isIntegerOrNull(row.source_page)) throw new Error(`${fieldName}.${row.period_label}.source_page must be an integer or null.`);
    if (!isConfidenceOrNull(row.confidence)) throw new Error(`${fieldName}.${row.period_label}.confidence must be between 0 and 1 or null.`);
    if (!(row.notes === null || typeof row.notes === 'string')) throw new Error(`${fieldName}.${row.period_label}.notes must be a string or null.`);
  }
}

function validateStructuredResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('Model response was not a JSON object.');
  }

  if (!(result.company_name === null || typeof result.company_name === 'string')) {
    throw new Error('company_name must be a string or null.');
  }

  if (!(result.source_table_name === null || typeof result.source_table_name === 'string')) {
    throw new Error('source_table_name must be a string or null.');
  }

  if (!(result.currency === null || typeof result.currency === 'string')) {
    throw new Error('currency must be a string or null.');
  }

  if (![null, 'ones', 'thousands', 'millions', 'billions'].includes(result.units)) {
    throw new Error('units must be one of ones, thousands, millions, billions, or null.');
  }

  ensureStringArray(result.assumptions, 'assumptions');
  ensureStringArray(result.warnings, 'warnings');
  validatePeriodRows(result.historical_years, 'historical_years');
  validatePeriodRows(result.forecast_years, 'forecast_years');
}

function normalizeRows(result) {
  const rows = [];

  for (const row of result.historical_years) {
    rows.push({
      period_label: row.period_label,
      type: 'Historical',
      revenue: row.revenue,
      gross_profit: row.gross_profit,
      ebitda: row.ebitda,
      currency: result.currency,
      units: result.units,
      source_page: row.source_page,
      confidence: row.confidence,
      notes: row.notes,
    });
  }

  for (const row of result.forecast_years) {
    rows.push({
      period_label: row.period_label,
      type: 'Forecast',
      revenue: row.revenue,
      gross_profit: row.gross_profit,
      ebitda: row.ebitda,
      currency: result.currency,
      units: result.units,
      source_page: row.source_page,
      confidence: row.confidence,
      notes: row.notes,
    });
  }

  return rows;
}

function deriveSoftWarnings(result, rows) {
  const warnings = new Set(result.warnings || []);
  const labels = new Map();
  const historicalLabels = new Set();
  const forecastLabels = new Set();
  let pagesFound = 0;

  for (const row of rows) {
    if (row.source_page !== null) {
      pagesFound += 1;
    }

    if (row.revenue !== null && row.gross_profit !== null && row.gross_profit > row.revenue) {
      warnings.add(`Gross profit exceeds revenue for ${row.period_label}.`);
    }

    if (row.revenue !== null && row.ebitda !== null && row.ebitda > row.revenue) {
      warnings.add(`EBITDA exceeds revenue for ${row.period_label}.`);
    }

    if (labels.has(row.period_label)) {
      warnings.add(`Duplicate period label detected: ${row.period_label}.`);
    }
    labels.set(row.period_label, true);

    if (row.type === 'Historical') historicalLabels.add(row.period_label);
    if (row.type === 'Forecast') forecastLabels.add(row.period_label);
  }

  for (const label of historicalLabels) {
    if (forecastLabels.has(label)) {
      warnings.add(`The same period appears in both historical and forecast: ${label}.`);
    }
  }

  if (pagesFound === 0) warnings.add('No source pages were identified.');
  if (!result.forecast_years.length) warnings.add('No forecast periods found.');
  if (!result.historical_years.length) warnings.add('No historical periods found.');

  return [...warnings];
}

async function extractCimDataFromPdf(file) {
  const normalizedFile = await loadPdfFromSource(file);

  if (!normalizedFile || !normalizedFile.buffer) {
    throw new Error('No file uploaded.');
  }

  if (!isPdfFile(normalizedFile)) {
    throw new Error('Only PDF files are supported.');
  }

  const apiKey = assertApiKey();
  let uploadedFile;

  try {
    uploadedFile = await uploadGeminiFile({ apiKey, file: normalizedFile });
    uploadedFile = await waitForFileActive({ apiKey, fileName: uploadedFile.name });

    const generationResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(EXTRACTION_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  file_data: {
                    mime_type: uploadedFile.mimeType || 'application/pdf',
                    file_uri: uploadedFile.uri,
                  },
                },
                {
                  text: EXTRACTION_PROMPT,
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: EXTRACTION_SCHEMA,
            responseJsonSchema: EXTRACTION_SCHEMA,
            maxOutputTokens: 4000,
          },
        }),
      }
    );

    if (!generationResponse.ok) {
      const body = await generationResponse.text();
      throw new Error(`Gemini extraction failed: ${body || generationResponse.status}`);
    }

    const responseJson = await generationResponse.json();
    const responseText = getResponseText(responseJson);
    if (!responseText) {
      console.error('Gemini extraction returned an empty text payload:', JSON.stringify(responseJson).slice(0, 2000));
      throw new Error('Gemini returned an empty extraction result.');
    }

    const structured = parseGeminiJsonResponse(responseText);

    validateStructuredResult(structured);
    const rows = normalizeRows(structured);
    const warnings = deriveSoftWarnings(structured, rows);

    if (!rows.length) {
      throw new Error('No financial rows could be extracted from the PDF.');
    }

    return {
      structured: {
        ...structured,
        warnings,
      },
      rows,
    };
  } finally {
    await deleteGeminiFile({ apiKey, fileName: uploadedFile?.name });
  }
}

module.exports = {
  EXTRACTION_MODEL,
  EXTRACTION_PROMPT,
  EXTRACTION_SCHEMA,
  extractCimDataFromPdf,
};
