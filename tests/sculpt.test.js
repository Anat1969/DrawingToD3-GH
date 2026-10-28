// Local sculpting engine: correctness and printability (closed body).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysePixels, buildSculpt, isClosed } from '../src/sculpt-core.js';

// Paint a white canvas and draw shapes on it with a function (x, y) => [r, g, b] | null.
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

const shapes = {
  disc: canvas(120, 100, (x, y) => ((x - 60) ** 2 + (y - 50) ** 2 < 35 ** 2 ? GREEN : null)),
  outlineOnly: canvas(120, 120, (x, y) => { const r = Math.hypot(x - 60, y - 60); return r > 38 && r < 42 ? INK : null; }),
  twoFigures: canvas(160, 120, (x, y) => (((x - 50) ** 2 / 900 + (y - 60) ** 2 / 2500 < 1) || ((x - 110) ** 2 / 700 + (y - 65) ** 2 / 2000 < 1) ? GREEN : null)),
  lShape: canvas(100, 100, (x, y) => ((x > 20 && x < 45 && y > 15 && y < 85) || (x > 20 && x < 80 && y > 60 && y < 85) ? GREEN : null)),
  thinStroke: canvas(100, 60, (x, y) => (Math.abs(y - 30 - 10 * Math.sin(x / 8)) < 2 && x > 10 && x < 90 ? INK : null)),
  withLines: canvas(120, 100, (x, y) => {
    const inside = (x - 60) ** 2 + (y - 50) ** 2 < 38 ** 2;
    if (!inside) return null;
    return Math.abs(x - 60) < 2 || Math.abs(y - 50) < 2 ? INK : GREEN;
  }),
};

for (const [name, img] of Object.entries(shapes)) {
  test(`sculpt ${name}: closed body for every slider setting`, () => {
    const a = analysePixels(img);
    for (const volume of [0, 0.5, 1]) for (const line of [0, 1]) {
      const m = buildSculpt(a, { volume, line });
      assert.ok(m.triangles > 50, `${name} has triangles`);
      assert.ok(isClosed(m.indices), `${name} closed at volume ${volume}, line ${line}`);
      for (const v of m.positions) assert.ok(Number.isFinite(v));
    }
  });
}

test('sculpt: an enclosed outline becomes a filled body, not a ring', () => {
  const a = analysePixels(shapes.outlineOnly);
  const centre = (a.pad + 60) * a.W + a.pad + 60;
  assert.equal(a.mask[centre], 1);
});

test('sculpt: volume controls thickness', () => {
  const a = analysePixels(shapes.disc);
  const depth = (m) => { let z = 0; for (let i = 2; i < m.positions.length; i += 3) z = Math.max(z, m.positions[i]); return z; };
  assert.ok(depth(buildSculpt(a, { volume: 1 })) > depth(buildSculpt(a, { volume: 0 })) * 2);
});

test('sculpt: line raises dark strokes', () => {
  const a = analysePixels(shapes.withLines);
  const p = (a.pad + 50) * a.W + a.pad + 80; // on the horizontal ink line
  assert.ok(a.ink[p] > 0.5);
});

test('sculpt: empty page and full-bleed image are refused with a reason', () => {
  assert.throws(() => analysePixels(canvas(80, 80, () => null)), { code: 'no_subject' });
  assert.throws(() => analysePixels(canvas(80, 80, () => GREEN)), (e) => e.code === 'no_background' || e.code === 'no_subject');
});

test('isClosed: detects an open surface', () => {
  assert.equal(isClosed(new Uint32Array([0, 1, 2])), false);
  assert.equal(isClosed(new Uint32Array([0, 1, 2, 0, 2, 1])), true);
});

// Fuzz: random blobs and strokes with thin necks, like real drawings. Seeded, so repeatable.
test('sculpt: random drawings always give a closed body', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 40; k++) {
    const blobs = Array.from({ length: 2 + Math.floor(rnd() * 5) }, () => ({ x: 20 + rnd() * 120, y: 20 + rnd() * 100, r: 4 + rnd() * 26, ink: rnd() < 0.4 }));
    const strokes = Array.from({ length: Math.floor(rnd() * 4) }, () => ({ x: rnd() * 160, y: rnd() * 140, a: rnd() * Math.PI, len: 30 + rnd() * 90, w: 1 + rnd() * 2.5 }));
    const img = canvas(160, 140, (x, y) => {
      for (const b of blobs) if ((x - b.x) ** 2 + (y - b.y) ** 2 < b.r ** 2) return b.ink ? INK : GREEN;
      for (const s of strokes) {
        const dx = x - s.x, dy = y - s.y, t = dx * Math.cos(s.a) + dy * Math.sin(s.a);
        if (t > 0 && t < s.len && Math.abs(-dx * Math.sin(s.a) + dy * Math.cos(s.a)) < s.w) return INK;
      }
      return null;
    });
    let a;
    try { a = analysePixels(img); } catch (e) { if (e.code) continue; throw e; }
    const m = buildSculpt(a, { volume: rnd(), line: rnd() });
    assert.ok(isClosed(m.indices), `random drawing #${k} is closed`);
  }
});
