import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { issueCimAccessToken, DEFAULT_TOKEN_LIFETIME_SECONDS } = require('../cim-access-token');

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

export default async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: 'Origin not allowed.' });
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
