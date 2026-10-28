// Unit tests for the serverless functions. Meshy is mocked; no network, no credits.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import convert from '../api/convert.js';
import status from '../api/status.js';

const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
const FAKE_PNG = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64');

function mockRes() {
  return {
    statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = JSON.parse(b); },
  };
}
let calls; const realFetch = globalThis.fetch;
function mockFetch(status, json) {
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status, json: async () => json }; };
}
beforeEach(() => { process.env.MESHY_API_KEY = 'test-key'; });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.MESHY_API_KEY; });

test('convert: rejects GET', async () => {
  const res = mockRes(); await convert({ method: 'GET' }, res);
  assert.equal(res.statusCode, 405);
});

test('convert: 503 when key missing, key never in response', async () => {
  delete process.env.MESHY_API_KEY;
  const res = mockRes(); await convert({ method: 'POST', body: { image: PNG } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'server_not_configured');
});

test('convert: rejects a file whose bytes do not match its declared type', async () => {
  mockFetch(200, { result: 'x' });
  const res = mockRes(); await convert({ method: 'POST', body: { image: FAKE_PNG } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('convert: rejects other MIME types and oversize bodies', async () => {
  let res = mockRes(); await convert({ method: 'POST', body: { image: 'data:image/svg+xml;base64,AAAA' } }, res);
  assert.equal(res.statusCode, 400);
  res = mockRes(); await convert({ method: 'POST', body: { image: 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024) } }, res);
  assert.equal(res.statusCode, 413);
});

test('convert: sends the documented payload and returns the id', async () => {
  mockFetch(200, { result: 'task_12345' });
  const res = mockRes(); await convert({ method: 'POST', body: JSON.stringify({ image: PNG, texture: false }) }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { id: 'task_12345' });
  assert.equal(calls[0].url, 'https://api.meshy.ai/openapi/v1/image-to-3d');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.image_url, PNG);
  assert.equal(sent.should_texture, false);
  assert.equal(sent.ai_model, 'latest');
});

test('convert: maps upstream 402 and 429', async () => {
  mockFetch(402, {}); let res = mockRes(); await convert({ method: 'POST', body: { image: PNG } }, res);
  assert.equal(res.body.error, 'no_credits');
  mockFetch(429, {}); res = mockRes(); await convert({ method: 'POST', body: { image: PNG } }, res);
  assert.equal(res.body.error, 'rate_limited');
});

test('status: validates id', async () => {
  const res = mockRes(); await status({ method: 'GET', query: { id: '../x' } }, res);
  assert.equal(res.statusCode, 400);
});

test('status: returns formats, progress, expiry', async () => {
  mockFetch(200, {
    status: 'SUCCEEDED', progress: 100, expires_at: 1900000000000, thumbnail_url: 'https://t',
    model_urls: { glb: 'https://a/m.glb', stl: 'https://a/m.stl', '3mf': 'https://a/m.3mf', mtl: 'https://a/m.mtl' },
    task_error: { message: '' },
  });
  const res = mockRes(); await status({ method: 'GET', query: { id: 'task_12345' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.modelUrls, { glb: 'https://a/m.glb', stl: 'https://a/m.stl', '3mf': 'https://a/m.3mf' });
  assert.equal(res.body.expiresAt, 1900000000000);
  assert.equal(res.body.error, null);
  assert.match(calls[0].url, /image-to-3d\/task_12345$/);
});

test('status: unknown status falls back to PENDING, progress clamped', async () => {
  mockFetch(200, { status: 'WEIRD', progress: 250 });
  const res = mockRes(); await status({ method: 'GET', query: { id: 'task_12345' } }, res);
  assert.equal(res.body.status, 'PENDING');
  assert.equal(res.body.progress, 100);
});

test('status: 404 maps to not_found', async () => {
  mockFetch(404, {});
  const res = mockRes(); await status({ method: 'GET', query: { id: 'task_12345' } }, res);
  assert.equal(res.body.error, 'not_found');
});
