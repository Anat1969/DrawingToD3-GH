// Prepare a drawing in the browser: downscale and flatten onto white,
// so the request stays under the serverless body limit (about 4.5 MB).
export const MAX_FILE = 20 * 1024 * 1024;
export const MAX_DATA_URI = 4 * 1024 * 1024 * 0.95;
export const TYPES = /^image\/(png|jpeg|webp)$/;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('read'));
    img.src = src;
  });
}

function encode(img, maxSide, quality) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * k));
  c.height = Math.max(1, Math.round(h0 * k));
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

export async function prepareDrawing(src) {
  const img = await loadImage(src);
  let out = null;
  for (const [side, q] of [[1536, 0.9], [1280, 0.85], [1024, 0.8], [768, 0.75]]) {
    out = encode(img, side, q);
    if (out.length <= MAX_DATA_URI) break;
  }
  const thumb = encode(img, 320, 0.7);
  return { dataUrl: out, thumb };
}

export function checkFile(file) {
  if (!file) return 'no_file';
  if (!TYPES.test(file.type)) return 'unsupported_type';
  if (file.size > MAX_FILE) return 'file_too_large';
  return null;
}
