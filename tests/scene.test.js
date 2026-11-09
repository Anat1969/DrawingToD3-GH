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

test('landscape diffusion: one continuous depth, the picture unchanged from its own camera', async () => {
  const { sceneAnchors, rayPoint } = await import('../src/scene-core.js');
  const { diffuseDepth } = await import('../src/depth-core.js');
  const cam = sceneCamera(0.25, 1, 0.5);
  const W = 80, H = 80, label = new Int32Array(W * H).fill(-1);
  // A boat standing on the water, touching it at row 0.6.
  for (let y = 36; y < 48; y++) for (let x = 20; x < 60; x++) label[y * W + x] = 0;
  const things = [{ standing: true, contact: 0.6 }];
  const { target, conf } = sceneAnchors(cam, label, things, W, H, W, H);
  const guide = new Float32Array(W * H).fill(128);
  const T = diffuseDepth(target, conf, guide, W, H, { sigma: 20 });
  assert.ok(T.every((v) => Number.isFinite(v) && v > 0), 'every point has a depth');
  // The ground recedes toward the horizon, and the boat sits at the depth of its contact.
  assert.ok(T[78 * W + 40] > T[60 * W + 40] && T[60 * W + 40] > T[30 * W + 40], 'near at the bottom, far at the horizon');
  const boat = T[42 * W + 40], contact = cam.near / cam.groundDepth(0.6);
  assert.ok(Math.abs(boat - contact) < 0.08, `the boat at its contact depth (${boat.toFixed(2)} vs ${contact.toFixed(2)})`);
  // Continuous: down a column, no step larger than a small share of the range.
  let maxStep = 0;
  for (let y = 1; y < H; y++) maxStep = Math.max(maxStep, Math.abs(T[y * W + 5] - T[(y - 1) * W + 5]));
  assert.ok(maxStep < 0.08, `no fold where the ground meets the back wall (largest step ${maxStep.toFixed(3)})`);
  // From the picture's camera each point falls exactly on its place.
  for (const [u, v, t] of [[0.2, 0.9, 0.8], [0.7, 0.4, 0.2], [0.5, 0.1, 0.05]]) {
    const [x, y, z] = rayPoint(cam, u, v, t), d = -z;
    assert.ok(Math.abs(cam.aspect / 2 + (x * cam.f) / d - u) < 1e-9 && Math.abs(cam.vh + ((cam.hc - y) * cam.f) / d - v) < 1e-9);
  }
});

test('hills from shading: a sunlit mound stands nearer than the flat ground around it', async () => {
  const { sceneAnchors } = await import('../src/scene-core.js');
  const cam = sceneCamera(0.3, 1, 0.5);
  const W = 90, H = 90, L = new Float32Array(W * H).fill(110);
  // A mound on the ground: a lit face, brighter than the land around it.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r = Math.hypot((x - 45) / 14, (y - 55) / 8);
    if (r < 1) L[y * W + x] = 110 + 90 * (1 - r * r);
  }
  const flat = sceneAnchors(cam, null, [], W, H, W, H);
  const hill = sceneAnchors(cam, null, [], W, H, W, H, { luminance: L });
  const p = 55 * W + 45, q = 55 * W + 10;
  assert.ok(hill.target[p] > flat.target[p] * 1.15, `the mound comes forward (${flat.target[p].toFixed(2)} to ${hill.target[p].toFixed(2)})`);
  assert.ok(Math.abs(hill.target[q] - flat.target[q]) < 1e-6, 'the flat ground beside it stays');
  const sky = 10 * W + 45;
  assert.equal(hill.target[sky], flat.target[sky], 'the sky is not lifted');
});
