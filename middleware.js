import { NextResponse } from 'next/server';

const SESSION_COOKIE_NAME = 'dtgpt_session';

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function computeSessionValue() {
  const password = process.env.APP_PASSWORD || '';
  const secret = process.env.APP_SESSION_SECRET || '';
  const data = new TextEncoder().encode(`${password}:${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

function getCookieValue(request, name) {
  const cookieHeader = request.headers.get('cookie') || '';
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

function addSecurityHeaders(response) {
  response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data:; connect-src 'self'; font-src 'self' https://cdnjs.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
}

function redirectToLogin(request) {
  const loginUrl = new URL('/login.html', request.url);
  if (request.nextUrl.pathname !== '/login.html') {
    loginUrl.searchParams.set('next', request.nextUrl.pathname);
  }

  return addSecurityHeaders(NextResponse.redirect(loginUrl, 302));
}

export default async function middleware(request) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith('/api/login') ||
    pathname.startsWith('/api/logout') ||
    pathname === '/login.html' ||
    pathname === '/favicon.ico'
  ) {
    return addSecurityHeaders(NextResponse.next());
  }

  const configuredPassword = process.env.APP_PASSWORD || '';
  const configuredSecret = process.env.APP_SESSION_SECRET || '';
  if (!configuredPassword || !configuredSecret) {
    return addSecurityHeaders(NextResponse.next());
  }

  const expectedSession = await computeSessionValue();
  const actualSession = getCookieValue(request, SESSION_COOKIE_NAME);

  if (actualSession !== expectedSession) {
    return redirectToLogin(request);
  }

  return addSecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: ['/((?!_vercel).*)'],
};
