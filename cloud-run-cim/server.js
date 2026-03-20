const http = require('http');
const { URL } = require('url');
const { parseMultipartPdf } = require('./multipart-parser');
const { extractCimDataFromPdf } = require('./extraction');
const { verifyCimAccessToken } = require('./access-token');

const PORT = Number(process.env.PORT || 8080);
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitStore = new Map();

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function getAllowedOrigins(req) {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function getOrigin(req) {
  const origin = req.headers.origin;
  return typeof origin === 'string' ? origin : '';
}

function isAllowedOrigin(req) {
  const allowedOrigins = getAllowedOrigins(req);
  if (!allowedOrigins.length) {
    return true;
  }

  const origin = getOrigin(req);
  return !!origin && allowedOrigins.includes(origin);
}

function buildCorsHeaders(req) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-CIM-Access-Token',
  };

  const origin = getOrigin(req);
  if (origin && isAllowedOrigin(req)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }

  return headers;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function enforceRateLimit(req, res, corsHeaders) {
  const now = Date.now();
  const ip = getClientIp(req);
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recentHits = (rateLimitStore.get(ip) || []).filter(timestamp => timestamp > windowStart);

  if (recentHits.length >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSeconds = Math.ceil((recentHits[0] + RATE_LIMIT_WINDOW_MS - now) / 1000);
    sendJson(
      res,
      429,
      { error: 'Rate limit exceeded. Try again later.' },
      {
        ...corsHeaders,
        'Retry-After': String(retryAfterSeconds),
        'X-RateLimit-Limit': String(RATE_LIMIT_MAX_REQUESTS),
        'X-RateLimit-Remaining': '0',
      }
    );
    return false;
  }

  recentHits.push(now);
  rateLimitStore.set(ip, recentHits);
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX_REQUESTS));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX_REQUESTS - recentHits.length)));
  return true;
}

function isAuthorized(req) {
  try {
    const verification = verifyCimAccessToken(
      req.headers['x-cim-access-token'],
      process.env.CIM_SHARED_SECRET
    );
    return verification.ok ? { ok: true } : verification;
  } catch (error) {
    return { ok: false, reason: error?.message || 'Authorization failed.' };
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const corsHeaders = buildCorsHeaders(req);

  if (requestUrl.pathname === '/health') {
    return sendJson(res, 200, { ok: true }, corsHeaders);
  }

  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(req)) {
      return sendJson(res, 403, { error: 'Origin not allowed.' }, corsHeaders);
    }
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  if (requestUrl.pathname !== '/extract-cim') {
    return sendJson(res, 404, { error: 'Not found.' }, corsHeaders);
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed.' }, corsHeaders);
  }

  if (!isAllowedOrigin(req)) {
    return sendJson(res, 403, { error: 'Origin not allowed.' }, corsHeaders);
  }

  const authorization = isAuthorized(req);
  if (!authorization.ok) {
    return sendJson(res, 401, { error: authorization.reason || 'Unauthorized.' }, corsHeaders);
  }

  if (!enforceRateLimit(req, res, corsHeaders)) {
    return;
  }

  try {
    const file = await parseMultipartPdf(req);
    const result = await extractCimDataFromPdf(file);
    return sendJson(res, 200, result, corsHeaders);
  } catch (error) {
    const message = error?.message || 'CIM extraction failed.';
    const statusCode =
      /No file uploaded|Only PDF files|Content-Type must be multipart|Missing multipart boundary|Uploaded file exceeds/.test(message)
        ? 400
        : /No financial rows could be extracted|Gemini returned invalid JSON|Model response was not a JSON object/.test(message)
          ? 422
          : 500;

    return sendJson(res, statusCode, { error: message }, corsHeaders);
  }
});

server.listen(PORT, () => {
  console.log(`Cloud Run CIM service listening on port ${PORT}`);
});
