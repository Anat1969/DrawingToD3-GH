// GET /api/health
// Tells the browser whether conversion is available, without revealing anything about the key.
import { send } from './_lib/http.js';

export default function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  return send(res, 200, { configured: Boolean(process.env.MESHY_API_KEY) });
}
