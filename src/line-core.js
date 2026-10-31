// Line sculpture engine, pure functions (no DOM, testable in Node).
// A drawing's ink becomes one continuous line in 3D space, like a wire sculpture or a wound
// ball of yarn. Reading of the drawing:
//   - outline strokes lie on the rim of the body (depth near 0),
//   - inner strokes lie on the front of the body (depth from the inflated silhouette),
//   - all strokes are joined into one thread that winds around the back between strokes.
// Skeleton: Zhang & Suen thinning (Communications of the ACM, 1984).
// Simplification: Ramer-Douglas-Peucker. Smoothing: Chaikin corner cutting.

export const LINE_DEFAULTS = { depth: 0.5, thickness: 0.35, continuous: true, sensitivity: 0.6, wrap: 0.35, cloud: 0.6 };
// One line: the drawn strokes, the connecting thread and the wrapping are the same line
// (same colour, same thickness). Anat, 29.10.2026: "one colour, no distinction".
const CONNECTOR = 1;
const WRAP = 1;

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

  // A line is darker than what is right around it, not just darker than the paper.
  // Brightness alone calls every saturated wash ink (pink hair is as dark as pencil) and
  // turns grey fills into thick blobs whose skeletons are staircases. So, as in adaptive
  // thresholding (Bradley & Roth, "Adaptive Thresholding Using the Integral Image", 2007):
  //   - local: the pixel is clearly darker than the mean of its neighbourhood (a line on any
  //     ground: a hair strand over orange, a face outline over skin);
  //   - colour: a saturated pixel is a wash, unless it is really dark;
  //   - solid: very dark neutral marks (a black marker) count even when wide.
  // Found on Anat's illustration of two girls hugging (31.10.2026): 41% of the "ink" was colour.
  const lum = new Float32Array(N), sat = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const i = p * 4, r = src[i], g = src[i + 1], b = src[i + 2];
    lum[p] = 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = Math.max(r, g, b);
    sat[p] = mx ? (mx - Math.min(r, g, b)) / mx : 0;
  }
  const rad = Math.max(3, Math.round(Math.max(W, H) / 140));
  const mean = boxMean(lum, W, H, rad);
  const localT = 0.42 - 0.34 * sens;                 // 0.42 .. 0.08 darker than the surroundings
  let ink = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    if (!(bgLum > 1)) break;
    const colour = sat[p] > 0.45 && lum[p] > 70;
    if (colour) continue;
    const local = (mean[p] - lum[p]) / Math.max(1, mean[p]);
    const solid = (bgLum - lum[p]) / bgLum > Math.max(darkness, 0.55) && sat[p] < 0.3;
    if (local > localT || solid) ink[p] = 1;
  }
  // Colour lines: a line is long and narrow whatever its colour (zebra stripes in magenta and
  // blue), a wash is wide (a head of pink hair). Morphological opening keeps the wide washes;
  // what colour remains outside them is a band, a line drawn with a brush (31.10.2026, zebras).
  if (opts.bands !== false) {
    const br0 = med(br.slice()), bg0 = med(bgc.slice()), bb0 = med(bb.slice());
    const colourT = 95 - 45 * sens;                     // distance from the paper colour
    const C = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
      const i = p * 4, dr = src[i] - br0, dg = src[i + 1] - bg0, db = src[i + 2] - bb0;
      if (sat[p] > 0.28 && dr * dr + dg * dg + db * db > colourT * colourT) C[p] = 1; // grey is pencil, handled above
    }
    const r = Math.max(3, Math.round(Math.max(W, H) / 60));
    const inside = chamferDist(C, W, H, 1);              // distance to the paper
    const core = new Uint8Array(N);
    for (let p = 0; p < N; p++) core[p] = inside[p] > r ? 1 : 0;
    const fromCore = chamferDist(core, W, H, 0);         // distance to a wide wash
    for (let p = 0; p < N; p++) if (C[p] && fromCore[p] > r + 0.5) ink[p] = 1;
  }
  for (let x = 0; x < W; x++) { ink[x] = 0; ink[(H - 1) * W + x] = 0; }
  for (let y = 0; y < H; y++) { ink[y * W] = 0; ink[y * W + W - 1] = 0; }

  ink = removeSmall(ink, W, H, minBlob);
  const skel = thin(ink, W, H);
  if (opts.debug) opts.debug({ ink, skel });
  // The drawing's own line weight: ink area over centre-line length, in pixels.
  let inkArea = 0, skelLen = 0;
  for (let p = 0; p < N; p++) { inkArea += ink[p]; skelLen += skel[p]; }
  // Capped at a pen's weight (relative to the page): a brush stripe is carried by the colour
  // spray, the wire marks only its centre line (31.10.2026, zebras came out too heavy).
  const lineWidth = skelLen ? Math.max(1, Math.min(Math.max(W, H) / 170, inkArea / skelLen)) : 2;
  let lines = trace(skel, W, H);
  lines = pruneSpurs(lines, W, H);
  lines = mergeTouching(lines, W, H);
  const out = lines
    .filter((l) => l.length >= 3)
    .map((l) => rdp(l, 0.8))
    .filter((l) => l.length >= 2 && pathLength(l) >= minLength);
  out.lineWidth = lineWidth;
  out.ink = ink;
  out.size = [W, H];
  return out;
}

/**
 * One thread through all the strokes, the way a one-line drawing is made by hand: to reach
 * the next line the pen runs back along lines already drawn instead of cutting across the
 * paper. Order: greedy nearest end. Each gap is routed by A* over the ink (cheap) and the
 * paper (expensive), so from the front the joins lie on the drawing.
 * @returns {{path:Array<[number,number]>, drawn:number, offInk:number}} pixel coords
 */
export function threadThroughInk(strokes, opts = {}) {
  if (!strokes.length) return { path: [], drawn: 0, offInk: 0 };
  const left = strokes.slice();
  // Start at the top: the drawing is read from the top down.
  let si = 0;
  left.forEach((l, i) => { if (Math.min(l[0][1], l.at(-1)[1]) < Math.min(left[si][0][1], left[si].at(-1)[1])) si = i; });
  let first = left.splice(si, 1)[0];
  if (first.at(-1)[1] < first[0][1]) first = first.slice().reverse();
  const path = first.map((p) => [p[0], p[1]]);
  let drawn = pathLength(first), offInk = 0;
  const route = makeRouter(strokes, opts);
  while (left.length) {
    const t = path.at(-1);
    let b = 0, flip = false, bd = Infinity;
    left.forEach((l, i) => {
      const d0 = Math.hypot(t[0] - l[0][0], t[1] - l[0][1]), d1 = Math.hypot(t[0] - l.at(-1)[0], t[1] - l.at(-1)[1]);
      if (d0 < bd) { bd = d0; b = i; flip = false; }
      if (d1 < bd) { bd = d1; b = i; flip = true; }
    });
    const next = left.splice(b, 1)[0];
    const l = flip ? next.slice().reverse() : next;
    if (bd > 2.5) {
      const r = route(t, l[0], bd);
      const hop = r || [t, l[0]];
      for (let i = 1; i < hop.length - 1; i++) path.push(hop[i]);
      offInk += r ? r.off : bd;
    }
    for (const p of l) path.push([p[0], p[1]]);
    drawn += pathLength(l);
  }
  return { path: simplifyRoute(path), drawn, offInk };
}

/**
 * A router over the drawing's ink (pixel coords of the stroke image): (a, b, gap?) => pixel
 * path with .off, or null. Short gaps on the full map, long ones coarse-to-fine.
 */
export function makeRouter(strokes, opts = {}) {
  const [W, H] = strokes.size || [0, 0];
  const ink = strokes.ink;
  const maxRoute = (opts.maxRoute ?? 0.75) * Math.max(W, H);
  // Long jumps are searched on a coarse map of the ink (3x smaller, 9x fewer pixels): a route
  // planner's coarse-to-fine step. A pixel of the coarse map is ink if any pixel under it is.
  const F = 3, cw = Math.ceil(W / F), ch = Math.ceil(H / F);
  let coarse = null;
  const coarseInk = () => {
    if (coarse) return coarse;
    coarse = new Uint8Array(cw * ch);
    if (ink) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink[y * W + x]) coarse[((y / F) | 0) * cw + ((x / F) | 0)] = 1;
    return coarse;
  };
  return (a, b, gap = Math.hypot(b[0] - a[0], b[1] - a[1])) => {
    if (!ink || gap >= maxRoute) return null;
    if (gap < 40) return routeOnInk(ink, W, H, a, b);
    const r = routeOnInk(coarseInk(), cw, ch, [a[0] / F, a[1] / F], [b[0] / F, b[1] / F]);
    if (!r) return routeOnInk(ink, W, H, a, b);
    const pts = r.map((q) => [q[0] * F + 1, q[1] * F + 1]);
    pts[0] = [a[0], a[1]];
    pts[pts.length - 1] = [b[0], b[1]];
    pts.off = r.off * F;
    return pts;
  };
}

// A* on the pixel grid: moving along ink costs 1, across paper 12. Diagonal steps cost sqrt 2.
// Returns the pixel path (smoothed a little) with .off = length that leaves the ink.
function routeOnInk(ink, W, H, a, b) {
  const PAPER = 12;
  const ax = Math.round(a[0]), ay = Math.round(a[1]), bx = Math.round(b[0]), by = Math.round(b[1]);
  const start = ay * W + ax, goal = by * W + bx;
  if (start === goal) return null;
  const g = new Float32Array(W * H).fill(Infinity);
  const from = new Int32Array(W * H).fill(-1);
  const heap = new MinHeap();
  const h = (p) => Math.hypot((p % W) - bx, ((p / W) | 0) - by);
  g[start] = 0;
  heap.push(start, h(start));
  const STEPS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  const gap = Math.hypot(bx - ax, by - ay);
  let budget = Math.max(5000, Math.min(150000, 40 * gap * gap)); // a long jump over bare paper is not worth a search of the page
  while (heap.size && budget-- > 0) {
    const p = heap.pop();
    if (p === goal) break;
    const x = p % W, y = (p / W) | 0;
    for (const [dx, dy, c] of STEPS) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const q = yy * W + xx;
      const ng = g[p] + c * (ink[q] ? 1 : PAPER);
      if (ng < g[q]) { g[q] = ng; from[q] = p; heap.push(q, ng + 2.5 * h(q)); } // weighted A*: near-best, much faster
    }
  }
  if (from[goal] < 0) return null;
  const pts = [];
  let off = 0;
  for (let p = goal; p >= 0; p = from[p]) {
    pts.push([p % W, (p / W) | 0]);
    if (!ink[p]) off += 1;
    if (p === start) break;
  }
  pts.reverse();
  pts.off = off;
  return pts;
}

// Pixel staircases from the routes are smoothed into the line: fewer points
// (Ramer-Douglas-Peucker), then corners cut (Chaikin), so a route reads as a hand's line.
function simplifyRoute(path) {
  return chaikin(rdp(path, 1.1).map((p) => [p[0], p[1], 0]), 1).map((p) => [p[0], p[1]]); // the next stage smooths once more
}

// Moving average of colours along a path, twice (a soft triangular window): transitions.
function smoothColours(C, r) {
  let a = C;
  for (let pass = 0; pass < 2; pass++) {
    const n = a.length, out = new Array(n), acc = [0, 0, 0];
    const pre = [[0, 0, 0]];
    for (let i = 0; i < n; i++) { acc[0] += a[i][0]; acc[1] += a[i][1]; acc[2] += a[i][2]; pre.push([acc[0], acc[1], acc[2]]); }
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - r), hi = Math.min(n, i + r + 1), k = hi - lo;
      out[i] = [(pre[hi][0] - pre[lo][0]) / k, (pre[hi][1] - pre[lo][1]) / k, (pre[hi][2] - pre[lo][2]) / k];
    }
    a = out;
  }
  return a;
}

/**
 * The colour of a drawing around its lines, for a coloured thread. For each pixel: the mean
 * colour of the washes nearby (saturated pixels, weighted by saturation), and how much wash
 * there is. A line over a pink wash takes the pink; a line over bare paper keeps the ink.
 * Short, very dark strokes (eyes, nostrils, a mouth) keep the ink: they are what the eye
 * recognises a picture by (Anat, 31.10.2026: colour, and the zebras' eyes).
 * @param img     RGBA pixels (~200 px)
 * @param marks   optional Uint8Array mask over img: where the ink stays ink
 * @returns (u, v) => [r, g, b] in 0..1, u and v in 0..1 over the picture
 */
export function threadColours(img, marks = null) {
  const { width: W, height: H, data } = img;
  const N = W * H, R = Math.max(2, Math.round(Math.max(W, H) / 45));
  const sr = new Float32Array(N), sg = new Float32Array(N), sb = new Float32Array(N), sw = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const i = p * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), sat = mx ? (mx - Math.min(r, g, b)) / mx : 0;
    const w = sat < 0.22 || mx < 50 ? 0 : sat;
    sr[p] = r * w; sg[p] = g * w; sb[p] = b * w; sw[p] = w;
  }
  const box = (v) => {
    const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += v[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
    const out = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
      out[y * W + x] = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
    return out;
  };
  const R2 = box(sr), G2 = box(sg), B2 = box(sb), S2 = box(sw);
  const INK = [0.1, 0.087, 0.067];
  return (u, v) => {
    const x = Math.max(0, Math.min(W - 1, Math.round(u * (W - 1)))), y = Math.max(0, Math.min(H - 1, Math.round(v * (H - 1))));
    const p = y * W + x;
    if (marks && marks[p]) return INK;
    const s = S2[p];
    if (s < 1e-4) return INK;
    // The wash colour, a little deeper so it holds as a line on the paper stage.
    const c = [R2[p] / s / 255 * 0.82, G2[p] / s / 255 * 0.82, B2[p] / s / 255 * 0.82];
    const k = Math.min(1, s * 2.2); // how much wash is around: paper keeps the ink
    return [INK[0] + (c[0] - INK[0]) * k, INK[1] + (c[1] - INK[1]) * k, INK[2] + (c[2] - INK[2]) * k];
  };
}

/** Where the ink stays ink: short, very dark strokes, drawn into a mask over a w x h grid. */
export function identityMarks(strokes, img, w, h) {
  const [SW, SH] = strokes.size || [w, h];
  const src = img.data, size = Math.max(SW, SH);
  const m = new Uint8Array(w * h);
  for (const s of strokes) {
    if (pathLength(s) > size * 0.09) continue;
    let lum = 0;
    for (const [x, y] of s) { const i = (Math.round(y) * SW + Math.round(x)) * 4; lum += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]; }
    if (lum / s.length > 75) continue;
    for (const [x, y] of s) {
      const gx = Math.round((x / (SW - 1)) * (w - 1)), gy = Math.round((y / (SH - 1)) * (h - 1));
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = gx + dx, yy = gy + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) m[yy * w + xx] = 1; }
    }
  }
  return m;
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const pa = (i - 1) >> 1;
      if (v[pa] <= val) break;
      k[i] = k[pa]; v[i] = v[pa]; i = pa;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = k[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && v[c + 1] < v[c]) c++;
        if (v[c] >= lv) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/**
 * Wire radius in world units from the drawing's own line weight, so a fine drawing gives a
 * fine wire and a marker drawing a thick one. The thickness slider scales around it
 * (0.35, the default, is the drawing's own weight; 0 is a quarter, 1 is about six times).
 */
export function wireRadius(lineWidthPx, pxToWorld, thickness = LINE_DEFAULTS.thickness) {
  const own = 0.5 * lineWidthPx * pxToWorld;
  const k = Math.pow(2, (clamp01(thickness) - 0.35) * 4);
  return Math.max(0.0025, Math.min(0.05, own * k));
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
  // The drawn strokes come first and the wrapping after, so the thread reads (and animates)
  // as drawing first, then winding the volume around it.
  const chain = (items, order) => {
    const left = items.slice();
    if (!order.length && left.length) order.push(left.shift());
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
    return order;
  };
  const order = chain(extra, chain(lifted, []));

  // Connectors wind around the back of the body, so the thread wraps the form like yarn.
  const back = Math.max(zmax, 0.05) * 1.1;
  const path = [];
  order.forEach((s, i) => {
    if (i > 0) {
      const a = path.at(-1), b = s[0];
      const gap = dist3(a, b);
      if (gap > 1e-4) {
        const steps = Math.max(4, Math.ceil(gap / 0.04));
        // Short hops stay on the surface (no back-and-forth zigzag); long jumps go round the back.
        const longJump = gap > 0.35;
        for (let t = 1; t < steps; t++) {
          const f = t / steps;
          // Long jumps pass through the volume in a gentle arc; short hops stay on the surface.
          const dip = longJump ? Math.sin(Math.PI * f) * Math.min(back * 0.8, 0.15 + gap * 0.35) : -Math.sin(Math.PI * f) * Math.min(0.03, gap * 0.2);
          path.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f - dip, CONNECTOR]);
        }
      }
    }
    for (const p of s) path.push(p);
  });
  return [chaikin(path, path.length > 4000 ? 1 : 2)];
}

/**
 * Wrapping as a whip stitch around the outline (Anat, 31.10.2026): the pen travels along the
 * outline of each part and winds round its edge, the way the edge of a cloth is bound. It comes
 * out in front just inside the outline, rounds the edge, passes behind, and returns through
 * the body. Seen from the front it stays near the outline, so the faces and the inner drawing
 * stay clear; seen from the side it binds front and back, which gives the volume.
 * Freehand: pitch, reach and lean drift slowly along the way, like a hand.
 * @param a    analysed silhouette { mask, W, H, dist? } (grid pixels)
 * @param zAt  (gx, gy) => surface depth in world units (>= 0)
 * @param toW  (gx, gy) => [x, y] world coords
 * @returns {Array<Array<[x,y,z,w]>>} one path per outline, with a `turns` count
 */
export function stitchLoops(a, zAt, toW, opts = {}) {
  const amount = clamp01(opts.wrap ?? LINE_DEFAULTS.wrap);
  const out = [];
  out.turns = 0;
  if (amount <= 0.001) return out;
  const { mask, W, H } = a;
  const D = blurField(a.dist || chamfer2(mask, W, H), mask, W, H, 3);
  // Outlines: the rim of the silhouette, thinned and traced into closed polylines.
  const rim = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const p = y * W + x;
    if (mask[p] && (!mask[p - 1] || !mask[p + 1] || !mask[p - W] || !mask[p + W])) rim[p] = 1;
  }
  const size = Math.max(W, H);
  const outlines = trace(thin(rim, W, H), W, H)
    .map((l) => chaikin(chaikin(l.map((q) => [q[0], q[1], 0]), 1), 1))
    .filter((l) => pathLength(l) > size * 0.12)
    .sort((m, n) => pathLength(n) - pathLength(m))
    .slice(0, 8);
  if (!outlines.length) return out;

  let seed = opts.seed || 20261031;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const wave = () => { const f = [0.013 + rnd() * 0.015, 0.04 + rnd() * 0.03, 0.09 + rnd() * 0.05], ph = [rnd() * 6.3, rnd() * 6.3, rnd() * 6.3]; return (t) => Math.sin(t * f[0] + ph[0]) * 0.55 + Math.sin(t * f[1] + ph[1]) * 0.3 + Math.sin(t * f[2] + ph[2]) * 0.15; };
  const wPitch = wave(), wReach = wave(), wLean = wave();
  const pitch0 = size * (0.165 - 0.125 * amount);      // pixels of outline per turn
  const reach0 = size * (0.022 + 0.02 * amount);       // how far the stitch bites into the body
  const lift = opts.lift || 0;
  const Dat = (x, y) => sampleField(D, W, H, x, y);

  for (const line of outlines) {
    // Arc length along the outline, and a lookup of position and inward normal by length.
    const P = line, n = P.length;
    const acc = [0];
    for (let i = 1; i < n; i++) acc.push(acc[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const total = acc[n - 1];
    let k = 0;
    const at = (s) => {
      while (k < n - 2 && acc[k + 1] < s) k++;
      while (k > 0 && acc[k] > s) k--;
      const f = Math.min(1, Math.max(0, (s - acc[k]) / Math.max(1e-6, acc[k + 1] - acc[k])));
      const x = P[k][0] + (P[k + 1][0] - P[k][0]) * f, y = P[k][1] + (P[k + 1][1] - P[k][1]) * f;
      let gx = Dat(x + 1.5, y) - Dat(x - 1.5, y), gy = Dat(x, y + 1.5) - Dat(x, y - 1.5);
      const g = Math.hypot(gx, gy);
      if (g < 1e-6) { const tx = P[k + 1][0] - P[k][0], ty = P[k + 1][1] - P[k][1], tl = Math.hypot(tx, ty) || 1; gx = -ty / tl; gy = tx / tl; } else { gx /= g; gy /= g; }
      return [x, y, gx, gy];
    };
    const path = [];
    let s = 0, theta = rnd() * Math.PI * 2, turns = 0;
    const pxWorld = Math.hypot(toW(1, 0)[0] - toW(0, 0)[0], toW(1, 0)[1] - toW(0, 0)[1]) || 1;
    while (s < total) {
      const pitch = pitch0 * (1 + 0.4 * wPitch(s));
      const reach = reach0 * (1 + 0.45 * wReach(s));
      const [x, y, nx, ny] = at(s);
      // Centre of the stitch just inside the edge; the thread swings out past the edge (cos)
      // and from front to back (sin). At theta = pi it passes through the body.
      const cx = x + nx * reach * 0.55, cy = y + ny * reach * 0.55;
      const out2 = -Math.cos(theta) * reach;
      const lean = wLean(s) * reach * 0.35 * Math.sin(theta);   // the hand leans along the edge
      const tx = -ny, ty = nx;
      const gx = cx + nx * out2 + tx * lean, gy = cy + ny * out2 + ty * lean;
      const depth = Math.max(zAt(cx + nx * reach * 0.6, cy + ny * reach * 0.6), 0.02) * 1.15;
      // A deep, narrow stitch turns hard at the edge: more points per turn keep it smooth.
      const perTurn = Math.max(18, Math.min(96, Math.round(9 * (depth + lift) / (reach * pxWorld))));
      const [X, Y] = toW(gx, gy);
      const z = Math.sin(theta) * (depth + lift);
      path.push([X, Y, z, WRAP]);
      theta += (Math.PI * 2) / perTurn;
      s += pitch / perTurn;
      if (theta > Math.PI * 2) { theta -= Math.PI * 2; turns++; }
    }
    if (path.length > 4) { out.push(path); out.turns += turns; }
  }
  return out;
}

/**
 * Wrapping as a freehand pen in space: one continuous gesture that winds around each part
 * of the figure (head, body, arm, balloon) along that part's own axis, sometimes on the
 * surface and sometimes through the volume, travelling along limbs, turning back at their
 * ends and crossing over to other parts. Nothing is a perfect circle: speed, radius and tilt
 * drift like a hand.
 * Reading of the shape: the medial axis (ridge of the distance-to-outline field) gives each
 * part's centre line; its direction comes from the Hessian of that field (the ridge runs
 * along the direction of least curvature).
 * @param a      analysed silhouette { mask, W, H, dist? } (grid pixels)
 * @param zAt    (gx, gy) => surface depth in world units (>= 0)
 * @param toW    (gx, gy) => [x, y] world coords
 * @returns {Array<Array<[x,y,z,w]>>} one path, with a `turns` count on the array
 */
export function wrapLoops(a, zAt, toW, opts = {}) {
  const amount = clamp01(opts.wrap ?? LINE_DEFAULTS.wrap);
  const turns = Math.round(amount * 44);
  const lift = opts.lift || 0;
  const out = [];
  out.turns = 0;
  if (!turns) return out;
  const { mask, W, H } = a;
  const D = blurField(a.dist || chamfer2(mask, W, H), mask, W, H, 3);
  let dmax = 0, start = -1;
  for (let p = 0; p < D.length; p++) if (D[p] > dmax) { dmax = D[p]; start = p; }
  if (start < 0 || dmax < 1.5) return out;

  // Smooth pseudo-random drift (sums of slow sines): the "hand".
  let seed = opts.seed || 20261029;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const wave = () => { const f = [0.011 + rnd() * 0.02, 0.031 + rnd() * 0.04, 0.07 + rnd() * 0.05], ph = [rnd() * 6.3, rnd() * 6.3, rnd() * 6.3]; return (t) => (Math.sin(t * f[0] + ph[0]) * 0.55 + Math.sin(t * f[1] + ph[1]) * 0.3 + Math.sin(t * f[2] + ph[2]) * 0.15); };
  const wSpeed = wave(), wRadius = wave(), wTilt = wave(), wAxial = wave(), wDepth = wave();

  const Dat = (x, y) => sampleField(D, W, H, x, y);
  const inMask = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < W && yi < H && mask[yi * W + xi] === 1; };
  // Direction of the part at (x, y): along the ridge, from the Hessian of the distance field.
  const axisAt = (x, y) => {
    const e = 2;
    const c0 = Dat(x, y);
    const dxx = (Dat(x + e, y) - 2 * c0 + Dat(x - e, y)) / (e * e);
    const dyy = (Dat(x, y + e) - 2 * c0 + Dat(x, y - e)) / (e * e);
    const dxy = (Dat(x + e, y + e) - Dat(x + e, y - e) - Dat(x - e, y + e) + Dat(x - e, y - e)) / (4 * e * e);
    const ang = 0.5 * Math.atan2(2 * dxy, dxx - dyy); // eigenvector of the larger eigenvalue
    return [Math.cos(ang), Math.sin(ang)];
  };
  // Pull a point back onto the centre line of its part, moving across the part only.
  const recentre = (c, g) => {
    for (let k = 0; k < 1; k++) { // at most one pixel per step: the hand does not jump
      const f = Dat(c[0] + g[0], c[1] + g[1]), b = Dat(c[0] - g[0], c[1] - g[1]), m = Dat(c[0], c[1]);
      if (f > m && f >= b) { c[0] += g[0]; c[1] += g[1]; } else if (b > m) { c[0] -= g[0]; c[1] -= g[1]; } else break;
    }
  };

  const c = [start % W, Math.floor(start / W)];
  let axis = axisAt(c[0], c[1]);
  let dir = 1, theta = rnd() * Math.PI * 2;
  const stepsPerTurn = 44;
  const N = turns * stepsPerTurn;
  let jump = null; // { from, to, k, n } while the pen crosses to another part
  const path = [];
  const cs = [c[0], c[1]];     // the centre the hand actually follows (with inertia)
  let Rs = Math.max(1.2, Dat(c[0], c[1]));
  let pen = null;
  for (let i = 0; i < N; i++) {
    let ax = axisAt(c[0], c[1]);
    if (ax[0] * axis[0] + ax[1] * axis[1] < 0) ax = [-ax[0], -ax[1]];
    axis = norm2([axis[0] * 0.92 + ax[0] * 0.08, axis[1] * 0.92 + ax[1] * 0.08]); // steady hand
    const g = [-axis[1], axis[0]];
    cs[0] += (c[0] - cs[0]) * 0.2; cs[1] += (c[1] - cs[1]) * 0.2;
    Rs += (Math.max(1.2, Dat(cs[0], cs[1])) - Rs) * 0.15;
    const R = Rs;
    // Radius factor below 1 passes through the volume, above 1 floats just outside it.
    const rf = 0.78 + 0.3 * wRadius(i);
    const tilt = 0.35 * wTilt(i);
    const off = R * rf * Math.cos(theta);
    const along = R * tilt * Math.sin(theta);
    const px = cs[0] + g[0] * off + axis[0] * along, py = cs[1] + g[1] * off + axis[1] * along;
    const depth = zAt(cs[0], cs[1]) * (0.82 + 0.28 * wDepth(i));
    const [X, Y] = toW(px, py);
    const target = [X, Y, (depth + lift) * Math.sin(theta)];
    // The pen follows its target with inertia, so corners become curves.
    pen = pen ? pen.map((v, j) => v + (target[j] - v) * 0.55) : target;
    path.push([pen[0], pen[1], pen[2], WRAP]);

    theta += ((Math.PI * 2) / stepsPerTurn) * (0.75 + 0.45 * (wSpeed(i) + 1) / 2);
    if (jump) {
      jump.k++;
      const f = jump.k / jump.n, e = f * f * (3 - 2 * f);
      c[0] = jump.from[0] + (jump.to[0] - jump.from[0]) * e;
      c[1] = jump.from[1] + (jump.to[1] - jump.from[1]) * e;
      if (jump.k >= jump.n) jump = null;
      continue;
    }
    // Travel along the part, faster on long thin parts, with the hand's own rhythm.
    const v = (0.12 + R * 0.025) * (0.6 + 0.8 * (wAxial(i) + 1) / 2);
    const nx = c[0] + axis[0] * v * dir, ny = c[1] + axis[1] * v * dir;
    if (!inMask(nx, ny) || Dat(nx, ny) < Math.max(1.2, R * 0.35)) { dir = -dir; } // end of the part: turn back
    else { c[0] = nx; c[1] = ny; recentre(c, g); }
    // Now and then cross over to another part of the figure, through the volume.
    if (i % (stepsPerTurn * 4) === stepsPerTurn * 2 && rnd() < 0.85) {
      let best = null;
      for (let t = 0; t < 60; t++) {
        const q = Math.floor(rnd() * W * H);
        if (!mask[q] || D[q] < dmax * 0.25) continue;
        const qx = q % W, qy = Math.floor(q / W), far = Math.hypot(qx - c[0], qy - c[1]);
        const score = far * (0.5 + D[q] / dmax);
        if (far > Math.hypot(W, H) * 0.12 && (!best || score > best.score)) best = { x: qx, y: qy, score };
      }
      if (best) jump = { from: [c[0], c[1]], to: [best.x, best.y], k: 0, n: Math.round(stepsPerTurn * 0.9) };
    }
  }
  out.push(path);
  out.turns = turns;
  return out;
}

function norm2(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }

function sampleField(F, W, H, x, y) {
  const x0 = Math.max(0, Math.min(W - 2, Math.floor(x))), y0 = Math.max(0, Math.min(H - 2, Math.floor(y)));
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  const p = y0 * W + x0;
  return (F[p] * (1 - fx) + F[p + 1] * fx) * (1 - fy) + (F[p + W] * (1 - fx) + F[p + W + 1] * fx) * fy;
}

function blurField(src, mask, W, H, passes) {
  let a = Float32Array.from(src);
  for (let k = 0; k < passes; k++) {
    const b = new Float32Array(a.length);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (!mask[p]) continue;
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const q = p + dy * W + dx; if (mask[q]) { s += a[q]; c++; } }
      b[p] = s / c;
    }
    a = b;
  }
  return a;
}

// Distance to the outline (chamfer 3-4) for callers that do not pass one.
function chamfer2(mask, W, H) {
  const d = new Float32Array(mask.length);
  for (let p = 0; p < mask.length; p++) d[p] = mask[p] ? 1e9 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; if (!d[p]) continue;
    let v = d[p];
    if (x > 0) v = Math.min(v, d[p - 1] + 3);
    if (y > 0) { v = Math.min(v, d[p - W] + 3); if (x > 0) v = Math.min(v, d[p - W - 1] + 4); if (x < W - 1) v = Math.min(v, d[p - W + 1] + 4); }
    d[p] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const p = y * W + x; if (!d[p]) continue;
    let v = d[p];
    if (x < W - 1) v = Math.min(v, d[p + 1] + 3);
    if (y < H - 1) { v = Math.min(v, d[p + W] + 3); if (x < W - 1) v = Math.min(v, d[p + W + 1] + 4); if (x > 0) v = Math.min(v, d[p + W - 1] + 4); }
    d[p] = v;
  }
  for (let p = 0; p < d.length; p++) d[p] /= 3;
  return d;
}

/**
 * Closed tube around each path (end caps included), as one indexed mesh. Printable as wire.
 * @returns {{positions:Float32Array, indices:Uint32Array, weight:Float32Array, triangles:number, length:number}}
 * weight per vertex: 1 on drawn strokes, lower on wrapping and connecting thread.
 */
export function tubeMesh(paths, radius, radial = 8, opts = {}) {
  const pos = [], idx = [], wt = [], col = [];
  // Colour along the thread (opts.colorAt: point => [r, g, b] in 0..1), smoothed along the
  // path so it passes from colour to colour without steps: pink hair into orange.
  const colorAt = opts.colorAt || null;
  const blend = opts.colorBlend ?? 6;
  // Timeline for drawing the thread: after each segment, how many indices are visible,
  // the time spent so far (drawn line slow like a pen, thread and wrapping faster), and the tip.
  const tlEnd = [], tlTime = [], tlTip = [];
  let clock = 0;
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
    let C = null;
    if (colorAt) {
      C = smoothColours(P.map((q) => colorAt(q)), blend);
    }
    let Nv = N0;
    for (let i = 0; i < n; i++) {
      if (i > 0) { Nv = norm(sub(Nv, scale(T[i], dot(Nv, T[i])))); if (!Number.isFinite(Nv[0])) Nv = N0; }
      const B = cross(T[i], Nv);
      for (let j = 0; j < radial; j++) {
        const r = radius * (P[i][3] ?? 1);
        const a = (j / radial) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
        pos.push(P[i][0] + Nv[0] * c + B[0] * s, P[i][1] + Nv[1] * c + B[1] * s, P[i][2] + Nv[2] * c + B[2] * s);
        wt.push(P[i][3] ?? 1);
        if (C) col.push(C[i][0], C[i][1], C[i][2]);
      }
    }
    const ring = (i, j) => base + i * radial + (j % radial);
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const a = ring(i, j), b = ring(i, j + 1), c = ring(i + 1, j), d = ring(i + 1, j + 1);
        idx.push(a, b, c, b, d, c);
      }
      const drawn = Math.min(P[i][3] ?? 1, P[i + 1][3] ?? 1) >= 0.9;
      clock += dist3(P[i], P[i + 1]) / (drawn ? 1 : 2.6);
      tlEnd.push(idx.length); tlTime.push(clock); tlTip.push(P[i + 1][0], P[i + 1][1], P[i + 1][2]);
    }
    const s0 = pos.length / 3; pos.push(P[0][0], P[0][1], P[0][2]); wt.push(P[0][3] ?? 1);
    const s1 = pos.length / 3; pos.push(P[n - 1][0], P[n - 1][1], P[n - 1][2]); wt.push(P[n - 1][3] ?? 1);
    if (C) col.push(...C[0], ...C[n - 1]);
    for (let j = 0; j < radial; j++) {
      idx.push(s0, ring(0, j + 1), ring(0, j));
      idx.push(s1, ring(n - 1, j), ring(n - 1, j + 1));
    }
    tlEnd[tlEnd.length - 1] = idx.length; // caps appear with the last segment of the path
  }
  return {
    positions: new Float32Array(pos), indices: new Uint32Array(idx), weight: new Float32Array(wt),
    colors: colorAt ? new Float32Array(col) : null,
    triangles: idx.length / 3, length: total,
    timeline: { end: Uint32Array.from(tlEnd), time: Float32Array.from(tlTime), tip: Float32Array.from(tlTip), duration: clock },
  };
}

/* ---------- skeleton and tracing ---------- */

// Chamfer distance (1, 1.4). want=1: for pixels of the mask, distance to the nearest pixel
// outside it. want=0: for every pixel, distance to the nearest pixel of the mask.
function chamferDist(m, W, H, want) {
  const d = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) d[p] = (want ? m[p] : !m[p]) ? 1e6 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (!d[p]) continue;
    let v = d[p];
    if (x > 0) v = Math.min(v, d[p - 1] + 1);
    if (y > 0) { v = Math.min(v, d[p - W] + 1); if (x > 0) v = Math.min(v, d[p - W - 1] + 1.4); if (x < W - 1) v = Math.min(v, d[p - W + 1] + 1.4); }
    d[p] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const p = y * W + x;
    if (!d[p]) continue;
    let v = d[p];
    if (x < W - 1) v = Math.min(v, d[p + 1] + 1);
    if (y < H - 1) { v = Math.min(v, d[p + W] + 1); if (x < W - 1) v = Math.min(v, d[p + W + 1] + 1.4); if (x > 0) v = Math.min(v, d[p + W - 1] + 1.4); }
    d[p] = v;
  }
  return d;
}

// Mean of a (2r+1)^2 box around every pixel, from an integral image.
function boxMean(v, W, H, r) {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += v[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const sum = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
      out[y * W + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

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
  // Junctions are counted by branches, not by neighbours: Zhang-Suen leaves L-shaped corners
  // on diagonal runs, where a plain pixel of a line has three neighbours. Counting neighbours
  // cut every such line into crumbs that the length filter then dropped (faces disappeared).
  // Branches = 0 to 1 transitions around the pixel (the crossing number, Rutovitz 1966).
  const RING = [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1]; // N, NE, E, SE, S, SW, W, NW
  const inside = (p, o) => { const x = p % W, dx = o === -W - 1 || o === -1 || o === W - 1 ? -1 : o === -W + 1 || o === 1 || o === W + 1 ? 1 : 0; return x + dx >= 0 && x + dx < W && p + o >= 0 && p + o < s.length; };
  const on = (p, o) => inside(p, o) && s[p + o] === 1;
  const kind = new Uint8Array(s.length); // 1 end, 2 line, 3 junction, 4 isolated
  for (let p = 0; p < s.length; p++) {
    if (!s[p]) continue;
    let A = 0, B = 0;
    for (let k = 0; k < 8; k++) { const a = on(p, RING[k]), b = on(p, RING[(k + 1) % 8]); if (a) B++; if (!a && b) A++; }
    kind[p] = B === 0 ? 4 : A <= 1 ? 1 : A === 2 ? 2 : 3;
  }
  const visited = new Uint8Array(s.length);
  const nbrs = (p) => {
    const four = [], diag = [];
    for (let k = 0; k < 8; k++) if (on(p, RING[k])) (k % 2 ? diag : four).push(p + RING[k]);
    return four.concat(diag); // straight steps first, so a staircase is walked pixel by pixel
  };
  const lines = [];
  const walk = (start, first) => {
    const line = [start, first];
    if (kind[first] !== 3) visited[first] = 1;
    let prev = start, cur = first;
    while (kind[cur] !== 3) {
      const ns = nbrs(cur).filter((q) => q !== prev && q !== start);
      let next = ns.find((q) => !visited[q] && kind[q] !== 3);
      if (next === undefined) next = ns.find((q) => kind[q] === 3 && q !== prev); // end at a junction
      if (next === undefined) {
        if (line.length > 3 && nbrs(cur).includes(start)) line.push(start); // closed loop
        break;
      }
      line.push(next);
      if (kind[next] !== 3) visited[next] = 1;
      prev = cur; cur = next;
    }
    return line;
  };
  // From ends and junctions first, then whatever is left (closed loops: an eye, a spiral).
  for (const want of [1, 3]) {
    for (let p = 0; p < s.length; p++) {
      if (kind[p] !== want || (want === 1 && visited[p])) continue;
      if (want === 1) visited[p] = 1;
      for (const q of nbrs(p)) if (!visited[q] && kind[q] !== 3) lines.push(walk(p, q));
      if (want === 3) for (const q of nbrs(p)) if (kind[q] === 3 && q > p) lines.push([p, q]); // junction to junction
    }
  }
  for (let p = 0; p < s.length; p++) {
    if (kind[p] !== 2 || visited[p]) continue;
    visited[p] = 1;
    const q = nbrs(p).find((n) => !visited[n]);
    if (q !== undefined) lines.push(walk(p, q));
  }
  return lines.filter((l) => l.length >= 2).map((l) => l.map((p) => [p % W, (p / W) | 0]));
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
