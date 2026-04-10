const EXTRACTION_MODEL = process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-flash';
const EXTRACTION_MODEL_FALLBACKS = (process.env.GEMINI_EXTRACTION_MODEL_FALLBACKS || 'gemini-2.5-flash-lite')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

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

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('Invalid extraction schema definition.');
  }

  const geminiSchema = {};
  const rawType = schema.type;
  const typeList = Array.isArray(rawType) ? rawType : rawType ? [rawType] : [];
  const nonNullTypes = typeList.filter((value) => value !== 'null');

  if (nonNullTypes.length > 1) {
    throw new Error(`Gemini schema does not support multiple non-null types: ${nonNullTypes.join(', ')}`);
  }

  const primaryType = nonNullTypes[0];
  if (primaryType) {
    geminiSchema.type = primaryType.toUpperCase();
  }

  if (typeList.includes('null')) {
    geminiSchema.nullable = true;
  }

  if (schema.enum) {
    geminiSchema.enum = schema.enum.filter((value) => value !== null);
  }

  if (typeof schema.minimum === 'number') {
    geminiSchema.minimum = schema.minimum;
  }

  if (typeof schema.maximum === 'number') {
    geminiSchema.maximum = schema.maximum;
  }

  if (schema.properties && typeof schema.properties === 'object') {
    geminiSchema.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)])
    );
  }

  if (Array.isArray(schema.required)) {
    geminiSchema.required = schema.required;
  }

  if (schema.items) {
    geminiSchema.items = toGeminiSchema(schema.items);
  }

  return geminiSchema;
}

const GEMINI_EXTRACTION_SCHEMA = toGeminiSchema(EXTRACTION_SCHEMA);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterSeconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  const retryDate = Date.parse(value);
  if (Number.isNaN(retryDate)) return null;
  return Math.max(0, Math.ceil((retryDate - Date.now()) / 1000));
}

async function requestExtractionWithRetries({ apiKey, uploadedFile }) {
  const models = [EXTRACTION_MODEL, ...EXTRACTION_MODEL_FALLBACKS.filter((model) => model !== EXTRACTION_MODEL)];
  let lastTemporaryError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const generationResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
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
              responseSchema: GEMINI_EXTRACTION_SCHEMA,
              maxOutputTokens: 4000,
            },
          }),
        }
      );

      if (generationResponse.ok) {
        return generationResponse;
      }

      const body = await generationResponse.text();
      const isTemporary = generationResponse.status === 503 || generationResponse.status === 429;

      if (!isTemporary) {
        throw new Error(`Gemini extraction failed: ${body || generationResponse.status}`);
      }

      lastTemporaryError = body || String(generationResponse.status);
      const retryAfterSeconds = parseRetryAfterSeconds(generationResponse.headers.get('retry-after'));

      if (attempt < 3) {
        const backoffMs = retryAfterSeconds
          ? retryAfterSeconds * 1000
          : Math.min(1500 * 2 ** (attempt - 1), 6000);
        await sleep(backoffMs);
      }
    }
  }

  throw new Error(
    `Gemini extraction is temporarily unavailable due to provider load. Please retry in a minute.${lastTemporaryError ? ` Last provider response: ${lastTemporaryError}` : ''}`
  );
}

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
  const textParts = [];

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;

    if (typeof part.text === 'string' && part.text.trim()) {
      textParts.push(part.text.trim());
      continue;
    }

    if (part.functionCall?.args && typeof part.functionCall.args === 'object') {
      textParts.push(JSON.stringify(part.functionCall.args));
      continue;
    }

    if (part.inlineData?.mimeType === 'application/json' && typeof part.inlineData.data === 'string') {
      try {
        textParts.push(Buffer.from(part.inlineData.data, 'base64').toString('utf8'));
        continue;
      } catch {
        // Ignore undecodable inline JSON data and continue scanning.
      }
    }

    for (const value of Object.values(part)) {
      if (typeof value === 'string' && /[{[]/.test(value)) {
        textParts.push(value.trim());
        break;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.some((key) => EXTRACTION_SCHEMA.required.includes(key))) {
          textParts.push(JSON.stringify(value));
          break;
        }
      }
    }
  }

  return textParts.join('\n').trim();
}

function findStructuredResultInValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (!Array.isArray(value)) {
    const keys = Object.keys(value);
    const schemaKeyCount = EXTRACTION_SCHEMA.required.filter((key) => keys.includes(key)).length;
    const hasPeriodArrays = Array.isArray(value.historical_years) || Array.isArray(value.forecast_years);

    if (schemaKeyCount >= 3 || hasPeriodArrays) {
      return coerceStructuredResultShape(value);
    }
  }

  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const match = findStructuredResultInValue(child, seen);
    if (match) {
      return match;
    }
  }

  return null;
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

function closeOpenJsonStructures(value) {
  const text = String(value || '');
  let inString = false;
  let escaped = false;
  const stack = [];

  for (let i = 0; i < text.length; i += 1) {
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

    if (char === '{') stack.push('}');
    if (char === '[') stack.push(']');
    if ((char === '}' || char === ']') && stack.length && stack[stack.length - 1] === char) {
      stack.pop();
    }
  }

  return text + stack.reverse().join('');
}

function repairTruncatedJsonCandidate(value) {
  let text = String(value || '').trimEnd();
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
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
    }
  }

  if (escaped) {
    text = text.slice(0, -1);
  }

  if (inString) {
    text += '"';
  }

  text = text.replace(/[,:]\s*$/, '');
  return closeOpenJsonStructures(text);
}

function coerceStructuredResultShape(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }

  return {
    company_name: result.company_name ?? null,
    source_table_name: result.source_table_name ?? null,
    currency: result.currency ?? null,
    units: result.units ?? null,
    assumptions: Array.isArray(result.assumptions) ? result.assumptions : [],
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    historical_years: Array.isArray(result.historical_years) ? result.historical_years : [],
    forecast_years: Array.isArray(result.forecast_years) ? result.forecast_years : [],
  };
}

function normalizeJsonLikeCandidate(value) {
  let text = sanitizeJsonCandidate(value)
    .replace(/^\s*json\s*/i, '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/\/\/[^\n\r]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const unwrapped = JSON.parse(text);
      if (typeof unwrapped === 'string') {
        text = sanitizeJsonCandidate(unwrapped);
      }
    } catch {
      // Keep the original candidate if it was not a JSON string wrapper.
    }
  }

  text = text
    .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, group) => `: "${group.replace(/"/g, '\\"')}"`);

  return text;
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

  const truncatedCandidate = text.slice(start);
  console.warn('Gemini extraction parse warning: JSON object appears truncated, attempting repair:', truncatedCandidate.slice(0, 2000));
  return repairTruncatedJsonCandidate(truncatedCandidate);
}

function parseGeminiJsonResponse(responseText) {
  const candidate = extractFirstJsonObject(responseText);

  try {
    return coerceStructuredResultShape(JSON.parse(candidate));
  } catch {
    const sanitizedCandidate = normalizeJsonLikeCandidate(candidate).replace(/```json|```/gi, '');

    try {
      return coerceStructuredResultShape(JSON.parse(sanitizedCandidate));
    } catch {
      const repairedCandidate = repairTruncatedJsonCandidate(sanitizedCandidate);

      try {
        return coerceStructuredResultShape(JSON.parse(repairedCandidate));
      } catch {
        console.error('Gemini extraction parse failure:', candidate.slice(0, 1000));
        throw new Error('Gemini returned invalid JSON.');
      }
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
  if (!file || !file.buffer) {
    throw new Error('No file uploaded.');
  }

  if (!isPdfFile(file)) {
    throw new Error('Only PDF files are supported.');
  }

  const apiKey = assertApiKey();
  let uploadedFile;

  try {
    uploadedFile = await uploadGeminiFile({ apiKey, file });
    uploadedFile = await waitForFileActive({ apiKey, fileName: uploadedFile.name });

    const generationResponse = await requestExtractionWithRetries({ apiKey, uploadedFile });

    const responseJson = await generationResponse.json();
    const structuredFromPayload = findStructuredResultInValue(responseJson);
    const responseText = getResponseText(responseJson);

    if (!structuredFromPayload && !responseText) {
      console.error('Gemini extraction returned no parseable content:', JSON.stringify(responseJson).slice(0, 2000));
      throw new Error('Gemini returned an empty extraction result.');
    }

    const structured = structuredFromPayload || parseGeminiJsonResponse(responseText);
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
  extractCimDataFromPdf,
};
