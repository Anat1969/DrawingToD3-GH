// Line sculpture engine, pure functions (no DOM, testable in Node).
// A drawing's ink becomes one continuous line in 3D space, like a wire sculpture or a wound
// ball of yarn. Reading of the drawing:
//   - outline strokes lie on the rim of the body (depth near 0),
//   - inner strokes lie on the front of the body (depth from the inflated silhouette),
//   - all strokes are joined into one thread that winds around the back between strokes.
// Skeleton: Zhang & Suen thinning (Communications of the ACM, 1984).
// Simplification: Ramer-Douglas-Peucker. Smoothing: Chaikin corner cutting.

export const LINE_DEFAULTS = { depth: 0.5, thickness: 0.35, continuous: true, sensitivity: 0.6, wrap: 0.35, cloud: 0.6 };
// The connecting thread and the wrapping are finer than the drawn line, so the drawing still reads.
const CONNECTOR = 0.4;
const WRAP = 0.5;

/** How far the surface is pushed out of the drawing plane, from the depth slider. */
export const depthScale = (depth) => 0.25 + 1.75 * clamp01(depth ?? LINE_DEFAULTS.depth);

/**
 * Find the drawn strokes as polylines in image pixels.
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img RGBA, ~400 px
 * @returns {Array<Array<[number, number]>>}
 */
export function extractStrokes(img, opts = {}) {
  const W = img.width, H = img.height, src = img.data, N = W * H;
  // Sensitivity: higher finds fainter and shorter lines (and more noise).
  const sens = clamp01(opts.sensitivity ?? LINE_DEFAULTS.sensitivity);
  const darkness = 0.62 - 0.42 * sens;          // 0.62 .. 0.20 darker than the paper
  const minBlob = Math.round(14 - 11 * sens);   // 14 .. 3 pixels
  const minLength = 16 - 13 * sens;             // 16 .. 3 pixels

  // Background: median of the border. Ink: clearly darker than the paper.
  const br = [], bgc = [], bb = [];
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) push(x, y);
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) push(x, y);
  function push(x, y) { const i = (y * W + x) * 4; br.push(src[i]); bgc.push(src[i + 1]); bb.push(src[i + 2]); }
  const med = (a) => a.sort((m, n) => m - n)[a.length >> 1];
  const bgLum = 0.299 * med(br) + 0.587 * med(bgc) + 0.114 * med(bb);

  let ink = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    const lum = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    if (bgLum > 1 && (bgLum - lum) / bgLum > darkness) ink[p] = 1;
  }
  for (let x = 0; x < W; x++) { ink[x] = 0; ink[(H - 1) * W + x] = 0; }
  for (let y = 0; y < H; y++) { ink[y * W] = 0; ink[y * W + W - 1] = 0; }

  ink = removeSmall(ink, W, H, minBlob);
  const skel = thin(ink, W, H);
  let lines = trace(skel, W, H);
  lines = pruneSpurs(lines, W, H);
  lines = mergeTouching(lines, W, H);
  return lines
    .filter((l) => l.length >= 3)
    .map((l) => rdp(l, 0.8))
    .filter((l) => l.length >= 2 && pathLength(l) >= minLength);
}

/**
 * Lift 2D strokes into 3D and join them.
 * @param strokes   polylines in stroke-image pixels
 * @param map       { sw, sh } size of the stroke image
 * @param heightAt  (u, v) => depth of the body surface at normalised image coords (world units)
 * @param toWorld   (u, v) => [x, y] world coords for normalised image coords
 * @returns {Array<Array<[number,number,number]>>} 3D paths (one when continuous)
 */
export function liftStrokes(strokes, map, heightAt, toWorld, opts = {}) {
  const continuous = opts.continuous ?? LINE_DEFAULTS.continuous;
  const k = depthScale(opts.depth);
  const extra = opts.extra || []; // already 3D paths, e.g. the wrapping loops
  let zmax = 0;

  const lifted = strokes.map((l) => l.map(([x, y]) => {
    const u = x / (map.sw - 1), v = y / (map.sh - 1);
    const [X, Y] = toWorld(u, v);
    const z = heightAt(u, v) * k;
    if (z > zmax) zmax = z;
    return [X, Y, z, 1];
  }));
  for (const e of extra) for (const p of e) if (p[2] > zmax) zmax = p[2];
  const all = lifted.concat(extra);
  if (!continuous || all.length < 2) return all.map((p) => chaikin(p, 2));

  // Greedy chain: always continue to the nearest free stroke end, reversing it if needed.
  const left = all.slice();
  const order = [left.shift()];
  while (left.length) {
    const tail = order[order.length - 1].at(-1);
    let best = 0, flip = false, bd = Infinity;
    left.forEach((s, i) => {
      const d0 = dist3(tail, s[0]), d1 = dist3(tail, s.at(-1));
      if (d0 < bd) { bd = d0; best = i; flip = false; }
      if (d1 < bd) { bd = d1; best = i; flip = true; }
    });
    const next = left.splice(best, 1)[0];
    order.push(flip ? next.slice().reverse() : next);
  }

  // Connectors wind around the back of the body, so the thread wraps the form like yarn.
  const back = Math.max(zmax, 0.05) * 1.1;
  const path = [];
  order.forEach((s, i) => {
    if (i > 0) {
      const a = path.at(-1), b = s[0];
      const gap = dist3(a, b);
      if (gap > 1e-4) {
        const steps = Math.max(4, Math.ceil(gap / 0.04));
        for (let t = 1; t < steps; t++) {
          const f = t / steps;
          const dip = Math.sin(Math.PI * f) * Math.min(back, 0.3 + gap * 0.6);
          path.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f - dip, CONNECTOR]);
        }
      }
    }
    for (const p of s) path.push(p);
  });
  return [chaikin(path, path.length > 4000 ? 1 : 2)];
}

/**
 * Wrapping: loops that run across the front of the body, over the rim and back across the
 * back, at many angles, like yarn wound around a form. They give the line sculpture its volume.
 * @param a      { mask, W, H } of the analysed silhouette (grid pixels)
 * @param zAt    (gx, gy) => surface depth in world units (>= 0)
 * @param toW    (gx, gy) => [x, y] world coords
 * @returns {Array<Array<[x,y,z,w]>>}
 */
export function wrapLoops(a, zAt, toW, opts = {}) {
  const amount = clamp01(opts.wrap ?? LINE_DEFAULTS.wrap);
  const count = Math.round(amount * 64);
  const lift = opts.lift || 0;
  if (!count) return [];
  const { mask, W, H } = a;
  let cx = 0, cy = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { cx += x; cy += y; n++; }
  if (!n) return [];
  cx /= n; cy /= n;
  const inside = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < W && yi < H && mask[yi * W + xi] === 1; };
  const reach = Math.hypot(W, H);
  const loops = [];
  for (let i = 0; i < count; i++) {
    // Angles and offsets from low-discrepancy sequences: even coverage, no visible pattern.
    const theta = ((i * 0.6180339887) % 1) * Math.PI;
    const dx = Math.cos(theta), dy = Math.sin(theta), nxv = -dy, nyv = dx;
    let lo = Infinity, hi = -Infinity;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (mask[y * W + x]) {
      const t = (x - cx) * nxv + (y - cy) * nyv;
      if (t < lo) lo = t; if (t > hi) hi = t;
    }
    const off = lo + (hi - lo) * (0.06 + 0.88 * ((i * 0.7548776662 + 0.31) % 1));
    // Longest run of the line inside the shape.
    let best = null, run = null;
    for (let sPos = -reach; sPos <= reach; sPos += 1.5) {
      const x = cx + nxv * off + dx * sPos, y = cy + nyv * off + dy * sPos;
      if (inside(x, y)) { if (!run) run = []; run.push([x, y]); }
      else if (run) { if (!best || run.length > best.length) best = run; run = null; }
    }
    if (run && (!best || run.length > best.length)) best = run;
    if (!best || best.length < 5) continue;
    const front = best.map(([x, y]) => { const [X, Y] = toW(x, y); return [X, Y, zAt(x, y) + lift, WRAP]; });
    const back = best.slice().reverse().map(([x, y]) => { const [X, Y] = toW(x, y); return [X, Y, -zAt(x, y) - lift, WRAP]; });
    loops.push(front.concat(back, [front[0]]));
  }
  return loops;
}

/**
 * Closed tube around each path (end caps included), as one indexed mesh. Printable as wire.
 * @returns {{positions:Float32Array, indices:Uint32Array, weight:Float32Array, triangles:number, length:number}}
 * weight per vertex: 1 on drawn strokes, lower on wrapping and connecting thread.
 */
export function tubeMesh(paths, radius, radial = 8) {
  const pos = [], idx = [], wt = [];
  let total = 0;
  for (const raw of paths) {
    const P = dedupe(raw);
    if (P.length < 2) continue;
    total += pathLength(P);
    const n = P.length;
    // Tangents and parallel-transport frames (no twisting).
    const T = P.map((_, i) => norm(sub(P[Math.min(n - 1, i + 1)], P[Math.max(0, i - 1)])));
    let N0 = Math.abs(T[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    N0 = norm(sub(N0, scale(T[0], dot(N0, T[0]))));
    const base = pos.length / 3;
    let Nv = N0;
    for (let i = 0; i < n; i++) {
      if (i > 0) { Nv = norm(sub(Nv, scale(T[i], dot(Nv, T[i])))); if (!Number.isFinite(Nv[0])) Nv = N0; }
      const B = cross(T[i], Nv);
      for (let j = 0; j < radial; j++) {
        const r = radius * (P[i][3] ?? 1);
        const a = (j / radial) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
        pos.push(P[i][0] + Nv[0] * c + B[0] * s, P[i][1] + Nv[1] * c + B[1] * s, P[i][2] + Nv[2] * c + B[2] * s);
        wt.push(P[i][3] ?? 1);
      }
    }
    const ring = (i, j) => base + i * radial + (j % radial);
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
      const a = ring(i, j), b = ring(i, j + 1), c = ring(i + 1, j), d = ring(i + 1, j + 1);
      idx.push(a, b, c, b, d, c);
    }
    const s0 = pos.length / 3; pos.push(P[0][0], P[0][1], P[0][2]); wt.push(P[0][3] ?? 1);
    const s1 = pos.length / 3; pos.push(P[n - 1][0], P[n - 1][1], P[n - 1][2]); wt.push(P[n - 1][3] ?? 1);
    for (let j = 0; j < radial; j++) {
      idx.push(s0, ring(0, j + 1), ring(0, j));
      idx.push(s1, ring(n - 1, j), ring(n - 1, j + 1));
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), weight: new Float32Array(wt), triangles: idx.length / 3, length: total };
}

/* ---------- skeleton and tracing ---------- */

// Zhang-Suen thinning: reduces strokes to one-pixel-wide centre lines.
function thin(m, W, H) {
  const a = m.slice();
  let changed = true;
  const nb = (p) => [a[p - W], a[p - W + 1], a[p + 1], a[p + W + 1], a[p + W], a[p + W - 1], a[p - 1], a[p - W - 1]];
  while (changed) {
    changed = false;
    for (const step of [0, 1]) {
      const del = [];
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        if (!a[p]) continue;
        const n = nb(p);
        const B = n.reduce((s, v) => s + v, 0);
        if (B < 2 || B > 6) continue;
        let A = 0;
        for (let k = 0; k < 8; k++) if (!n[k] && n[(k + 1) % 8]) A++;
        if (A !== 1) continue;
        if (step === 0 ? (n[0] * n[2] * n[4] || n[2] * n[4] * n[6]) : (n[0] * n[2] * n[6] || n[0] * n[4] * n[6])) continue;
        del.push(p);
      }
      if (del.length) changed = true;
      for (const p of del) a[p] = 0;
    }
  }
  return a;
}

// Walk the skeleton graph into polylines, from endpoints and junctions, then remaining loops.
function trace(s, W, H) {
  const OFF = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
  const nbrs = (p) => OFF.map((o) => p + o).filter((q) => q >= 0 && q < s.length && s[q] && Math.abs((q % W) - (p % W)) <= 1);
  const deg = new Uint8Array(s.length);
  for (let p = 0; p < s.length; p++) if (s[p]) deg[p] = nbrs(p).length;
  const used = new Set();
  const ek = (a, b) => (a < b ? a * s.length + b : b * s.length + a);
  const lines = [];
  const walk = (start, next) => {
    const line = [start, next];
    used.add(ek(start, next));
    let prev = start, cur = next;
    while (deg[cur] === 2) {
      const n = nbrs(cur).find((q) => q !== prev && !used.has(ek(cur, q)));
      if (n === undefined) break;
      used.add(ek(cur, n));
      line.push(n);
      prev = cur; cur = n;
    }
    return line;
  };
  for (let p = 0; p < s.length; p++) {
    if (!s[p] || deg[p] === 2) continue;
    for (const q of nbrs(p)) if (!used.has(ek(p, q))) lines.push(walk(p, q));
  }
  for (let p = 0; p < s.length; p++) {
    if (!s[p] || deg[p] !== 2) continue;
    for (const q of nbrs(p)) if (!used.has(ek(p, q))) lines.push(walk(p, q));
  }
  return lines.map((l) => l.map((p) => [p % W, (p / W) | 0]));
}

// Short side branches of the skeleton (from line thickness, not from the drawing) are removed.
function pruneSpurs(lines, W, H) {
  const owner = new Int32Array(W * H).fill(-1);
  lines.forEach((l, i) => { for (const [x, y] of l) owner[y * W + x] = i; });
  const touchesOther = (e, i) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = e[0] + dx, y = e[1] + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const o = owner[y * W + x];
      if (o >= 0 && o !== i) return true;
    }
    return false;
  };
  return lines.filter((l, i) => pathLength(l) >= 7 || !(touchesOther(l[0], i) || touchesOther(l.at(-1), i)));
}

// Strokes cut at skeleton junctions are joined again where they continue in the same direction.
// Candidate end pairs come from a grid, best continuations are linked first (no cycles).
function mergeTouching(lines, W, H) {
  const R = 3.5, cell = 4;
  const dir = (l, atEnd) => {
    const a = atEnd ? l.at(-1) : l[0], b = atEnd ? l[Math.max(0, l.length - 5)] : l[Math.min(l.length - 1, 4)];
    const d = [a[0] - b[0], a[1] - b[1]], n = Math.hypot(...d) || 1;
    return [d[0] / n, d[1] / n];
  };
  const ends = [];
  lines.forEach((l, i) => { ends.push({ i, atEnd: false, p: l[0], d: dir(l, false) }, { i, atEnd: true, p: l.at(-1), d: dir(l, true) }); });
  const grid = new Map();
  ends.forEach((e, k) => { const key = Math.floor(e.p[0] / cell) + ',' + Math.floor(e.p[1] / cell); (grid.get(key) || grid.set(key, []).get(key)).push(k); });
  const pairs = [];
  ends.forEach((e, k) => {
    const gx = Math.floor(e.p[0] / cell), gy = Math.floor(e.p[1] / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const m of grid.get((gx + a) + ',' + (gy + b)) || []) {
      if (m <= k) continue;
      const f = ends[m];
      if (f.i === e.i || dist3(e.p, f.p) > R) continue;
      const straight = -(e.d[0] * f.d[0] + e.d[1] * f.d[1]);
      if (straight >= 0.3) pairs.push([straight, k, m]);
    }
  });
  pairs.sort((x, y) => y[0] - x[0]);
  const link = new Int32Array(ends.length).fill(-1);
  const parent = lines.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const [, k, m] of pairs) {
    if (link[k] >= 0 || link[m] >= 0) continue;
    const ra = find(ends[k].i), rb = find(ends[m].i);
    if (ra === rb) continue;
    link[k] = m; link[m] = k; parent[ra] = rb;
  }
  // Walk the chains: start at a line end that is not linked.
  const seen = new Uint8Array(lines.length);
  const out = [];
  const walkFrom = (i, enterAtEnd) => {
    let chain = [];
    let cur = i, fromEnd = enterAtEnd;
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1;
      const l = fromEnd ? lines[cur].slice().reverse() : lines[cur];
      chain = chain.concat(chain.length ? l.slice(1) : l);
      const exitK = 2 * cur + (fromEnd ? 0 : 1); // the far end we leave through
      const nk = link[exitK];
      if (nk < 0) break;
      cur = ends[nk].i;
      fromEnd = ends[nk].atEnd;
    }
    return chain;
  };
  lines.forEach((_, i) => { if (!seen[i] && link[2 * i] < 0) out.push(walkFrom(i, false)); });
  lines.forEach((_, i) => { if (!seen[i] && link[2 * i + 1] < 0) out.push(walkFrom(i, true)); });
  lines.forEach((_, i) => { if (!seen[i]) out.push(walkFrom(i, false)); });
  return out.filter((c) => c.length);
}

function removeSmall(m, W, H, min) {
  const seen = new Uint8Array(m.length);
  const out = new Uint8Array(m.length);
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || seen[s]) continue;
    const comp = [s]; seen[s] = 1;
    for (let i = 0; i < comp.length; i++) {
      const p = comp[i], x = p % W, y = (p / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (m[q] && !seen[q]) { seen[q] = 1; comp.push(q); }
      }
    }
    if (comp.length >= min) for (const p of comp) out[p] = 1;
  }
  return out;
}

/* ---------- geometry helpers ---------- */
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts.at(-1)];
  let idx = 0, max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], a, b);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [a, b];
  return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function chaikin(p, iterations) {
  let a = p;
  for (let k = 0; k < iterations && a.length > 2; k++) {
    const out = [a[0]];
    for (let i = 0; i < a.length - 1; i++) {
      const u = a[i], v = a[i + 1];
      out.push(u.map((c, j) => 0.75 * c + 0.25 * v[j]), u.map((c, j) => 0.25 * c + 0.75 * v[j]));
    }
    out.push(a.at(-1));
    a = out;
  }
  return a;
}
function dedupe(p) {
  const out = [];
  for (const q of p) if (!out.length || dist3(out.at(-1), q) > 1e-6) out.push(q);
  return out;
}
function pathLength(p) { let s = 0; for (let i = 1; i < p.length; i++) s += dist3(p[i], p[i - 1]); return s; }
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0));
