// Line sculpture engine: strokes are found, lifted, joined into one thread, and the tube is closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractStrokes, liftStrokes, tubeMesh } from '../src/line-core.js';
import { isClosed } from '../src/sculpt-core.js';

function canvas(w, h, paint) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = paint(x, y) || [250, 248, 242];
    data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}
const INK = [20, 18, 15];
const GREEN = [120, 160, 110];

// Two separate strokes: a circle and a horizontal line, plus a green wash that is not ink.
const drawing = canvas(200, 160, (x, y) => {
  const r = Math.hypot(x - 70, y - 80);
  if (r > 38 && r < 41.5) return INK;
  if (Math.abs(y - 80) < 1.6 && x > 130 && x < 185) return INK;
  if ((x - 150) ** 2 + (y - 40) ** 2 < 15 ** 2) return GREEN;
  return null;
});

test('strokes: finds the drawn lines and ignores colour washes', () => {
  const s = extractStrokes(drawing);
  assert.ok(s.length >= 2 && s.length <= 4, `found ${s.length} strokes`);
  const xs = s.flat().map((p) => p[0]);
  assert.ok(Math.min(...xs) < 40 && Math.max(...xs) > 175, 'covers circle and line');
  assert.ok(!s.flat().some(([x, y]) => (x - 150) ** 2 + (y - 40) ** 2 < 10 ** 2), 'no stroke inside the green wash');
});

test('lift: continuous mode gives one thread that winds behind', () => {
  const s = extractStrokes(drawing);
  const toWorld = (u, v) => [u * 2 - 1, 1 - v * 2];
  const heightAt = () => 0.2;
  const paths = liftStrokes(s, { sw: 200, sh: 160 }, heightAt, toWorld, { depth: 0.5, continuous: true });
  assert.equal(paths.length, 1);
  assert.ok(paths[0].some((p) => p[2] < 0), 'connector passes behind the drawing plane');
  const apart = liftStrokes(s, { sw: 200, sh: 160 }, heightAt, toWorld, { continuous: false });
  assert.equal(apart.length, s.length);
});

test('lift: depth follows the body surface', () => {
  const s = [[[10, 10], [100, 80]]];
  const toWorld = (u, v) => [u, v];
  const p = liftStrokes(s, { sw: 200, sh: 160 }, (u) => u, toWorld, { depth: 1, continuous: false })[0];
  assert.ok(p.at(-1)[2] > p[0][2], 'deeper where the surface is higher');
});

test('tube: closed body for printing, every path capped', () => {
  const paths = [[[0, 0, 0], [0.5, 0.1, 0.2], [1, 0, 0.1], [1, 1, -0.3]], [[0, 0, 1], [0, 0.5, 1]]];
  const m = tubeMesh(paths, 0.02, 8);
  assert.ok(isClosed(m.indices));
  assert.ok(m.length > 2);
  for (const v of m.positions) assert.ok(Number.isFinite(v));
});

test('tube: full pipeline on a drawing stays closed', () => {
  const s = extractStrokes(drawing);
  const paths = liftStrokes(s, { sw: 200, sh: 160 }, () => 0.15, (u, v) => [u * 2 - 1, 1 - v * 2], { continuous: true });
  const m = tubeMesh(paths, 0.012, 8);
  assert.ok(isClosed(m.indices));
  assert.ok(m.triangles > 500);
});

test('tube: thread of strokes and thinner connectors has only finite positions', () => {
  const s = extractStrokes(drawing);
  const paths = liftStrokes(s, { sw: 200, sh: 160 }, () => 0.15, (u, v) => [u * 2 - 1, 1 - v * 2], { continuous: true });
  for (const p of paths[0]) assert.equal(p.length, 4, 'every point carries x, y, z and radius factor');
  const m = tubeMesh(paths, 0.012, 8);
  assert.ok(m.positions.every(Number.isFinite), 'no NaN in the tube');
  assert.equal(m.positions.length % 3, 0, 'positions are whole xyz triples');
  assert.ok(Math.max(...m.indices) < m.positions.length / 3, 'every index points at a real vertex');
  assert.ok(isClosed(m.indices));
});

import { wrapLoops, depthScale } from '../src/line-core.js';

test('sensitivity: a faint grey line is found only when sensitivity is high', () => {
  const faint = canvas(200, 120, (x, y) => {
    if (Math.abs(y - 40) < 1.6 && x > 20 && x < 180) return INK;          // strong line
    if (Math.abs(y - 85) < 1 && x > 20 && x < 180) return [150, 148, 144]; // faint pencil line
    return null;
  });
  const low = extractStrokes(faint, { sensitivity: 0.1 });
  const high = extractStrokes(faint, { sensitivity: 0.9 });
  const hasFaint = (s) => s.some((l) => l.every(([, y]) => Math.abs(y - 85) < 3));
  assert.ok(!hasFaint(low), 'low sensitivity ignores the faint line');
  assert.ok(hasFaint(high), 'high sensitivity finds the faint line');
});

test('wrap: a round spiral around the body, not a zigzag', () => {
  const W = 80, H = 120, mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (((x - 40) / 28) ** 2 + ((y - 60) / 52) ** 2 < 1) mask[y * W + x] = 1;
  const zAt = (x, y) => Math.max(0, 1 - ((x - 40) / 28) ** 2 - ((y - 60) / 52) ** 2) ** 0.5 * 0.4;
  const toW = (x, y) => [x / 60 - 0.66, 1 - y / 60];
  const none = wrapLoops({ mask, W, H }, zAt, toW, { wrap: 0 });
  assert.equal(none.length, 0, 'no wrapping at 0');
  const paths = wrapLoops({ mask, W, H }, zAt, toW, { wrap: 0.5 });
  assert.ok(paths.turns >= 20, `${paths.turns} turns`);
  assert.equal(paths.length, 3, 'three passes, like a ball of yarn wound from three directions');
  for (const p of paths) {
    // Goes round: front and back alternate about twice per turn.
    let flips = 0;
    for (let i = 1; i < p.length; i++) if (Math.sign(p[i][2]) !== Math.sign(p[i - 1][2]) && p[i][2] !== 0) flips++;
    assert.ok(flips >= 2 * (paths.turns / 3) - 2, `round trips (${flips} front/back changes)`);
    // Round, not zigzag: almost no sharp turns between consecutive segments.
    let sharp = 0;
    for (let i = 2; i < p.length; i++) {
      const u = [0, 1, 2].map((j) => p[i - 1][j] - p[i - 2][j]), v = [0, 1, 2].map((j) => p[i][j] - p[i - 1][j]);
      const c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v) || 1);
      if (c < 0.85) sharp++;
    }
    assert.ok(sharp / p.length < 0.02, `smooth spiral (${sharp} sharp turns of ${p.length})`);
    // Climbs: the spiral covers the length of the body.
    const ys = p.map((q) => q[1]);
    assert.ok(Math.max(...ys) - Math.min(...ys) > 1.2, 'climbs along the body');
  }
  assert.ok(depthScale(1) > depthScale(0));
});

test('wrap: strokes plus wrapping make one closed printable thread', () => {
  const W = 80, H = 60, mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (((x - 40) / 30) ** 2 + ((y - 30) / 22) ** 2 < 1) mask[y * W + x] = 1;
  const loops = wrapLoops({ mask, W, H }, () => 0.2, (x, y) => [x / 40 - 1, 1 - y / 30], { wrap: 0.3 });
  const s = extractStrokes(drawing);
  const paths = liftStrokes(s, { sw: 200, sh: 160 }, () => 0.15, (u, v) => [u * 2 - 1, 1 - v * 2], { continuous: true, extra: loops });
  assert.equal(paths.length, 1);
  const m = tubeMesh(paths, 0.01, 8);
  assert.ok(isClosed(m.indices));
  assert.equal(m.positions.length % 3, 0);
});

test('timeline: drawing the thread reveals it in order and ends with the whole tube', () => {
  const paths = [[[0, 0, 0, 1], [1, 0, 0, 1], [1, 1, 0, 0.4], [0, 1, 0, 0.4]]];
  const m = tubeMesh(paths, 0.02, 8);
  const t = m.timeline;
  assert.equal(t.end.length, 3);
  for (let i = 1; i < t.end.length; i++) { assert.ok(t.end[i] > t.end[i - 1]); assert.ok(t.time[i] > t.time[i - 1]); }
  assert.equal(t.end.at(-1), m.indices.length, 'last step shows every triangle, caps included');
  assert.ok(Math.abs(t.time[0] - 1) < 1e-6 && t.time[1] - t.time[0] < 0.5, 'drawn line is slow, thread is fast');
  assert.deepEqual(Array.from(t.tip.slice(-3)), [0, 1, 0], 'tip ends at the last point');
});

test('lift: drawn strokes come before the wrapping in the thread', () => {
  const s = [[[10, 10], [60, 10]], [[10, 60], [60, 60]]];
  const loop = [[0.5, 0.5, 0.1, 0.5], [0.6, 0.5, -0.1, 0.5], [0.5, 0.5, 0.1, 0.5]];
  const path = liftStrokes(s, { sw: 100, sh: 100 }, () => 0.1, (u, v) => [u, v], { continuous: true, extra: [loop] })[0];
  const firstWrap = path.findIndex((p) => p[3] === 0.5);
  const lastDrawn = path.map((p) => p[3]).lastIndexOf(1);
  assert.ok(firstWrap > lastDrawn, 'wrapping starts after the last drawn stroke');
});
