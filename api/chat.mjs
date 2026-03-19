import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DAN_PROMPT } = require('../dan-prompt');
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

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitStore = new Map();

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
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(req)) {
      return res.status(403).json({ error: 'Origin not allowed.' });
    }
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }

  if (!(await isAuthenticated(req))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  if (!enforceRateLimit(req, res)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
  }

  const { messages, model } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }
  const recentMessages = messages.slice(-6);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY' });
  }

  let upstream;
  try {
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || 'gemini-2.5-flash')}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
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
    return res.status(502).json({ error: 'Could not reach Gemini API.' });
  }

  if (!upstream.ok) {
    let errBody = {};
    try { errBody = await upstream.json(); } catch {}
    return res.status(upstream.status).json(errBody);
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch {
    // Client disconnects are expected during streamed responses.
  } finally {
    res.end();
  }
}
