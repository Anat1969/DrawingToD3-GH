// POST /api/convert
// Body: { image: "data:image/<png|jpeg|webp>;base64,...", texture?: boolean }
// Starts a Meshy image-to-3D task and returns { id }.
// The API key stays on the server (MESHY_API_KEY). It is never sent to the browser.
// Meshy reference: https://docs.meshy.ai/en/api/image-to-3d (checked 2026-10-28).

import { send, sniffImage, MESHY_BASE } from './_lib/http.js';

// Vercel limits request bodies to about 4.5 MB, so the browser downscales first.
export const MAX_DATA_URI_CHARS = 4 * 1024 * 1024;
const DATA_URI = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

  const apiKey = process.env.MESHY_API_KEY;
  if (!apiKey) return send(res, 503, { error: 'server_not_configured' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid_json' }); }
  }

  const image = body && body.image;
  if (typeof image !== 'string') return send(res, 400, { error: 'unsupported_type' });
  if (image.length > MAX_DATA_URI_CHARS) return send(res, 413, { error: 'too_large' });

  const m = DATA_URI.exec(image);
  if (!m) return send(res, 400, { error: 'unsupported_type' });
  const sniffed = sniffImage(m[2]);
  if (!sniffed || sniffed !== m[1]) return send(res, 400, { error: 'unsupported_type' });

  const texture = body.texture !== false;
  const payload = {
    image_url: image,
    ai_model: process.env.MESHY_MODEL || 'latest',
    should_texture: texture,
    enable_pbr: false,
  };

  let upstream;
  try {
    upstream = await fetch(MESHY_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return send(res, 502, { error: 'generator_unreachable' });
  }

  if (upstream.status === 402) return send(res, 402, { error: 'no_credits' });
  if (upstream.status === 429) return send(res, 429, { error: 'rate_limited' });
  if (!upstream.ok) {
    // Log the status only. The response body may echo request details.
    console.error('meshy create failed', upstream.status);
    return send(res, 502, { error: 'generator_rejected', status: upstream.status });
  }

  const data = await upstream.json().catch(() => null);
  if (!data || typeof data.result !== 'string') return send(res, 502, { error: 'generator_bad_response' });

  return send(res, 200, { id: data.result });
}
