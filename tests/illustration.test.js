// A real colour illustration (Anat's two girls hugging, 31.10.2026): the line sculpture must
// look like the drawing. Before these fixes the thread was a scribble: washes read as ink,
// faces lost, and almost half of the thread was straight joins that are not in the drawing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { extractStrokes, threadThroughInk, wireRadius } from '../src/line-core.js';

const W = 360;
const rgb = zlib.gunzipSync(fs.readFileSync(new URL('./fixtures/hug-360.rgb.gz', import.meta.url)));
const data = new Uint8ClampedArray(W * W * 4);
for (let p = 0; p < W * W; p++) { data.set(rgb.subarray(p * 3, p * 3 + 3), p * 4); data[p * 4 + 3] = 255; }
const img = { width: W, height: W, data };
const strokes = extractStrokes(img, { sensitivity: 0.6 });
const len = (s) => s.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - s[i][0], p[1] - s[i][1]), 0);
const strongWash = (x, y) => {
  const i = (Math.round(y) * W + Math.round(x)) * 4;
  const mx = Math.max(data[i], data[i + 1], data[i + 2]), mn = Math.min(data[i], data[i + 1], data[i + 2]);
  return mx > 40 && (mx - mn) / mx > 0.6 && 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 90;
};

test('illustration: colour washes are not ink (pink hair is as dark as pencil, but it is colour)', () => {
  const pts = strokes.flat();
  const onWash = pts.filter(([x, y]) => strongWash(x, y)).length / pts.length;
  assert.ok(onWash < 0.03, `${(onWash * 100).toFixed(1)}% of the line lies on a colour wash (was 13%)`);
});

test('illustration: the drawn lines are found whole, the faces included', () => {
  const drawn = strokes.reduce((a, s) => a + len(s), 0);
  assert.ok(drawn > 7000, `${Math.round(drawn)}px of line traced (was 3300)`);
  const inBox = (x0, y0, x1, y1) => strokes.reduce((a, s) => a + s.filter(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1).length, 0);
  assert.ok(inBox(130, 95, 170, 140) >= 8, 'the left face (eyes, smile) is read');
  assert.ok(inBox(180, 100, 225, 145) >= 20, 'the right face is read');
});

test('illustration: the one thread runs along the drawing, not across it', () => {
  const t = threadThroughInk(strokes);
  const off = t.offInk / (t.drawn + t.offInk);
  assert.ok(off < 0.15, `${(off * 100).toFixed(1)}% of the thread is off the drawing (was 44%)`);
  assert.ok(t.path.length > 100);
});

test('the wire has the drawing\'s own line weight', () => {
  assert.ok(strokes.lineWidth > 1 && strokes.lineWidth < 4, `measured line width ${strokes.lineWidth.toFixed(2)}px`);
  const px = 2 / W;
  const fine = wireRadius(1.5, px), bold = wireRadius(6, px);
  assert.ok(bold > fine * 3, 'a marker drawing gives a thicker wire than a fine pen');
  assert.ok(wireRadius(2, px, 1) > wireRadius(2, px, 0.35) * 4 && wireRadius(2, px, 0) < wireRadius(2, px, 0.35), 'the thickness slider scales around it');
});
