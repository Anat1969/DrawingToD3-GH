// GET /api/status?id=<taskId>
// Returns the state of a Meshy image-to-3D task. Model URLs are signed and expire,
// so the browser asks again each time it opens a model instead of storing the URLs.

import { send, MESHY_BASE } from './_lib/http.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{5,80}$/;
const FORMATS = ['glb', 'stl', '3mf', 'obj', 'fbx', 'usdz'];
const STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED']);

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });

  const apiKey = process.env.MESHY_API_KEY;
  if (!apiKey) return send(res, 503, { error: 'server_not_configured' });

  const id = req.query && req.query.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return send(res, 400, { error: 'invalid_id' });

  let upstream;
  try {
    upstream = await fetch(`${MESHY_BASE}/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return send(res, 502, { error: 'generator_unreachable' });
  }

  if (upstream.status === 404) return send(res, 404, { error: 'not_found' });
  if (!upstream.ok) {
    console.error('meshy status failed', upstream.status);
    return send(res, 502, { error: 'generator_rejected', status: upstream.status });
  }

  const d = await upstream.json().catch(() => null);
  if (!d) return send(res, 502, { error: 'generator_bad_response' });

  const urls = {};
  const src = d.model_urls || {};
  for (const f of FORMATS) if (typeof src[f] === 'string' && src[f]) urls[f] = src[f];

  return send(res, 200, {
    status: STATUSES.has(d.status) ? d.status : 'PENDING',
    progress: Number.isFinite(d.progress) ? Math.max(0, Math.min(100, d.progress)) : 0,
    modelUrls: urls,
    thumbnail: typeof d.thumbnail_url === 'string' ? d.thumbnail_url : null,
    expiresAt: Number.isFinite(d.expires_at) && d.expires_at > 0 ? d.expires_at : null,
    error: (d.task_error && d.task_error.message) || null,
  });
}
