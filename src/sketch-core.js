// Drawing in 3D, pure functions (no DOM, no Three.js, testable in Node).
// The pen draws on a transparent sheet in space. The sheet faces the viewer (or is a wall,
// a side wall or the floor), and can be pushed forward and back. Orbiting the work turns the
// sheet, so the next line lands at another depth. A line that starts on an existing line
// continues it exactly, and the sheet passes through that point: one thread, in depth.
// Inspiration: the drawing planes of Mental Canvas (Dorsey et al., Pacific Graphics 2007).

// result: 'sculpt' reads the drawing and winds it into space (the line sculpture engine),
//         'line' keeps each line where the pen put it.
export const SKETCH_DEFAULTS = { thickness: 0.35, plane: 'view', offset: 0, symmetry: false, snap: true, result: 'sculpt', depth: 0.5, wrap: 0.45 };
export const RESULTS = ['sculpt', 'line'];
export const PLANES = ['view', 'wall', 'side', 'floor'];
export const CENTER = [0, 1, 0]; // the middle of the drawing space, one unit above the floor
export const STEP = 0.01;        // spacing of the finished line, in world units
export const SNAP_PX = 16;       // how close to a line a press must be to continue it

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Wire radius, the same as the line sculpture: one line, one weight across the app. */
export const radiusFor = (t) => 0.004 + 0.02 * clamp01(t ?? SKETCH_DEFAULTS.thickness);

/**
 * The sheet the pen draws on.
 * @param kind   'view' | 'wall' | 'side' | 'floor'
 * @param offset -1..1, pushes the sheet along its normal (for 'floor': height above the floor)
 * @param view   { position, target } of the camera, used by 'view'
 * @returns {{origin:number[], normal:number[]}}
 */
export function planeFor(kind, offset = 0, view = null) {
  const d = Math.max(-1, Math.min(1, Number(offset) || 0));
  const c = CENTER;
  if (kind === 'wall') return { origin: [c[0], c[1], c[2] + d], normal: [0, 0, 1] };
  if (kind === 'side') return { origin: [c[0] + d, c[1], c[2]], normal: [1, 0, 0] };
  if (kind === 'floor') return { origin: [c[0], c[1] + d, c[2]], normal: [0, 1, 0] };
  const target = view ? view.target : c;
  const n = view ? norm(sub(view.position, target)) : [0, 0, 1];
  return { origin: add(target, scale(n, d)), normal: n };
}

/** The same sheet, moved to pass through a point (used when a line continues another). */
export const planeThrough = (plane, point) => ({ origin: point.slice(0, 3), normal: plane.normal.slice() });

/** Where a ray meets the sheet; null when it runs parallel or the sheet is behind. */
export function rayPlane(origin, dir, plane) {
  const den = dot(dir, plane.normal);
  if (Math.abs(den) < 1e-6) return null;
  const t = dot(sub(plane.origin, origin), plane.normal) / den;
  if (!(t > 0)) return null;
  return add(origin, scale(dir, t));
}

/**
 * The pen's lag: each new point is pulled only part of the way toward the pointer,
 * which takes the tremor of a mouse or a finger out of the line (a "lazy brush").
 */
export function follow(prev, next, k = 0.45) {
  if (!prev) return next.slice(0, 3);
  return add(prev, scale(sub(next, prev), k));
}

export function pathLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/** Even spacing along the line. Keeps both ends. */
export function resample(pts, step = STEP) {
  if (pts.length < 2) return pts.map((p) => p.slice(0, 3));
  const total = pathLength(pts);
  if (total < 1e-9) return [pts[0].slice(0, 3)];
  const n = Math.max(1, Math.round(total / step));
  const want = total / n;
  const out = [pts[0].slice(0, 3)];
  let i = 1, carry = 0, a = pts[0];
  while (i < pts.length && out.length < n) {
    const b = pts[i];
    const seg = dist(a, b);
    if (carry + seg >= want - 1e-12) {
      const t = (want - carry) / (seg || 1);
      a = add(a, scale(sub(b, a), t));
      out.push(a);
      carry = 0;
    } else {
      carry += seg;
      a = b;
      i++;
    }
  }
  out.push(pts[pts.length - 1].slice(0, 3));
  return out;
}

/** Laplacian smoothing with fixed ends: the line flows, and a continued line stays attached. */
export function smooth(pts, iterations = 3, w = 0.5) {
  let p = pts.map((q) => q.slice(0, 3));
  for (let it = 0; it < iterations; it++) {
    const next = p.map((q) => q.slice());
    for (let i = 1; i < p.length - 1; i++) {
      for (let k = 0; k < 3; k++) next[i][k] = p[i][k] + w * ((p[i - 1][k] + p[i + 1][k]) / 2 - p[i][k]);
    }
    p = next;
  }
  return p;
}

/** Raw pen points to a finished line: even spacing, smoothed, even spacing again. */
export function finishStroke(raw, step = STEP) {
  const clean = [];
  for (const q of raw) if (!clean.length || dist(clean[clean.length - 1], q) > 1e-6) clean.push(q.slice(0, 3));
  if (clean.length < 2 || pathLength(clean) < step * 1.5) return null;
  return resample(smooth(resample(clean, step / 2), 4), step);
}

/** Mirror across the middle of the space (x = 0): the other half of a symmetric figure. */
export const mirror = (pts) => pts.map((p) => [2 * CENTER[0] - p[0], p[1], p[2]]);

/**
 * The existing line point closest to the pointer on screen.
 * @param strokes  [{ pts }]
 * @param project  (p) => [sx, sy, visible] screen position of a world point
 * @returns {{point:number[], stroke:number, index:number, px:number}|null}
 */
export function nearestPoint(strokes, project, sx, sy, maxPx = SNAP_PX) {
  let best = null;
  strokes.forEach((s, si) => {
    for (let i = 0; i < s.pts.length; i++) {
      const [x, y, visible] = project(s.pts[i]);
      if (!visible) continue;
      const d = Math.hypot(x - sx, y - sy);
      if (d <= maxPx && (!best || d < best.px)) best = { point: s.pts[i].slice(0, 3), stroke: si, index: i, px: d };
    }
  });
  return best;
}

/** Paths for the tube builder, in drawing order (weight 1: one line, one weight). */
export const tubePaths = (strokes) => strokes.filter((s) => s.pts.length >= 2).map((s) => s.pts.map((p) => [p[0], p[1], p[2], 1]));

/** Compact form for the archive: flat numbers, four decimals (a tenth of a millimetre at 1 unit = 1 m). */
export function serialize(strokes) {
  return strokes.map((s) => ({ g: s.g, p: s.pts.flatMap((q) => q.map((v) => Math.round(v * 1e4) / 1e4)) }));
}

export function deserialize(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (!s || !Array.isArray(s.p) || s.p.length < 6) continue;
    const pts = [];
    for (let i = 0; i + 2 < s.p.length; i += 3) {
      const q = [Number(s.p[i]), Number(s.p[i + 1]), Number(s.p[i + 2])];
      if (q.every(Number.isFinite)) pts.push(q);
    }
    if (pts.length >= 2) out.push({ g: Number.isFinite(s.g) ? s.g : out.length, pts });
  }
  return out;
}

/** Strokes drawn together (a line and its mirror) share a group, and are undone together. */
export const nextGroup = (strokes) => strokes.reduce((m, s) => Math.max(m, s.g), -1) + 1;

export function normalizeParams(p = {}) {
  return {
    thickness: Number.isFinite(p.thickness) ? clamp01(p.thickness) : SKETCH_DEFAULTS.thickness,
    plane: PLANES.includes(p.plane) ? p.plane : SKETCH_DEFAULTS.plane,
    offset: Number.isFinite(p.offset) ? Math.max(-1, Math.min(1, p.offset)) : SKETCH_DEFAULTS.offset,
    symmetry: typeof p.symmetry === 'boolean' ? p.symmetry : SKETCH_DEFAULTS.symmetry,
    snap: typeof p.snap === 'boolean' ? p.snap : SKETCH_DEFAULTS.snap,
    result: RESULTS.includes(p.result) ? p.result : SKETCH_DEFAULTS.result,
    depth: Number.isFinite(p.depth) ? clamp01(p.depth) : SKETCH_DEFAULTS.depth,
    wrap: Number.isFinite(p.wrap) ? clamp01(p.wrap) : SKETCH_DEFAULTS.wrap,
  };
}

/**
 * The drawing as a sheet of paper for the line sculpture engine: the strokes seen from the
 * front (x, y), centred on a square-ish page with a margin, and the way back to world units.
 * The engine maps the page's longest side to 2 units around its centre, so a point on the
 * page returns to the world by: world = centre + engine * scale.
 * @returns {{width:number,height:number,line:number,toPage:(p:number[])=>[number,number],center:number[],scale:number}|null}
 */
export function paperLayout(strokes, side = 560) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const p of s.pts) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  if (!Number.isFinite(x0)) return null;
  const bw = Math.max(x1 - x0, 0.05), bh = Math.max(y1 - y0, 0.05);
  const margin = side * 0.1;
  const k = (side - 2 * margin) / Math.max(bw, bh);       // pixels per world unit
  const width = Math.round(bw >= bh ? side : bw * k + 2 * margin);
  const height = Math.round(bh >= bw ? side : bh * k + 2 * margin);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return {
    width, height,
    line: Math.max(3, side * 0.009),
    toPage: (p) => [width / 2 + (p[0] - cx) * k, height / 2 - (p[1] - cy) * k],
    center: [cx, cy, 0],
    scale: Math.max(width, height) / (2 * k),            // engine units back to world units
  };
}
