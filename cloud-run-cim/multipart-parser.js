const MAX_PDF_BYTES = 50 * 1024 * 1024;

function getBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  return match?.[1] || match?.[2] || '';
}

function trimTrailingCrlf(buffer) {
  if (buffer.length >= 2 && buffer[buffer.length - 2] === 13 && buffer[buffer.length - 1] === 10) {
    return buffer.subarray(0, buffer.length - 2);
  }
  return buffer;
}

async function readRequestBuffer(req, maxBytes = MAX_PDF_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error('Uploaded file exceeds the 50MB PDF limit.'));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartBuffer(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const segments = [];
  let start = 0;

  while (start < buffer.length) {
    const boundaryIndex = buffer.indexOf(boundaryBuffer, start);
    if (boundaryIndex === -1) break;

    const segmentStart = boundaryIndex + boundaryBuffer.length;
    const nextBoundaryIndex = buffer.indexOf(boundaryBuffer, segmentStart);
    if (nextBoundaryIndex === -1) break;

    const segment = buffer.subarray(segmentStart, nextBoundaryIndex);
    segments.push(segment);
    start = nextBoundaryIndex;
  }

  return segments;
}

function parsePartHeaders(headerBlock) {
  const headers = {};
  for (const line of headerBlock.split('\r\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[key] = value;
  }
  return headers;
}

function parseContentDisposition(value) {
  return {
    name: /name="([^"]+)"/i.exec(value || '')?.[1] || '',
    filename: /filename="([^"]*)"/i.exec(value || '')?.[1] || '',
  };
}

async function parseMultipartPdf(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new Error('Content-Type must be multipart/form-data.');
  }

  const boundary = getBoundary(contentType);
  if (!boundary) {
    throw new Error('Missing multipart boundary.');
  }

  const buffer = await readRequestBuffer(req);
  const parts = parseMultipartBuffer(buffer, boundary);

  for (const rawPart of parts) {
    const part = rawPart.subarray(rawPart.indexOf('\r\n') === 0 ? 2 : 0);
    const headerEndIndex = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEndIndex === -1) continue;

    const headerBlock = part.subarray(0, headerEndIndex).toString('utf8');
    const headers = parsePartHeaders(headerBlock);
    const disposition = parseContentDisposition(headers['content-disposition']);

    if (disposition.name !== 'file') continue;

    const fileBuffer = trimTrailingCrlf(part.subarray(headerEndIndex + 4));
    const mimeType = headers['content-type'] || 'application/octet-stream';
    const filename = disposition.filename || 'upload.pdf';

    return {
      buffer: fileBuffer,
      filename,
      mimeType,
    };
  }

  throw new Error('No file uploaded.');
}

module.exports = {
  MAX_PDF_BYTES,
  parseMultipartPdf,
};
