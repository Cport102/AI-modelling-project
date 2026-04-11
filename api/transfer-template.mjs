import fs from 'fs/promises';

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

export default async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const templateUrl = new URL('../transfer-template.xlsm', import.meta.url);
    const templateBuffer = await fs.readFile(templateUrl);

    res.setHeader('Content-Type', 'application/vnd.ms-excel.sheet.macroEnabled.12');
    res.setHeader('Content-Length', String(templateBuffer.length));
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'HEAD') {
      return res.status(200).end();
    }

    return res.status(200).send(templateBuffer);
  } catch (error) {
    console.error('Failed to load transfer-template.xlsm:', error);
    return res.status(404).json({ error: 'Could not load transfer-template.xlsm.' });
  }
}
