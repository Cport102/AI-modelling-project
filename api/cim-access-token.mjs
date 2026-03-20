import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { issueCimAccessToken, DEFAULT_TOKEN_LIFETIME_SECONDS } = require('../cim-access-token');

const SESSION_COOKIE_NAME = 'dtgpt_session';
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data:; connect-src 'self'; font-src 'self' https://cdnjs.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

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

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return true;
  return getAllowedOrigins(req).includes(origin);
}

function getCookieValue(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = cookieHeader.split(';').map(cookie => cookie.trim());

  for (const cookie of cookies) {
    if (!cookie) continue;
    const [key, ...valueParts] = cookie.split('=');
    if (key === name) {
      return valueParts.join('=');
    }
  }

  return '';
}

async function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function getExpectedSessionValue() {
  const password = process.env.APP_PASSWORD || '';
  const secret = process.env.APP_SESSION_SECRET || '';
  if (!password || !secret) return '';

  const data = new TextEncoder().encode(`${password}:${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

async function isAuthenticated(req) {
  const expected = await getExpectedSessionValue();
  if (!expected) return true;
  return getCookieValue(req, SESSION_COOKIE_NAME) === expected;
}

export default async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }

  if (!(await isAuthenticated(req))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const token = issueCimAccessToken({
      secret: process.env.CIM_SHARED_SECRET,
      lifetimeSeconds: DEFAULT_TOKEN_LIFETIME_SECONDS,
    });

    return res.status(200).json({
      token,
      expiresInSeconds: DEFAULT_TOKEN_LIFETIME_SECONDS,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to issue CIM access token.' });
  }
}
