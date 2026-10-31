// Reading a landscape: the horizon, the picture's camera, and what stands on the ground.
// Anat, 31.10.2026: a beach with a boat should spread into depth, not inflate like an object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { findHorizon, isLandscape, sceneCamera, standingThings, FOCAL } from '../src/scene-core.js';

function load(name, w, h) {
  const rgb = zlib.gunzipSync(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) { data.set(rgb.subarray(p * 3, p * 3 + 3), p * 4); data[p * 4 + 3] = 255; }
  return { width: w, height: h, data };
}

test('horizon: the beach is a landscape, the three figure drawings are not', () => {
  const boat = findHorizon(load('boat-200.rgb.gz', 200, 200));
  assert.ok(isLandscape(boat), `beach score ${boat.score.toFixed(2)}`);
  assert.ok(boat.row > 0.12 && boat.row < 0.26, `horizon at ${(boat.row * 100).toFixed(0)}% of the height (sea meets sky near 18%)`);
  for (const [name, w, h] of [['hug-360.rgb.gz', 360, 360], ['zebras-300.rgb.gz', 300, 300], ['faces-300x335.rgb.gz', 300, 335]]) {
    const r = findHorizon(load(name, w, h));
    assert.ok(!isLandscape(r), `${name} is read as a thing (score ${r.score.toFixed(2)})`);
  }
});

test('camera: from the picture\'s own viewpoint every point lands back on its place in the picture', () => {
  const cam = sceneCamera(0.2, 1.2, 0.5);
  const project = ([x, y, z]) => {
    const [cx, cy] = cam.viewpoint.position;
    const d = -z;
    return [cam.aspect / 2 + ((x - cx) * cam.f) / d, cam.vh + ((cy - y) * cam.f) / d];
  };
  for (const [u, v] of [[0.1, 0.95], [0.6, 0.5], [1.1, 0.3], [0.5, 0.21], [0.3, 0.1], [0.9, 0.02]]) {
    const [pu, pv] = project(cam.ground(u, v));
    assert.ok(Math.abs(pu - u) < 1e-9 && Math.abs(pv - v) < 1e-9, `ground/back wall point ${u},${v}`);
    if (v > 0.3) {
      const [su, sv] = project(cam.standing(u, v - 0.1, v));
      assert.ok(Math.abs(su - u) < 1e-9 && Math.abs(sv - (v - 0.1)) < 1e-9, 'standing point');
    }
  }
  // Depth grows toward the horizon, the ground lies flat, and the sky stands at the back.
  assert.ok(-cam.ground(0.5, 0.9)[2] < -cam.ground(0.5, 0.5)[2]);
  assert.equal(cam.ground(0.5, 0.7)[1], 0);
  assert.equal(-cam.ground(0.5, 0.1)[2], cam.far);
  assert.ok(cam.ground(0.5, 0.1)[1] > cam.hc, 'the sky is above the eye');
  assert.ok(Math.abs(FOCAL - 1 / (2 * Math.tan((16 * Math.PI) / 180))) < 1e-12);
});

test('standing things: a boat stands where it touches the water; the foreground ground and small marks lie', () => {
  const W = 200, H = 200, ink = new Uint8Array(W * H);
  const fill = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ink[y * W + x] = 1; };
  fill(40, 190, 60, 110);   // a boat, wide, resting at row 110
  fill(0, 200, 170, 200);   // the foreground sand texture, reaching the bottom edge
  fill(30, 36, 140, 146);   // a footprint
  const { things } = standingThings(ink, W, H, 0.2);
  const stand = things.filter((t) => t.standing);
  assert.equal(stand.length, 1, 'only the boat stands');
  assert.ok(Math.abs(stand[0].contact - 110 / H) < 0.01, 'it touches the ground at its lowest ink');
});

test('standing things: a tree at the side runs off the bottom edge and still stands', () => {
  const W = 200, H = 200, ink = new Uint8Array(W * H);
  const fill = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ink[y * W + x] = 1; };
  fill(5, 25, 20, 200);     // a trunk from above the horizon down past the bottom edge
  fill(0, 45, 20, 60);      // its crown
  fill(120, 200, 186, 200); // the near ground's ink along the bottom edge, apart from the tree
  const { things } = standingThings(ink, W, H, 0.2, { reach: 1 });
  const tree = things.find((t) => t.x0 <= 5 && t.y0 <= 20);
  assert.ok(tree && tree.standing, 'the tree stands');
  const ground = things.find((t) => t.x0 >= 110);
  assert.ok(ground && !ground.standing, 'the near ground lies');
});
