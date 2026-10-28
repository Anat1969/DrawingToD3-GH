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

test('wrap: loops cross the front, pass the rim and return across the back', () => {
  const W = 80, H = 60, mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (((x - 40) / 30) ** 2 + ((y - 30) / 22) ** 2 < 1) mask[y * W + x] = 1;
  const zAt = (x, y) => Math.max(0, 1 - ((x - 40) / 30) ** 2 - ((y - 30) / 22) ** 2) * 0.3;
  const toW = (x, y) => [x / 40 - 1, 1 - y / 30];
  assert.equal(wrapLoops({ mask, W, H }, zAt, toW, { wrap: 0 }).length, 0, 'no wrapping at 0');
  const loops = wrapLoops({ mask, W, H }, zAt, toW, { wrap: 0.5 });
  assert.ok(loops.length >= 25, `${loops.length} loops`);
  for (const l of loops) {
    assert.ok(l.some((p) => p[2] > 0.05) && l.some((p) => p[2] < -0.05), 'goes in front and behind');
    assert.deepEqual(l[0], l.at(-1), 'closed loop');
  }
  const angles = new Set(loops.map((l) => Math.round(Math.atan2(l[3][1] - l[0][1], l[3][0] - l[0][0]) * 4)));
  assert.ok(angles.size > 6, 'many directions, like wound yarn');
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
