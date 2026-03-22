require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { DAN_PROMPT } = require('./dan-prompt');
const { parseMultipartPdf } = require('./multipart-parser');
const { extractCimDataFromPdf } = require('./cim-extraction');
const { calculateReturns } = require('./returns-model-v2');
const { deleteBlobIfPresent, isTrustedBlobUrl } = require('./blob-storage');
const { issueCimAccessToken, DEFAULT_TOKEN_LIFETIME_SECONDS } = require('./cim-access-token');

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CIM_API_BASE_URL = process.env.CIM_API_BASE_URL || '';

if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY is not set in your .env file.');
  process.exit(1);
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const EXTRACTION_RATE_LIMIT_MAX_REQUESTS = 10;
const rateLimitStore = new Map();
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data:; connect-src 'self'; font-src 'self' https://cdnjs.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function applySecurityHeaders(res) {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(header, value);
  }
}

function getAllowedOrigins(req) {
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  const host = req.headers.host;

  if (host) {
    configured.push(`https://${host}`);
    configured.push(`http://${host}`);
  }

  configured.push('http://localhost:3000');
  return [...new Set(configured)];
}

function getOrigin(req) {
  const origin = req.headers.origin;
  return typeof origin === 'string' ? origin : '';
}

function isAllowedOrigin(req) {
  const origin = getOrigin(req);
  if (!origin) return true;
  return getAllowedOrigins(req).includes(origin);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function enforceRateLimit(req, res, maxRequests = RATE_LIMIT_MAX_REQUESTS) {
  const now = Date.now();
  const ip = getClientIp(req);
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const storeKey = `${ip}:${maxRequests}`;
  const recentHits = (rateLimitStore.get(storeKey) || []).filter(timestamp => timestamp > windowStart);

  if (recentHits.length >= maxRequests) {
    const retryAfterSeconds = Math.ceil((recentHits[0] + RATE_LIMIT_WINDOW_MS - now) / 1000);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', '0');
    sendJson(res, 429, { error: 'Rate limit exceeded. Try again later.' });
    return false;
  }

  recentHits.push(now);
  rateLimitStore.set(storeKey, recentHits);
  res.setHeader('X-RateLimit-Limit', String(maxRequests));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - recentHits.length)));
  return true;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      sendJson(res, 500, { error: 'Failed to read file' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    applySecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    });
    res.end(content);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1000000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    const statusCode = error.message === 'Invalid JSON body' ? 400 : 413;
    sendJson(res, statusCode, { error: error.message });
    return;
  }

  const { messages, model } = payload;
  if (!Array.isArray(messages) || messages.length === 0) {
    sendJson(res, 400, { error: 'messages array is required.' });
    return;
  }
  const recentMessages = messages.slice(-6);

  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { error: 'Origin not allowed.' });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || 'gemini-2.5-flash')}:streamGenerateContent?alt=sse&key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // Do not impersonate a real person; if asked, present as "in Daniel Tan's style".
          systemInstruction: {
            parts: [{ text: DAN_PROMPT }],
          },
          contents: recentMessages.map(({ role, content }) => ({
            role: role === 'assistant' ? 'model' : 'user',
            parts: [{ text: content }],
          })),
          generationConfig: {
            maxOutputTokens: 700,
          },
        }),
      }
    );
  } catch {
    sendJson(res, 502, { error: 'Could not reach Gemini API.' });
    return;
  }

  if (!upstream.ok) {
    let errBody = {};
    try { errBody = await upstream.json(); } catch {}
    sendJson(res, upstream.status, errBody);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch {
    // Client disconnects are expected while streaming.
  } finally {
    res.end();
  }
}

async function handleCimExtraction(req, res) {
  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { error: 'Origin not allowed.' });
    return;
  }

  let source = null;

  try {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();

    if (contentType.startsWith('application/json')) {
      const payload = await readJsonBody(req);
      const blobUrl = payload.blobUrl || '';
      const downloadUrl = payload.downloadUrl || payload.blobDownloadUrl || '';

      if (!blobUrl || !downloadUrl) {
        sendJson(res, 400, { error: 'blobUrl and downloadUrl are required.' });
        return;
      }

      if (!isTrustedBlobUrl(blobUrl) || !isTrustedBlobUrl(downloadUrl)) {
        sendJson(res, 400, { error: 'Stored PDF URL is invalid or not trusted.' });
        return;
      }

      source = {
        blobUrl,
        downloadUrl,
        filename: payload.filename || 'cim.pdf',
        mimeType: payload.mimeType || 'application/pdf',
      };
    } else {
      source = await parseMultipartPdf(req);
    }

    const result = await extractCimDataFromPdf(source);
    sendJson(res, 200, result);
  } catch (error) {
    const message = error?.message || 'CIM extraction failed.';
    const statusCode =
      /No file uploaded|Only PDF files|Content-Type must be multipart|Missing multipart boundary|Uploaded file exceeds|blobUrl and downloadUrl are required|Stored PDF URL is invalid or not trusted|Invalid JSON body/.test(message)
        ? 400
        : /No financial rows could be extracted|Gemini returned invalid JSON|Model response was not a JSON object/.test(message)
          ? 422
          : 500;

    sendJson(res, statusCode, { error: message });
  } finally {
    await deleteBlobIfPresent(source?.blobUrl);
  }
}

async function handleReturnsCalculation(req, res) {
  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { error: 'Origin not allowed.' });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    const statusCode = error.message === 'Invalid JSON body' ? 400 : 413;
    sendJson(res, statusCode, { error: error.message });
    return;
  }

  const extractedProfile = payload.extractedProfile || payload.profile || null;
  const assumptions = payload.assumptions || {};

  if (!extractedProfile) {
    sendJson(res, 400, { error: 'extractedProfile is required.' });
    return;
  }

  const result = calculateReturns(extractedProfile, assumptions);
  sendJson(res, result.validation.errors.length ? 422 : 200, result);
}

function handleLogin(req, res) {
  sendJson(res, 200, { ok: true, authDisabled: true });
}

function handleLogout(req, res) {
  sendJson(res, 200, { ok: true, authDisabled: true });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = requestUrl.pathname;

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/runtime-config') {
    sendJson(res, 200, {
      cimApiBaseUrl: CIM_API_BASE_URL,
    });
    return;
  }

  if (pathname === '/api/cim-access-token') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!isAllowedOrigin(req)) {
      sendJson(res, 403, { error: 'Origin not allowed.' });
      return;
    }

    try {
      const token = issueCimAccessToken({
        secret: process.env.CIM_SHARED_SECRET,
        lifetimeSeconds: DEFAULT_TOKEN_LIFETIME_SECONDS,
      });

      sendJson(res, 200, {
        token,
        expiresInSeconds: DEFAULT_TOKEN_LIFETIME_SECONDS,
      });
    } catch (error) {
      sendJson(res, 500, { error: error?.message || 'Failed to issue CIM access token.' });
    }
    return;
  }

  if (pathname === '/api/chat') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!enforceRateLimit(req, res)) {
      return;
    }

    await handleChat(req, res);
    return;
  }

  if (pathname === '/api/extract-cim') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!enforceRateLimit(req, res, EXTRACTION_RATE_LIMIT_MAX_REQUESTS)) {
      return;
    }

    await handleCimExtraction(req, res);
    return;
  }

  if (pathname === '/api/calculate-returns') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!enforceRateLimit(req, res)) {
      return;
    }

    await handleReturnsCalculation(req, res);
    return;
  }

  if (pathname === '/api/login') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    handleLogin(req, res);
    return;
  }

  if (pathname === '/api/logout') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    handleLogout(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const relativePath = pathname === '/' ? '/chatbot.html' : decodeURIComponent(pathname);
  const normalizedPath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT_DIR, normalizedPath);

  if (!filePath.startsWith(ROOT_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  sendFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`DTGPT server running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/chatbot.html in your browser.`);
});
