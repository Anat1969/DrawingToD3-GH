// Drawing in 3D: the sheet, the pen's smoothing, continuing a line, mirror, archive round trip,
// and that every drawing is still one printable closed wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planeFor, planeThrough, rayPlane, follow, finishStroke, mirror, nearestPoint, tubePaths,
  serialize, deserialize, nextGroup, normalizeParams, pathLength, radiusFor, dist, STEP,
} from '../src/sketch-core.js';
import { tubeMesh } from '../src/line-core.js';

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// A hand on a mouse: a circle sampled every few pixels, with tremor.
function shakyCircle(n = 400, jitter = 0.012) {
  const pts = [];
  let s = null;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const raw = [Math.cos(a) * 0.6 + (rnd() - 0.5) * jitter, 1 + Math.sin(a) * 0.6 + (rnd() - 0.5) * jitter, 0];
    s = follow(s, raw);
    pts.push(s);
  }
  return pts;
}

function sharpTurns(pts, deg = 60) {
  let sharp = 0, n = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]];
    const b = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]];
    const la = Math.hypot(...a), lb = Math.hypot(...b);
    if (!la || !lb) continue;
    const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
    if (Math.acos(Math.max(-1, Math.min(1, c))) > (deg * Math.PI) / 180) sharp++;
    n++;
  }
  return sharp / Math.max(1, n);
}

test('sheet: facing the viewer, pushed along the view, and the fixed walls', () => {
  const view = { position: [0, 1, 5], target: [0, 1, 0] };
  const p = planeFor('view', 0.5, view);
  assert.deepEqual(p.normal.map((v) => Math.round(v * 1e6) / 1e6), [0, 0, 1]);
  assert.ok(Math.abs(p.origin[2] - 0.5) < 1e-9, 'offset moves the sheet toward the viewer');
  assert.deepEqual(planeFor('floor', -1).origin, [0, 0, 0], 'floor at -1 lies on the floor');
  assert.deepEqual(planeFor('side', 0.3).normal, [1, 0, 0]);
  assert.equal(planeFor('wall', 9).origin[2], 1, 'offset is clamped to the space');
});

test('pen ray meets the sheet, and misses when parallel or behind', () => {
  const plane = planeFor('wall', 0);
  const hit = rayPlane([0.2, 1.1, 5], [0, 0, -1], plane);
  assert.deepEqual(hit.map((v) => Math.round(v * 1e9) / 1e9), [0.2, 1.1, 0]);
  assert.equal(rayPlane([0, 1, 5], [1, 0, 0], plane), null);
  assert.equal(rayPlane([0, 1, 5], [0, 0, 1], plane), null);
});

test('stroke: a shaky mouse circle becomes a flowing line (under 3% sharp turns)', () => {
  const raw = shakyCircle();
  const before = sharpTurns(raw);
  const line = finishStroke(raw);
  const after = sharpTurns(line);
  assert.ok(after < 0.03, `sharp turns ${(after * 100).toFixed(1)}% (raw ${(before * 100).toFixed(1)}%)`);
  const gaps = line.slice(1).map((p, i) => dist(p, line[i]));
  assert.ok(Math.max(...gaps) < STEP * 1.6 && Math.min(...gaps) > STEP * 0.4, 'even spacing');
  assert.ok(Math.abs(pathLength(line) - 2 * Math.PI * 0.6) < 0.25, 'keeps the size of the gesture');
});

test('stroke: ends stay exactly where they were, so a continued line stays attached', () => {
  const raw = [[0, 1, 0], [0.1, 1.05, 0.02], [0.2, 1.02, 0.05], [0.33, 1.1, 0.1]];
  const line = finishStroke(raw);
  assert.deepEqual(line[0], raw[0]);
  assert.deepEqual(line[line.length - 1], raw[raw.length - 1]);
  assert.equal(finishStroke([[0, 1, 0], [0.001, 1, 0]]), null, 'a click is not a line');
});

test('continue: pressing near a line picks its point, and the sheet goes through it', () => {
  const strokes = [{ g: 0, pts: [[0, 1, 0], [0.5, 1, 0.3], [1, 1, 0.6]] }];
  const project = (p) => [p[0] * 100, p[1] * 100, true];
  const hit = nearestPoint(strokes, project, 52, 101);
  assert.deepEqual(hit.point, [0.5, 1, 0.3]);
  assert.equal(nearestPoint(strokes, project, 300, 300), null, 'far from any line: a new start');
  const sheet = planeThrough(planeFor('wall', 0), hit.point);
  assert.equal(sheet.origin[2], 0.3, 'the sheet moves to the depth of the touched point');
});

test('symmetry mirrors across the middle', () => {
  assert.deepEqual(mirror([[0.4, 1.2, 0.1]]), [[-0.4, 1.2, 0.1]]);
});

test('archive: strokes survive a round trip, and broken data is ignored', () => {
  const strokes = [{ g: 0, pts: finishStroke(shakyCircle(120)) }, { g: 0, pts: mirror([[0.1, 1, 0], [0.2, 1.1, 0.1]]) }];
  const back = deserialize(JSON.parse(JSON.stringify(serialize(strokes))));
  assert.equal(back.length, 2);
  assert.ok(back[0].pts.every((p, i) => dist(p, strokes[0].pts[i]) < 1e-3));
  assert.deepEqual(deserialize([null, { p: [1, 2] }, { p: ['a', 1, 2, 3, 4, 5] }, 'x']), []);
  assert.equal(nextGroup(back), 1);
  assert.deepEqual(normalizeParams({ plane: 'roof', thickness: 4 }), { thickness: 1, plane: 'view', offset: 0, symmetry: false, snap: true, result: 'sculpt', depth: 0.5, wrap: 0.45 });
});

test('every drawing is a closed wire, printable, with one weight', async () => {
  const { isClosed } = await import('../src/sculpt-core.js');
  const strokes = [];
  for (let k = 0; k < 6; k++) {
    const raw = shakyCircle(60 + k * 20).map((p) => [p[0] * (0.5 + rnd()), p[1], p[2] + k * 0.1]);
    strokes.push({ g: k, pts: finishStroke(raw) });
    strokes.push({ g: k, pts: mirror(strokes[strokes.length - 1].pts) });
  }
  const tube = tubeMesh(tubePaths(strokes), radiusFor(0.35), 8);
  assert.ok(tube.triangles > 1000);
  assert.ok(isClosed(tube.indices), 'every edge shared by exactly two triangles');
  assert.ok(tube.weight.every((w) => w === 1), 'one line, one weight');
  assert.ok(tube.timeline.end.length > 0 && tube.timeline.duration > 0, 'a timeline to replay the drawing in its real order');
});

test('reading the drawing: the page fits the strokes, and the engine maps back onto them', async () => {
  const { paperLayout } = await import('../src/sketch-core.js');
  const strokes = [{ g: 0, pts: [[-0.5, 0.6, 0], [0.5, 0.6, 0], [0.5, 1.4, 0], [-0.5, 1.4, 0], [-0.5, 0.6, 0]] }];
  const L = paperLayout(strokes, 560);
  assert.equal(L.width, 560, 'the wide side fills the page');
  assert.ok(L.height < 560 && L.height > 300);
  const [px, py] = L.toPage([0.5, 1.4, 0]);
  assert.ok(px > L.width / 2 && py < L.height / 2, 'up in the world is up on the page');
  // The engine's world: longest side of the page = 2 units, centred. Back to the world:
  const engine = ((px - L.width / 2) / Math.max(L.width, L.height)) * 2;
  assert.ok(Math.abs(L.center[0] + engine * L.scale - 0.5) < 1e-9, 'a page point returns to where it was drawn');
  assert.equal(paperLayout([]), null);
  assert.deepEqual([normalizeParams({}).result, normalizeParams({ result: 'line' }).result], ['sculpt', 'line'], 'reading the drawing is the default');
});
