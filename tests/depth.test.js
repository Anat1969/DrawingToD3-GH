// One depth map for every category, joined by diffusion (Anat, 2.11.2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { diffuseDepth, photoAnchors, sculptureAnchors, luminance, sampleDepth, PHOTO_SIGMA } from '../src/depth-core.js';
import { focusMap, foregroundFromFocus } from '../src/sculpt-core.js';

function load(name, w, h) {
  const rgb = zlib.gunzipSync(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) { data.set(rgb.subarray(p * 3, p * 3 + 3), p * 4); data[p * 4 + 3] = 255; }
  return { width: w, height: h, data };
}

test('diffusion fills every pixel, flows inside a patch and stops at an edge', () => {
  const W = 60, H = 40, N = W * H;
  const guide = new Float32Array(N), t = new Float32Array(N), c = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) guide[y * W + x] = x < 30 ? 40 : 200; // two patches
  t[20 * W + 5] = 1; c[20 * W + 5] = 1;     // one near anchor in the dark patch
  t[20 * W + 55] = 0; c[20 * W + 55] = 1;   // one far anchor in the light patch
  const D = diffuseDepth(t, c, guide, W, H, { sigma: 10 });
  assert.ok(D.every(Number.isFinite), 'no holes');
  assert.ok(D[5 * W + 25] > 0.8, `the dark patch is near all over (${D[5 * W + 25].toFixed(2)})`);
  assert.ok(D[35 * W + 35] < 0.2, `the light patch is far all over (${D[35 * W + 35].toFixed(2)})`);
});

test('photograph: near and far joined by a continuous depth, with no empty gap', () => {
  const img = load('photographer-560x373.rgb.gz', 560, 373);
  const f = focusMap(img);
  const near = foregroundFromFocus(f.F, 560, 373);
  // At a working resolution (every 4th pixel) like the app.
  const w = 140, h = 93, F = new Float32Array(w * h), m = new Uint8Array(w * h), L = luminance(img), G = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = Math.min(372, y * 4) * 560 + Math.min(559, x * 4); F[y * w + x] = f.F[p]; m[y * w + x] = near[p]; G[y * w + x] = L[p]; }
  const { target, conf } = photoAnchors(F, m);
  const D = diffuseDepth(target, conf, G, w, h, { sigma: PHOTO_SIGMA });
  assert.ok(sampleDepth(D, w, h, 0.55, 0.45) > 0.9, 'the photographer is near');
  assert.ok(sampleDepth(D, w, h, 0.03, 0.08) < 0.35, 'the blurred field is far');
  // Continuous: a real share of the picture lies between near and far.
  const between = D.filter((v) => v > 0.25 && v < 0.75).length / D.length;
  assert.ok(between > 0.05, `${(between * 100).toFixed(0)}% of the picture lies between near and far`);
  // And from the subject outwards the depth falls without a jump.
  let maxStep = 0;
  for (let x = 1; x < w; x++) { const y = 20; if (m[y * w + x] || m[y * w + x - 1]) continue; maxStep = Math.max(maxStep, Math.abs(D[y * w + x] - D[y * w + x - 1])); }
  assert.ok(maxStep < 0.35, `the background has no cliff (largest step ${maxStep.toFixed(2)})`);
});

test('sculpture: the silhouette gives the body, shading gives the relief (dark is deep)', () => {
  // A lit ball on a grey ground, with a dark crease across it.
  const W = 120, H = 120, N = W * H, data = new Uint8ClampedArray(N * 4);
  const mask = new Uint8Array(N), dist = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, r = Math.hypot(x - 60, y - 60);
    let v = 120;
    if (r < 45) {
      mask[p] = 1; dist[p] = 45 - r;
      const nz = Math.sqrt(1 - (r / 45) ** 2);
      v = 60 + 170 * nz;
      if (Math.abs(y - 60) < 2 && Math.abs(x - 60) < 30) v *= 0.45; // the crease
    }
    data.set([v, v, v, 255], p * 4);
  }
  const L = luminance({ width: W, height: H, data });
  const { target, conf } = sculptureAnchors(L, mask, dist, W, H);
  const D = diffuseDepth(target, conf, L, W, H, { sigma: 30 });
  const at = (x, y) => D[y * W + x];
  assert.ok(at(60, 40) > at(60, 18) + 0.1, 'the middle of the ball is nearer than its rim');
  assert.ok(at(10, 10) < 0.1, 'the ground behind is far');
  assert.ok(at(60, 60) < at(60, 50) - 0.02, `the crease sits deeper than the skin next to it (${at(60, 60).toFixed(2)} vs ${at(60, 50).toFixed(2)})`);
});

test('contour lines draw the relief: rings round a dome, more where it is steep', async () => {
  const { isolines } = await import('../src/depth-core.js');
  const W = 80, H = 80, D = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) D[y * W + x] = Math.max(0, 1 - Math.hypot(x - 40, y - 40) / 30);
  const lines = isolines(D, W, H, [0.25, 0.5, 0.75]);
  assert.equal(lines.length, 3, 'one closed ring per level');
  for (const [i, l] of lines.entries()) {
    const r = l.reduce((a, [x, y]) => a + Math.hypot(x - 40, y - 40), 0) / l.length;
    assert.ok(Math.abs(r - 30 * (1 - [0.25, 0.5, 0.75][i])) < 1, `ring ${i} at radius ${r.toFixed(1)}`);
    assert.ok(Math.hypot(l[0][0] - l.at(-1)[0], l[0][1] - l.at(-1)[1]) < 1.5, 'the ring closes');
  }
});
