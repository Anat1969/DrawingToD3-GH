// Shared helpers for the serverless functions.

export function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

export const MESHY_BASE = 'https://api.meshy.ai/openapi/v1/image-to-3d';

// Check the real file signature, not only the declared MIME type.
export function sniffImage(base64) {
  let head;
  try {
    head = Buffer.from(base64.slice(0, 32), 'base64');
  } catch {
    return null;
  }
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
