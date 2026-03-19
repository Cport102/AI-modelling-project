import crypto from 'crypto';

const SESSION_COOKIE_NAME = 'dtgpt_session';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;

function addSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data:; connect-src 'self'; font-src 'self' https://cdnjs.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
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

function getSessionValue(password, secret) {
  return crypto.createHash('sha256').update(`${password}:${secret}`).digest('hex');
}

function useSecureCookie(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    return forwardedProto.includes('https');
  }

  return process.env.NODE_ENV === 'production';
}

export default function handler(req, res) {
  addSecurityHeaders(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }

  const configuredPassword = process.env.APP_PASSWORD || '';
  const configuredSecret = process.env.APP_SESSION_SECRET || '';

  if (!configuredPassword || !configuredSecret) {
    return res.status(500).json({ error: 'Password protection is not configured.' });
  }

  const password = req.body?.password || '';
  if (password !== configuredPassword) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const sessionValue = getSessionValue(configuredPassword, configuredSecret);
  const secureFlag = useSecureCookie(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${sessionValue}; Path=/; HttpOnly; SameSite=Strict${secureFlag}; Max-Age=${COOKIE_MAX_AGE_SECONDS}`
  );

  return res.status(200).json({ ok: true });
}
