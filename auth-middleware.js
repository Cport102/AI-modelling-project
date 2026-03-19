const SESSION_COOKIE_NAME = 'dtgpt_session';

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function computeSessionValue(password, secret) {
  const data = new TextEncoder().encode(`${password || ''}:${secret || ''}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

function getCookieValue(cookieHeader, name) {
  const cookies = (cookieHeader || '').split(';').map(cookie => cookie.trim());

  for (const cookie of cookies) {
    if (!cookie) continue;
    const [key, ...valueParts] = cookie.split('=');
    if (key === name) {
      return valueParts.join('=');
    }
  }

  return '';
}

function getSecurityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data:; connect-src 'self'; font-src 'self' https://cdnjs.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function shouldBypassAuth(pathname) {
  return (
    pathname.startsWith('/api/login') ||
    pathname.startsWith('/api/logout') ||
    pathname === '/login.html' ||
    pathname === '/favicon.ico'
  );
}

async function shouldRedirectToLogin({ pathname, cookieHeader, password, secret }) {
  if (!password || !secret || shouldBypassAuth(pathname)) {
    return false;
  }

  const expectedSession = await computeSessionValue(password, secret);
  const actualSession = getCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  return actualSession !== expectedSession;
}

function buildLoginRedirect(pathname) {
  if (!pathname || pathname === '/login.html') {
    return '/login.html';
  }

  return `/login.html?next=${encodeURIComponent(pathname)}`;
}

module.exports = {
  SESSION_COOKIE_NAME,
  buildLoginRedirect,
  computeSessionValue,
  getCookieValue,
  getSecurityHeaders,
  shouldBypassAuth,
  shouldRedirectToLogin,
};
