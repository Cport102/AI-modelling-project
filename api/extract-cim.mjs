import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractCimDataFromPdf } = require('../cim-extraction');
const { parseMultipartPdf } = require('../multipart-parser');
const { deleteBlobIfPresent, isTrustedBlobUrl } = require('../blob-storage');

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data:; connect-src 'self'; font-src 'self' https://cdnjs.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const rateLimitStore = new Map();

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

function setCorsHeaders(req, res) {
  const origin = getOrigin(req);
  if (origin && isAllowedOrigin(req)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function enforceRateLimit(req, res) {
  const now = Date.now();
  const ip = getClientIp(req);
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recentHits = (rateLimitStore.get(ip) || []).filter(timestamp => timestamp > windowStart);

  if (recentHits.length >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSeconds = Math.ceil((recentHits[0] + RATE_LIMIT_WINDOW_MS - now) / 1000);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX_REQUESTS));
    res.setHeader('X-RateLimit-Remaining', '0');
    return false;
  }

  recentHits.push(now);
  rateLimitStore.set(ip, recentHits);
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX_REQUESTS));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX_REQUESTS - recentHits.length)));
  return true;
}

export default async function handler(req, res) {
  applySecurityHeaders(res);
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(req)) {
      return res.status(403).json({ error: 'Origin not allowed.' });
    }
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }

  if (!enforceRateLimit(req, res)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
  }

  let source = null;

  try {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();

    if (contentType.startsWith('application/json')) {
      const blobUrl = req.body?.blobUrl || '';
      const downloadUrl = req.body?.downloadUrl || req.body?.blobDownloadUrl || '';

      if (!blobUrl || !downloadUrl) {
        return res.status(400).json({ error: 'blobUrl and downloadUrl are required.' });
      }

      if (!isTrustedBlobUrl(blobUrl) || !isTrustedBlobUrl(downloadUrl)) {
        return res.status(400).json({ error: 'Stored PDF URL is invalid or not trusted.' });
      }

      source = {
        blobUrl,
        downloadUrl,
        filename: req.body?.filename || 'cim.pdf',
        mimeType: req.body?.mimeType || 'application/pdf',
      };
    } else {
      source = await parseMultipartPdf(req);
    }

    const result = await extractCimDataFromPdf(source);
    return res.status(200).json(result);
  } catch (error) {
    const message = error?.message || 'CIM extraction failed.';
    const statusCode =
      /No file uploaded|Only PDF files|Content-Type must be multipart|Missing multipart boundary|Uploaded file exceeds|blobUrl and downloadUrl are required|Stored PDF URL is invalid or not trusted/.test(message)
        ? 400
        : /No financial rows could be extracted|Gemini returned invalid JSON|Model response was not a JSON object/.test(message)
            ? 422
            : 500;

    return res.status(statusCode).json({ error: message });
  } finally {
    await deleteBlobIfPresent(source?.blobUrl);
  }
}
