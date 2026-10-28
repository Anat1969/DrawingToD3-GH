// GET /api/status?id=<taskId>
// Returns the state of a Meshy image-to-3D task and, when finished, the GLB URL.

const MESHY_STATUS_URL = 'https://api.meshy.ai/openapi/v1/image-to-3d/';
const ID_PATTERN = /^[A-Za-z0-9_-]{5,80}$/;

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });

  const apiKey = process.env.MESHY_API_KEY;
  if (!apiKey) return send(res, 500, { error: 'server_not_configured' });

  const id = req.query && req.query.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return send(res, 400, { error: 'invalid_id' });
  }

  let upstream;
  try {
    upstream = await fetch(MESHY_STATUS_URL + encodeURIComponent(id), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return send(res, 502, { error: 'generator_unreachable' });
  }

  if (!upstream.ok) {
    console.error('meshy status failed', upstream.status);
    return send(res, 502, { error: 'generator_rejected', status: upstream.status });
  }

  const d = await upstream.json();
  return send(res, 200, {
    status: d.status || 'PENDING',
    progress: typeof d.progress === 'number' ? d.progress : 0,
    glbUrl: (d.model_urls && d.model_urls.glb) || null,
    error: (d.task_error && d.task_error.message) || null,
  });
};
