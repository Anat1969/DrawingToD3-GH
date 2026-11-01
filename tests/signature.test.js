// Anat's signature, drawn once and kept as lines: normalised to its own box, stored, and drawn
// back small at the bottom left of a saved picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, follow, drawSignature, loadSignature, saveSignature } from '../src/signature.js';

test('a signature is kept in its own box: height 1, width by its proportion', () => {
  const sig = normalise([[[100, 50], [160, 80], [220, 60]], [[240, 40], [300, 90]]]);
  assert.ok(Math.abs(sig.aspect - 4) < 1e-9, 'width 200 over height 50');
  const ys = sig.strokes.flat().map((p) => p[1]), xs = sig.strokes.flat().map((p) => p[0]);
  assert.equal(Math.min(...ys), 0); assert.equal(Math.max(...ys), 1);
  assert.equal(Math.min(...xs), 0); assert.equal(Math.max(...xs), 4);
  assert.equal(normalise([]), null, 'an empty pad is no signature');
  assert.equal(normalise([[[5, 5], [5, 5]]]), null, 'a dot is no signature');
});

test('the pen lags a little: a trembling hand gives a calm line', () => {
  assert.deepEqual(follow(null, [10, 10]), [10, 10]);
  assert.deepEqual(follow([0, 0], [10, 20]), [5, 10]);
});

test('drawn at the bottom left, at the asked height, in black', () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, ...a])), set: (t, k, v) => { t[k] = v; return true; } });
  const sig = normalise([[[0, 0], [30, 10], [60, 0]]]);
  drawSignature(ctx, sig, 20, 500, 40);
  const pts = calls.filter(([k]) => k === 'moveTo' || k === 'lineTo' || k === 'quadraticCurveTo').flatMap(([, ...a]) => a);
  const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1);
  assert.ok(Math.min(...xs) >= 20 && Math.max(...xs) <= 20 + 40 * sig.aspect + 1e-9, 'starts at the left margin');
  assert.ok(Math.min(...ys) >= 460 && Math.max(...ys) <= 500, 'sits on the bottom line, 40 high');
  assert.equal(ctx.strokeStyle, '#111');
});

test('stored and read back; cleared to go back to the font', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const sig = normalise([[[0, 0], [10, 5], [20, 0]]]);
  assert.ok(saveSignature(sig, storage));
  assert.deepEqual(loadSignature(storage), sig);
  saveSignature(null, storage);
  assert.equal(loadSignature(storage), null);
});
