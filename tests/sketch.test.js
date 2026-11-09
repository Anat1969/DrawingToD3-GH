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
  assert.deepEqual(normalizeParams({ plane: 'roof', thickness: 4 }), { thickness: 1, plane: 'view', offset: 0, symmetry: false, snap: true, colour: '#c0392b', spray: 0.35, result: 'sculpt', depth: 0.5, wrap: 0.45 });
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

test('colour: a line drawn in colour before the spray keeps it, in the tube and through the archive', async () => {
  const { rgb, isColour, PALETTE } = await import('../src/sketch-core.js');
  assert.ok(PALETTE.every(isColour) && PALETTE[0] === '#1a1611', 'a palette of real colours, ink first');
  assert.deepEqual(rgb('#ff8000').map((v) => Math.round(v * 255)), [255, 128, 0]);
  const strokes = [{ g: 0, pts: [[0, 1, 0], [0.4, 1.1, 0], [0.8, 1, 0]], c: '#c0392b' }, { g: 1, pts: [[0, 0.5, 0], [0.5, 0.5, 0.2]] }];
  const back = deserialize(JSON.parse(JSON.stringify(serialize(strokes))));
  assert.equal(back[0].c, '#c0392b', 'the colour survives the archive');
  assert.equal(back[1].c, undefined, 'a line without a colour stays ink');
  assert.deepEqual(deserialize([{ g: 0, c: 'red; drop', p: [0, 0, 0, 1, 1, 1] }])[0].c, undefined, 'only real colours are read back');
  const tube = tubeMesh(tubePaths(strokes), 0.01, 6, { colorAt: (q) => q[4] || rgb() });
  const first = Array.from(tube.colors.slice(0, 3)).map((v) => Math.round(v * 255));
  assert.deepEqual(first, [192, 57, 43], 'the red line is red in the tube');
  const last = Array.from(tube.colors.slice(-3)).map((v) => Math.round(v * 255));
  assert.deepEqual(last, [26, 22, 17], 'the plain line is ink');
});

test('spray: colour is a soft cloud in space, not thread, and the thread takes its colour', async () => {
  const { sprayPuffs, sprayColourAt, sprayWidth, pens, rgb } = await import('../src/sketch-core.js');
  const W = sprayWidth(0.35);
  const spray = { g: 1, k: 'spray', c: '#2e5fb8', w: W, pts: finishStroke([[-0.6, 1, 0], [0, 1.05, 0], [0.6, 1, 0]]) };
  const line = { g: 0, pts: finishStroke([[-0.6, 1, 0], [0.6, 1, 0]]) };
  const far = { g: 2, pts: finishStroke([[-0.6, 0.2, 0], [0.6, 0.2, 0]]) };
  const strokes = [line, spray, far];

  // Not thread: the spray never becomes a tube, and the pen never snaps to it.
  assert.equal(tubePaths(strokes).length, 2);
  assert.deepEqual(pens(strokes), [line, far]);

  // A cloud: many puffs, of many sizes and transparencies, around the gesture, in depth too.
  const c = sprayPuffs(strokes);
  const n = c.size.length;
  assert.ok(n > 100, `${n} puffs`);
  assert.ok(Math.max(...c.size) / Math.min(...c.size) > 2.5, 'many sizes');
  assert.ok(Math.max(...c.alpha) <= 0.4 && Math.min(...c.alpha) >= 0.1, 'translucent, never solid');
  const z = c.pos.filter((_, i) => i % 3 === 2);
  assert.ok(Math.max(...z) - Math.min(...z) > W * 0.5, 'a cloud in space, not a flat stripe');
  const ys = c.pos.filter((_, i) => i % 3 === 1);
  const near = ys.filter((y) => Math.abs(y - 1.02) < W).length / n;
  assert.ok(near > 0.9, `dense where the hand passed (${(near * 100).toFixed(0)}%)`);
  assert.deepEqual(sprayPuffs(strokes), c, 'the same cloud every time the work is rebuilt or reopened');

  // A dab: a press without a move still sprays.
  assert.ok(sprayPuffs([{ g: 0, k: 'spray', c: '#c0392b', w: W, pts: [[0, 1, 0], [0, 1, 0]] }]).size.length >= 10);

  // The thread inside the spray takes its colour, over bare paper it stays ink.
  const at = sprayColourAt(strokes);
  assert.deepEqual(at([0, 1, 0]).map((v) => Math.round(v * 255)), [46, 95, 184]);
  assert.equal(at([0, 0.2, 0]), null);
  // Two sprays meet in a soft blend.
  const mix = sprayColourAt([{ ...spray, c: '#ff0000', pts: [[-0.1, 1, 0], [-0.05, 1, 0]] }, { ...spray, c: '#0000ff', pts: [[0.1, 1, 0], [0.05, 1, 0]] }])([0, 1, 0]);
  assert.ok(mix[0] > 0.3 && mix[2] > 0.3, 'a transition between colours, not a seam');

  // Through the archive.
  const back = deserialize(JSON.parse(JSON.stringify(serialize(strokes))));
  assert.equal(back[1].k, 'spray');
  assert.ok(Math.abs(back[1].w - W) < 1e-3);
  assert.equal(back[0].k, undefined);
  assert.ok(rgb(back[1].c)[2] > 0.7);
});
