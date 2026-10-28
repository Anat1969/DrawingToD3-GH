// Line sculpture engine, pure functions (no DOM, testable in Node).
// A drawing's ink becomes one continuous line in 3D space, like a wire sculpture or a wound
// ball of yarn. Reading of the drawing:
//   - outline strokes lie on the rim of the body (depth near 0),
//   - inner strokes lie on the front of the body (depth from the inflated silhouette),
//   - all strokes are joined into one thread that winds around the back between strokes.
// Skeleton: Zhang & Suen thinning (Communications of the ACM, 1984).
// Simplification: Ramer-Douglas-Peucker. Smoothing: Chaikin corner cutting.

export const LINE_DEFAULTS = { depth: 0.5, thickness: 0.35, continuous: true };
// The connecting thread is finer than the drawn line, so the drawing still reads from the front.
const CONNECTOR = 0.4;

/**
 * Find the drawn strokes as polylines in image pixels.
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img RGBA, ~400 px
 * @returns {Array<Array<[number, number]>>}
 */
export function extractStrokes(img) {
  const W = img.width, H = img.height, src = img.data, N = W * H;

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
    if (bgLum > 1 && (bgLum - lum) / bgLum > 0.42) ink[p] = 1;
  }
  for (let x = 0; x < W; x++) { ink[x] = 0; ink[(H - 1) * W + x] = 0; }
  for (let y = 0; y < H; y++) { ink[y * W] = 0; ink[y * W + W - 1] = 0; }

  ink = removeSmall(ink, W, H, 10);
  const skel = thin(ink, W, H);
  let lines = trace(skel, W, H);
  lines = pruneSpurs(lines);
  lines = mergeTouching(lines);
  return lines
    .filter((l) => l.length >= 5)
    .map((l) => rdp(l, 0.9))
    .filter((l) => l.length >= 2 && pathLength(l) >= 10);
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
  const depth = clamp01(opts.depth ?? LINE_DEFAULTS.depth);
  const continuous = opts.continuous ?? LINE_DEFAULTS.continuous;
  const k = 0.25 + 1.75 * depth;
  let zmax = 0;

  const lifted = strokes.map((l) => l.map(([x, y]) => {
    const u = x / (map.sw - 1), v = y / (map.sh - 1);
    const [X, Y] = toWorld(u, v);
    const z = heightAt(u, v) * k;
    if (z > zmax) zmax = z;
    return [X, Y, z, 1];
  }));
  if (!continuous || lifted.length < 2) return lifted.map((p) => chaikin(p, 2));

  // Greedy chain: always continue to the nearest free stroke end, reversing it if needed.
  const left = lifted.slice();
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
  return [chaikin(path, 2)];
}

/**
 * Closed tube around each path (end caps included), as one indexed mesh. Printable as wire.
 * @returns {{positions:Float32Array, indices:Uint32Array, triangles:number, length:number}}
 */
export function tubeMesh(paths, radius, radial = 8) {
  const pos = [], idx = [];
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
      }
    }
    const ring = (i, j) => base + i * radial + (j % radial);
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
      const a = ring(i, j), b = ring(i, j + 1), c = ring(i + 1, j), d = ring(i + 1, j + 1);
      idx.push(a, b, c, b, d, c);
    }
    const s0 = pos.length / 3; pos.push(P[0][0], P[0][1], P[0][2]);
    const s1 = pos.length / 3; pos.push(P[n - 1][0], P[n - 1][1], P[n - 1][2]);
    for (let j = 0; j < radial; j++) {
      idx.push(s0, ring(0, j + 1), ring(0, j));
      idx.push(s1, ring(n - 1, j), ring(n - 1, j + 1));
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), triangles: idx.length / 3, length: total };
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
function pruneSpurs(lines) {
  const ends = (l) => [l[0], l.at(-1)];
  return lines.filter((l, i) => {
    if (pathLength(l) >= 7) return true;
    const touching = ends(l).filter((e) => lines.some((o, j) => j !== i && o.some((q) => dist3(e, q) <= 1.5)));
    return touching.length === 0; // keep an isolated short mark, drop a spur
  });
}

// Strokes cut at skeleton junctions are joined again where they continue in the same direction.
function mergeTouching(input) {
  const lines = input.map((l) => l.slice());
  const dir = (l, atEnd) => {
    const a = atEnd ? l.at(-1) : l[0], b = atEnd ? l[Math.max(0, l.length - 5)] : l[Math.min(l.length - 1, 4)];
    const d = [a[0] - b[0], a[1] - b[1]], n = Math.hypot(...d) || 1;
    return [d[0] / n, d[1] / n]; // pointing out of the stroke
  };
  for (let guard = 0; guard < 2000; guard++) {
    let best = null;
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      for (const ei of [false, true]) for (const ej of [false, true]) {
        const pi = ei ? lines[i].at(-1) : lines[i][0], pj = ej ? lines[j].at(-1) : lines[j][0];
        if (dist3(pi, pj) > 3.5) continue;
        const di = dir(lines[i], ei), dj = dir(lines[j], ej);
        const straight = -(di[0] * dj[0] + di[1] * dj[1]); // 1 when the two continue each other
        if (straight < 0.3) continue;
        if (!best || straight > best.straight) best = { i, j, ei, ej, straight };
      }
    }
    if (!best) break;
    const a = best.ei ? lines[best.i] : lines[best.i].slice().reverse();
    const b = best.ej ? lines[best.j].slice().reverse() : lines[best.j];
    lines[best.i] = a.concat(b);
    lines.splice(best.j, 1);
  }
  return lines;
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
