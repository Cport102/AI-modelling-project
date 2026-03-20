const crypto = require('crypto');

const TOKEN_SCOPE = 'extract-cim';

function base64urlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64urlDecode(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function getSigningKey(secret) {
  if (!secret) {
    throw new Error('CIM_SHARED_SECRET is not configured.');
  }

  return crypto.createHash('sha256').update(secret).digest();
}

function signTokenBody(body, secret) {
  return base64urlEncode(
    crypto.createHmac('sha256', getSigningKey(secret)).update(body).digest()
  );
}

function verifyCimAccessToken(token, secret) {
  const [encodedPayload, signature] = String(token || '').split('.');
  if (!encodedPayload || !signature) {
    return { ok: false, reason: 'Malformed token.' };
  }

  const expectedSignature = signTokenBody(encodedPayload, secret);
  const providedSignature = Buffer.from(signature);
  const actualSignature = Buffer.from(expectedSignature);

  if (
    providedSignature.length !== actualSignature.length ||
    !crypto.timingSafeEqual(providedSignature, actualSignature)
  ) {
    return { ok: false, reason: 'Invalid token signature.' };
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload));
  } catch {
    return { ok: false, reason: 'Invalid token payload.' };
  }

  if (payload.scope !== TOKEN_SCOPE) {
    return { ok: false, reason: 'Invalid token scope.' };
  }

  if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'Token has expired.' };
  }

  return { ok: true, payload };
}

module.exports = {
  verifyCimAccessToken,
};
