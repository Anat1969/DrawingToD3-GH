// Photographs (Anat, 1.11.2026): near and far as layers, sharpness against a blurred background,
// and a desert landscape that spreads into depth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { focusMap, isLayeredPhoto, foregroundFromFocus } from '../src/sculpt-core.js';
import { findHorizon, isLandscape } from '../src/scene-core.js';

function load(name, w, h) {
  const rgb = zlib.gunzipSync(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) { data.set(rgb.subarray(p * 3, p * 3 + 3), p * 4); data[p * 4 + 3] = 255; }
  return { width: w, height: h, data };
}

test('focus: the two shallow-focus photographs are layered; drawings and paintings are not', () => {
  for (const [name, w, h] of [['photographer-560x373.rgb.gz', 560, 373], ['sunset-560x344.rgb.gz', 560, 344]]) {
    const f = focusMap(load(name, w, h));
    assert.ok(isLayeredPhoto(f), `${name}: sharp over blurred ${f.ratio.toFixed(1)}`);
  }
  for (const [name, w, h] of [['hug-360.rgb.gz', 360, 360], ['zebras-300.rgb.gz', 300, 300], ['faces-300x335.rgb.gz', 300, 335], ['boat-200.rgb.gz', 200, 200]]) {
    const f = focusMap(load(name, w, h));
    assert.ok(!isLayeredPhoto(f), `${name}: ${f.ratio.toFixed(1)}`);
  }
});

test('near layer: the photographer is in front; the phone and the hand stand apart from the bokeh lights', () => {
  const ph = load('photographer-560x373.rgb.gz', 560, 373);
  const m = foregroundFromFocus(focusMap(ph).F, 560, 373);
  const at = (x, y) => m[Math.round(y * 373) * 560 + Math.round(x * 560)];
  assert.equal(at(0.55, 0.45), 1, 'the camera and the face are near');
  assert.equal(at(0.05, 0.1), 0, 'the blurred field is far');
  assert.equal(at(0.95, 0.15), 0, 'the far corner is far');
  const sun = load('sunset-560x344.rgb.gz', 560, 344);
  const s = foregroundFromFocus(focusMap(sun).F, 560, 344);
  const sa = (x, y) => s[Math.round(y * 344) * 560 + Math.round(x * 560)];
  assert.equal(sa(0.6, 0.3), 1, 'the phone in the hand is near');
  assert.equal(sa(0.15, 0.55), 0, 'the row of bokeh lights on the left is far');
  assert.equal(sa(0.3, 0.85), 0, 'the reflections on the water are far');
});

test('landscape photograph: a cloudy sky over a straight horizon still reads as a landscape', () => {
  const r = findHorizon(load('desert-200x134.rgb.gz', 200, 134));
  assert.ok(isLandscape(r), `desert: agree ${r.agree.toFixed(2)}, calm ${r.calm.toFixed(0)}, sky ${r.skyLike}`);
  assert.ok(r.row > 0.3 && r.row < 0.55, `horizon at ${(r.row * 100).toFixed(0)}%`);
  const faces = findHorizon(load('faces-300x335.rgb.gz', 300, 335));
  assert.ok(!isLandscape(faces), 'a painting of faces under red hair is not a landscape');
});

test('a pen drawing on white paper is not a photograph (blank paper is not a blurred background)', () => {
  const W = 200, H = 160, data = new Uint8ClampedArray(W * H * 4).fill(250);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const on = Math.abs(Math.hypot(x - 100, y - 80) - 50) < 1.5 || (Math.abs(y - 120) < 1.2 && x > 30 && x < 170);
    if (on) data.set([20, 18, 15], (y * W + x) * 4);
    data[(y * W + x) * 4 + 3] = 255;
  }
  assert.ok(!isLayeredPhoto(focusMap({ width: W, height: H, data })));
});
