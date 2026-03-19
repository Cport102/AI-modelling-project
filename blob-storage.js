const MAX_CIM_UPLOAD_BYTES = 100 * 1024 * 1024;
const TRUSTED_BLOB_HOST_SUFFIX = 'vercel-storage.com';

let delBlob = null;

try {
  ({ del: delBlob } = require('@vercel/blob'));
} catch {
  delBlob = null;
}

function isTrustedBlobUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith(TRUSTED_BLOB_HOST_SUFFIX);
  } catch {
    return false;
  }
}

async function deleteBlobIfPresent(blobUrl) {
  if (!blobUrl || !delBlob || !process.env.BLOB_READ_WRITE_TOKEN || !isTrustedBlobUrl(blobUrl)) {
    return;
  }

  try {
    await delBlob(blobUrl);
  } catch {
    // Blob cleanup is best-effort.
  }
}

module.exports = {
  MAX_CIM_UPLOAD_BYTES,
  deleteBlobIfPresent,
  isTrustedBlobUrl,
};
