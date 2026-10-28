// POST /api/convert
// Receives a drawing as a base64 data URI and starts an image-to-3D task at Meshy.
// The API key stays on the server (MESHY_API_KEY). Never expose it to the browser.

const MESHY_CREATE_URL = 'https://api.meshy.ai/openapi/v1/image-to-3d';
// Vercel serverless request bodies are limited to about 4.5 MB, so the client downscales first.
const MAX_DATA_URI_CHARS = 4 * 1024 * 1024;
const ALLOWED_PREFIX = /^data:image\/(png|jpeg|webp);base64,/;

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

  const apiKey = process.env.MESHY_API_KEY;
  if (!apiKey) return send(res, 500, { error: 'server_not_configured' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid_json' }); }
  }

  const image = body && body.image;
  if (typeof image !== 'string' || !ALLOWED_PREFIX.test(image)) {
    return send(res, 400, { error: 'unsupported_type' });
  }
  if (image.length > MAX_DATA_URI_CHARS) {
    return send(res, 413, { error: 'too_large' });
  }

  const payload = {
    image_url: image,
    ai_model: process.env.MESHY_MODEL || 'latest',
    should_texture: true,
    enable_pbr: false,
  };

  let upstream;
  try {
    upstream = await fetch(MESHY_CREATE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return send(res, 502, { error: 'generator_unreachable' });
  }

  if (!upstream.ok) {
    // Log the status only. The response body may echo request details.
    console.error('meshy create failed', upstream.status);
    return send(res, 502, { error: 'generator_rejected', status: upstream.status });
  }

  const data = await upstream.json();
  if (!data || !data.result) return send(res, 502, { error: 'generator_bad_response' });

  return send(res, 200, { id: data.result });
};
