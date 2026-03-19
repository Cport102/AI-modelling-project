require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const APP_SESSION_SECRET = process.env.APP_SESSION_SECRET || '';
const SESSION_COOKIE_NAME = 'dtgpt_session';
const DAN_PROMPT = `You are an assistant writing in Dan Tan’s style: direct, concise, commercially focused, mildly contrarian and lightly wry. Lead with a single-line judgement or thesis, follow with 1–3 short analytic bullets that expose assumptions or data needed, and finish with a one-line, concrete next step that names who/what/time/metric.

Do:
- Use 1–6 short sentences; prefer terse plain language.
- Reason from first principles and expose core assumptions.
- Inject occasional dry understatement to signal confidence.
- Speak as though you are Dan Tan 

Do not:
- Don’t use corporate fluff, vague hedging, or long speculative essays.
- Don’t invent private facts or personal gossip.
- Don’t exceed one pointed follow-up question per reply.

If asked for longer analysis: give a 1–2 sentence executive summary, a 3-bullet evidence checklist, and a 3-point action plan.`;

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

function getSessionValue() {
  if (!APP_PASSWORD || !APP_SESSION_SECRET) {
    return '';
  }

  return crypto.createHash('sha256').update(`${APP_PASSWORD}:${APP_SESSION_SECRET}`).digest('hex');
}

function isAuthenticated(req) {
  const sessionValue = getSessionValue();
  if (!sessionValue) return true;
  return getCookieValue(req, SESSION_COOKIE_NAME) === sessionValue;
}

function useSecureCookie(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    return forwardedProto.includes('https');
  }

  const host = req.headers.host || '';
  return !host.startsWith('localhost');
}

function setSessionCookie(req, res, value, maxAgeSeconds) {
  const secureFlag = useSecureCookie(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict${secureFlag}; Max-Age=${maxAgeSeconds}`
  );
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
    sendJson(res, 429, { error: 'Rate limit exceeded. Try again later.' });
    return false;
  }

  recentHits.push(now);
  rateLimitStore.set(ip, recentHits);
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX_REQUESTS));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX_REQUESTS - recentHits.length)));
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

function handleLogin(req, res) {
  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { error: 'Origin not allowed.' });
    return;
  }

  readJsonBody(req)
    .then(payload => {
      if (!APP_PASSWORD || !APP_SESSION_SECRET) {
        sendJson(res, 500, { error: 'Password protection is not configured.' });
        return;
      }

      if ((payload.password || '') !== APP_PASSWORD) {
        sendJson(res, 401, { error: 'Incorrect password.' });
        return;
      }

      setSessionCookie(req, res, getSessionValue(), 60 * 60 * 12);
      sendJson(res, 200, { ok: true });
    })
    .catch(error => {
      const statusCode = error.message === 'Invalid JSON body' ? 400 : 413;
      sendJson(res, statusCode, { error: error.message });
    });
}

function handleLogout(req, res) {
  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { error: 'Origin not allowed.' });
    return;
  }

  setSessionCookie(req, res, '', 0);
  sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = requestUrl.pathname;

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/chat') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!isAuthenticated(req)) {
      sendJson(res, 401, { error: 'Authentication required.' });
      return;
    }

    if (!enforceRateLimit(req, res)) {
      return;
    }

    await handleChat(req, res);
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

  if (APP_PASSWORD && APP_SESSION_SECRET && pathname !== '/login.html' && !isAuthenticated(req)) {
    applySecurityHeaders(res);
    res.writeHead(302, { Location: '/login.html' });
    res.end();
    return;
  }

  const relativePath = pathname === '/' ? '/chatbot.html' : pathname;
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
