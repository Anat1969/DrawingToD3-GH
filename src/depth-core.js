// One depth map for every kind of picture (pure functions, no DOM, testable in Node).
// Anat, 2.11.2026: "different categories for photo, drawing and sculpture, each with its own way
// of learning depth, and still diffusion: a full connection with the depth".
//
// Each category gives depth only where its cue is sure of itself (anchors with a confidence).
// Diffusion carries that depth to every pixel, guided by the picture: depth flows freely inside a
// colour patch and stops at an edge. Method: propagation guided by the image, as in
// "Colorization using Optimization" (Levin, Lischinski & Weiss, SIGGRAPH 2004), solved coarse to
// fine. The result has no holes and no gaps: near and far are joined by a continuous surface.

export const CATEGORIES = {
  drawing: { cue: 'silhouette', source: 'Teddy (Igarashi et al., 1999)' },
  sculpture: { cue: 'shading', source: 'shape from shading on a cloudy day (Langer & Zucker, 1994)' },
  landscape: { cue: 'horizon', source: 'Tour Into the Picture (Horry, Anjyo & Arai, 1997)' },
  photo: { cue: 'focus', source: 'depth from focus (Nayar & Nakagawa, 1994)' },
};

/** Luminance (0..255) of RGBA pixels. */
export function luminance(img) {
  const { width: W, height: H, data } = img, L = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) { const i = p * 4; L[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }
  return L;
}

/**
 * Edge-aware diffusion of sparse depth.
 * @param target  Float32Array depth wished at each pixel (0 far .. 1 near), used where conf > 0
 * @param conf    Float32Array confidence 0..1 of each target value
 * @param guide   Float32Array image values (luminance) that say where edges are
 * @param opts    { sigma: edge softness in guide units, iterations per level, levels }
 * @returns Float32Array dense depth, every pixel filled
 */
export function diffuseDepth(target, conf, guide, W, H, opts = {}) {
  const sigma = opts.sigma ?? 14;
  const iters = opts.iterations ?? 80;
  // Pyramid: average target*conf, conf and guide by 2 until small.
  const levels = [{ W, H, t: target, c: conf, g: guide }];
  while (Math.max(levels.at(-1).W, levels.at(-1).H) > 10 && levels.length < (opts.levels ?? 9)) {
    const a = levels.at(-1), w = Math.ceil(a.W / 2), h = Math.ceil(a.H / 2);
    const t = new Float32Array(w * h), c = new Float32Array(w * h), g = new Float32Array(w * h), n = new Float32Array(w * h);
    for (let y = 0; y < a.H; y++) for (let x = 0; x < a.W; x++) {
      const p = y * a.W + x, q = (y >> 1) * w + (x >> 1);
      t[q] += a.t[p] * a.c[p]; n[q] += a.c[p]; if (a.c[p] > c[q]) c[q] = a.c[p]; g[q] += a.g[p];
    }
    // The coarse anchor keeps the strongest confidence under it: a lone sure point stays sure.
    for (let q = 0; q < w * h; q++) { t[q] = n[q] > 1e-6 ? t[q] / n[q] : 0; }
    for (let q = 0; q < w * h; q++) g[q] /= 4;
    levels.push({ W: w, H: h, t, c, g });
  }
  let D = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const { W: w, H: h, t, c, g } = levels[li];
    // Start from the coarser solution (or the mean of the anchors at the top).
    let d = new Float32Array(w * h);
    if (D) {
      const up = levels[li + 1];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = D[Math.min(up.H - 1, y >> 1) * up.W + Math.min(up.W - 1, x >> 1)];
    } else {
      let s = 0, n = 0;
      for (let p = 0; p < w * h; p++) { s += t[p] * c[p]; n += c[p]; }
      d.fill(n > 0 ? s / n : 0.5);
    }
    // Neighbour weights: similar guide values pass depth on, an edge blocks it.
    const wr = new Float32Array(w * h), wd = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (x < w - 1) wr[p] = Math.exp(-((g[p] - g[p + 1]) ** 2) / (2 * sigma * sigma));
      if (y < h - 1) wd[p] = Math.exp(-((g[p] - g[p + w]) ** 2) / (2 * sigma * sigma));
    }
    const lambda = 1.0;
    const n = li === 0 ? iters : Math.round(iters * 0.6);
    // Gauss-Seidel, alternating sweep direction: depth travels both ways in one pass.
    for (let it = 0; it < n; it++) {
      const rev = it % 2 === 1;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const y = rev ? h - 1 - yy : yy, x = rev ? w - 1 - xx : xx, p = y * w + x;
        let num = c[p] * t[p] * 4, den = c[p] * 4;
        if (x > 0) { num += lambda * wr[p - 1] * d[p - 1]; den += lambda * wr[p - 1]; }
        if (x < w - 1) { num += lambda * wr[p] * d[p + 1]; den += lambda * wr[p]; }
        if (y > 0) { num += lambda * wd[p - w] * d[p - w]; den += lambda * wd[p - w]; }
        if (y < h - 1) { num += lambda * wd[p] * d[p + w]; den += lambda * wd[p]; }
        if (den > 1e-9) d[p] = num / den;
      }
    }
    D = d;
  }
  return D;
}

/**
 * Photograph: focus as depth anchors. Sharp is near (1), clearly blurred is far (0), the soft
 * middle is left to the diffusion; the sharp subject itself is held near with full confidence.
 * @param F     focus 0..1 per pixel
 * @param near  optional Uint8Array mask of the sharp subject
 */
export const PHOTO_SIGMA = 40; // softer edges for photographs: depth crosses from the subject into its surroundings
export function photoAnchors(F, near = null) {
  const N = F.length, t = new Float32Array(N), c = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    if (near && near[p]) { t[p] = 1; c[p] = 1; continue; }
    const f = F[p];
    if (f > 0.45) { t[p] = 1; c[p] = Math.min(1, (f - 0.45) * 3); continue; }
    // The amount of blur is itself a distance: a little blur is a little behind, a lot of blur
    // is far. Held gently, so the subject's depth flows out into the background and fades:
    // near and far are joined (the diffusion Anat asked for).
    t[p] = Math.pow(Math.max(0, f) / 0.45, 0.6) * 0.85;
    c[p] = 0.12;
  }
  return { target: t, conf: c };
}

/**
 * Sculpture photographed in soft light: the silhouette gives the body (inflation), and shading
 * gives the relief: under diffuse light a crease or a hollow is darker because it sees less of
 * the sky ("dark is deep", Langer & Zucker, 1994). Depth = body + relief, inside the silhouette.
 * @param L       luminance
 * @param mask    Uint8Array silhouette
 * @param dist    Float32Array distance to the outline (pixels), inside the mask
 * @returns {{target:Float32Array, conf:Float32Array}}
 */
export function sculptureAnchors(L, mask, dist, W, H, opts = {}) {
  const N = W * H;
  let dmax = 0;
  for (let p = 0; p < N; p++) if (mask[p] && dist[p] > dmax) dmax = dist[p];
  // Local mean of the luminance (box, radius ~ a tenth of the body), for the relief detail.
  // A narrow neighbourhood: only creases and hollows count; the light falling from one side
  // across the whole body must not read as depth (the body comes from the silhouette).
  const r = Math.max(2, Math.round(dmax * 0.12));
  const I = new Float64Array((W + 1) * (H + 1)), M = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let s = 0, m = 0; for (let x = 0; x < W; x++) { const p = y * W + x; s += mask[p] ? L[p] : 0; m += mask[p]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s; M[(y + 1) * (W + 1) + x + 1] = M[y * (W + 1) + x + 1] + m; } }
  const box = (A, x0, y0, x1, y1) => A[y1 * (W + 1) + x1] - A[y0 * (W + 1) + x1] - A[y1 * (W + 1) + x0] + A[y0 * (W + 1) + x0];
  const relief = opts.relief ?? 0.35;
  const t = new Float32Array(N), c = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (!mask[p]) { t[p] = 0; c[p] = 1; continue; } // the background is the ground behind
    const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    const n = box(M, x0, y0, x1, y1) || 1, mean = box(I, x0, y0, x1, y1) / n;
    const body = Math.sqrt(Math.max(0, dist[p]) / Math.max(1, dmax));         // a rounded body (Teddy)
    // Only hollows: darker than around is deeper (it sees less sky). A brighter patch is mostly
    // the side the light comes from, not a bump, so it is left to the silhouette.
    const shade = Math.max(-1, Math.min(0, (L[p] - mean) / 50));
    t[p] = Math.max(0, Math.min(1, 0.15 + 0.7 * body + relief * 0.5 * shade * body));
    c[p] = 0.9;
  }
  return { target: t, conf: c };
}

/** Bilinear sample of a depth map at (u, v) in 0..1. */
export function sampleDepth(D, W, H, u, v) {
  const x = Math.max(0, Math.min(W - 1, u * (W - 1))), y = Math.max(0, Math.min(H - 1, v * (H - 1)));
  const x0 = Math.min(W - 2, Math.floor(x)), y0 = Math.min(H - 2, Math.floor(y)), fx = x - x0, fy = y - y0, p = y0 * W + x0;
  return (D[p] * (1 - fx) + D[p + 1] * fx) * (1 - fy) + (D[p + W] * (1 - fx) + D[p + W + 1] * fx) * fy;
}

/**
 * Contour lines of a depth map (marching squares), joined into polylines: the relief drawn as
 * lines of equal depth, like a topographic map or the courses of a wire sculpture.
 * @param levels  depth values to draw (0..1)
 * @param mask    optional Uint8Array: only inside it
 * @returns Array<Array<[x, y]>> in grid coordinates, each polyline at least minLength long
 */
export function isolines(D, W, H, levels, mask = null, minLength = 6) {
  const out = [];
  for (const L of levels) {
    const segs = [];
    const ip = (a, b) => (L - a) / ((b - a) || 1e-9);
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const p = y * W + x;
      if (mask && !(mask[p] && mask[p + 1] && mask[p + W] && mask[p + W + 1])) continue;
      const a = D[p], b = D[p + 1], c = D[p + W + 1], d = D[p + W];
      const k = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0);
      if (k === 0 || k === 15) continue;
      const T = [x + ip(a, b), y], R = [x + 1, y + ip(b, c)], B = [x + ip(d, c), y + 1], Lf = [x, y + ip(a, d)];
      const table = { 1: [[Lf, B]], 2: [[B, R]], 3: [[Lf, R]], 4: [[T, R]], 5: [[Lf, T], [B, R]], 6: [[T, B]], 7: [[Lf, T]], 8: [[Lf, T]], 9: [[T, B]], 10: [[Lf, B], [T, R]], 11: [[T, R]], 12: [[Lf, R]], 13: [[B, R]], 14: [[Lf, B]] };
      for (const s of table[k]) segs.push(s);
    }
    // Join segments that share an end (rounded keys) into polylines.
    const key = (q) => `${Math.round(q[0] * 1000)},${Math.round(q[1] * 1000)}`;
    const ends = new Map();
    segs.forEach((s, i) => { for (const e of [0, 1]) { const kk = key(s[e]); (ends.get(kk) || ends.set(kk, []).get(kk)).push(i); } });
    const used = new Uint8Array(segs.length);
    const grow = (line, at) => {
      for (;;) {
        const tip = line[line.length - 1];
        const next = (ends.get(key(tip)) || []).find((i) => !used[i]);
        if (next === undefined) return line;
        used[next] = 1;
        const s = segs[next];
        line.push(key(s[0]) === key(tip) ? s[1] : s[0]);
      }
    };
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      let line = grow([segs[i][0], segs[i][1]]);
      line = grow(line.reverse());
      let len = 0;
      for (let j = 1; j < line.length; j++) len += Math.hypot(line[j][0] - line[j - 1][0], line[j][1] - line[j - 1][1]);
      if (len >= minLength) out.push(line);
    }
  }
  return out;
}
