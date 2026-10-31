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
  const surface = 0.2 * 1.125; // heightAt x depth scale at depth 0.5
  assert.ok(paths[0].some((p) => p[2] < surface * 0.6), 'long connector passes through the volume, below the surface');
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

test('wrap: freehand pen through the volume, following each part of the figure', () => {
  // Two parts: a tall body and a round head joined by a neck, like a figure.
  const W = 100, H = 160, mask = new Uint8Array(W * H);
  const body = (x, y) => ((x - 50) / 26) ** 2 + ((y - 105) / 48) ** 2 < 1;
  const head = (x, y) => ((x - 50) / 17) ** 2 + ((y - 35) / 17) ** 2 < 1;
  const neck = (x, y) => Math.abs(x - 50) < 6 && y > 45 && y < 62;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (body(x, y) || head(x, y) || neck(x, y)) mask[y * W + x] = 1;
  const surf = (x, y) => (mask[Math.round(y) * W + Math.round(x)] ? 0.3 : 0);
  const toW = (x, y) => [x / 80 - 0.6, 1 - y / 80];
  assert.equal(wrapLoops({ mask, W, H }, surf, toW, { wrap: 0 }).length, 0, 'no wrapping at 0');
  const out = wrapLoops({ mask, W, H }, surf, toW, { wrap: 0.5 });
  assert.equal(out.length, 1, 'one continuous gesture');
  assert.ok(out.turns >= 20);
  const p = out[0];
  // One line: same weight as the drawn strokes (same colour and thickness).
  assert.ok(p.every((q) => q[3] === 1), 'same line as the drawing');
  // Goes round: in front of and behind the drawing plane.
  assert.ok(p.some((q) => q[2] > 0.15) && p.some((q) => q[2] < -0.15), 'in front and behind');
  // Through the volume: a real share of the line is well inside the surface depth.
  const insideShare = p.filter((q) => Math.abs(q[2]) < 0.3 * 0.55 && Math.abs(q[2]) > 0.02).length / p.length;
  assert.ok(insideShare > 0.15, `passes through the volume (${(insideShare * 100).toFixed(0)}% inside)`);
  // Freehand, not circles: the swing across the part varies from turn to turn.
  const swings = [];
  let lo = Infinity, hi = -Infinity, prev = Math.sign(p[0][2]);
  for (const q of p) { lo = Math.min(lo, q[0]); hi = Math.max(hi, q[0]); const sg = Math.sign(q[2]); if (sg && sg !== prev) { swings.push(hi - lo); lo = Infinity; hi = -Infinity; prev = sg; } }
  const mean = swings.reduce((a, b) => a + b, 0) / swings.length;
  const sd = Math.sqrt(swings.reduce((a, b) => a + (b - mean) ** 2, 0) / swings.length);
  assert.ok(sd / mean > 0.12, `varies like a hand (spread ${(100 * sd / mean).toFixed(0)}%)`);
  // Smooth: no zigzag.
  let sharp = 0;
  for (let i = 2; i < p.length; i++) {
    const u = [0, 1, 2].map((j) => p[i - 1][j] - p[i - 2][j]), v = [0, 1, 2].map((j) => p[i][j] - p[i - 1][j]);
    const c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v) || 1);
    if (c < 0.7) sharp++;
  }
  assert.ok(sharp / p.length < 0.03, `smooth gesture (${sharp} sharp turns of ${p.length})`);
  // Understands the parts: the pen visits both the head and the body.
  const ys = p.map((q) => (1 - q[1]) * 80);
  assert.ok(ys.some((y) => y < 45) && ys.some((y) => y > 110), 'winds around the head and the body');
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

test('stitch: the wrap binds the outline like a whip stitch and leaves the inside clear', async () => {
  const { stitchLoops } = await import('../src/line-core.js');
  // A figure: a head on a body, as in the wrap test above.
  const W = 100, H = 160, mask = new Uint8Array(W * H);
  const body = (x, y) => ((x - 50) / 26) ** 2 + ((y - 105) / 48) ** 2 < 1;
  const head = (x, y) => ((x - 50) / 17) ** 2 + ((y - 35) / 17) ** 2 < 1;
  const neck = (x, y) => Math.abs(x - 50) < 6 && y > 45 && y < 62;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (body(x, y) || head(x, y) || neck(x, y)) mask[y * W + x] = 1;
  const surf = (x, y) => (mask[Math.round(y) * W + Math.round(x)] ? 0.3 : 0);
  const toW = (x, y) => [x / 80 - 0.6, 1 - y / 80];
  assert.equal(stitchLoops({ mask, W, H }, surf, toW, { wrap: 0 }).length, 0, 'no wrapping at 0');
  const out = stitchLoops({ mask, W, H }, surf, toW, { wrap: 0.45 });
  assert.equal(out.length, 1, 'one outline, one gesture');
  assert.ok(out.turns >= 12, `${out.turns} stitches`);
  const p = out[0];
  assert.ok(p.every((q) => q[3] === 1), 'same line as the drawing');
  assert.ok(p.some((q) => q[2] > 0.15) && p.some((q) => q[2] < -0.15), 'binds front and back');
  // Seen from the front it stays by the outline: the face (the middle of the head) stays clear.
  const px = (q) => [(q[0] + 0.6) * 80, (1 - q[1]) * 80];
  const inFace = p.filter((q) => { const [x, y] = px(q); return Math.hypot(x - 50, y - 35) < 9; }).length;
  assert.equal(inFace, 0, 'never crosses the face');
  const nearEdge = p.filter((q) => { const [x, y] = px(q); const xi = Math.round(x), yi = Math.round(y); let d = 99; for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) { const a = mask[(yi + dy) * W + xi + dx] || 0; if (!a && Math.hypot(dx, dy) < d) d = Math.hypot(dx, dy); } return d <= 12; }).length;
  assert.ok(nearEdge / p.length > 0.97, `stays by the outline (${(100 * nearEdge / p.length).toFixed(0)}%)`);
  // Through the body: part of each stitch passes inside, between front and back.
  const through = p.filter((q) => Math.abs(q[2]) < 0.1 && mask[Math.round(px(q)[1]) * W + Math.round(px(q)[0])]).length / p.length;
  assert.ok(through > 0.04, `passes through the body (${(through * 100).toFixed(0)}%)`);
  // Visits every part of the outline: head and body.
  const ys = p.map((q) => px(q)[1]);
  assert.ok(ys.some((y) => y < 25) && ys.some((y) => y > 140), 'round the head and the body');
  // Freehand: the stitch length varies, and the gesture is smooth.
  let sharp = 0;
  for (let i = 2; i < p.length; i++) {
    const u = [0, 1, 2].map((j) => p[i - 1][j] - p[i - 2][j]), v = [0, 1, 2].map((j) => p[i][j] - p[i - 1][j]);
    if ((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v) || 1) < 0.7) sharp++;
  }
  assert.ok(sharp / p.length < 0.03, `smooth (${sharp} sharp of ${p.length})`);
  const pos = []; // where each stitch comes out in front
  p.forEach((q, i) => { if (i && p[i - 1][2] <= 0 && q[2] > 0) { pos.push(px(q)); } });
  const gaps = pos.slice(1).map((q, i) => Math.hypot(q[0] - pos[i][0], q[1] - pos[i][1]));
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  assert.ok(sd / mean > 0.12, `stitch length varies like a hand (${(100 * sd / mean).toFixed(0)}%)`);
});

test('colour: the thread takes the wash it passes through, keeps the ink on paper and on eyes, and passes smoothly', async () => {
  const { threadColours, tubeMesh: tube } = await import('../src/line-core.js');
  // Left half pink wash, right half bare paper, and a small dark "eye" inside the pink.
  const W = 100, H = 60, data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const c = x < 50 ? [225, 40, 120] : [248, 246, 240];
    data.set([...c, 255], i);
  }
  const marks = new Uint8Array(W * H);
  for (let y = 28; y < 32; y++) for (let x = 20; x < 24; x++) marks[y * W + x] = 1;
  const col = threadColours({ width: W, height: H, data }, marks);
  const pink = col(0.15, 0.2), paper = col(0.9, 0.5), eye = col(0.22, 0.5);
  assert.ok(pink[0] > pink[1] + 0.25 && pink[0] > 0.4, `over the wash the thread is pink (${pink.map((v) => v.toFixed(2))})`);
  assert.ok(Math.max(...paper) < 0.15, 'over bare paper it keeps the ink');
  assert.ok(Math.max(...eye) < 0.15, 'on an eye it keeps the ink');
  // Along a thread from the pink into the paper, colour changes in small steps: a transition.
  const path = Array.from({ length: 101 }, (_, i) => [i / 100, 0.5, 0, 1]);
  const m = tube([path], 0.01, 6, { colorAt: ([x]) => col(x, 0.2) });
  assert.ok(m.colors && m.colors.length === m.positions.length, 'one colour per vertex');
  let maxStep = 0;
  for (let i = 1; i < 101; i++) {
    const a = (i - 1) * 6 * 3, b = i * 6 * 3;
    maxStep = Math.max(maxStep, Math.abs(m.colors[b] - m.colors[a]) + Math.abs(m.colors[b + 1] - m.colors[a + 1]));
  }
  assert.ok(maxStep < 0.12, `no hard step in colour along the thread (largest ${maxStep.toFixed(3)})`);
  assert.ok(m.colors[0] > 0.4 && m.colors[100 * 6 * 3] < 0.15, 'from pink at one end to ink at the other');
});
