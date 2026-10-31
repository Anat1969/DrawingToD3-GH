// Local sculpting engine, pure functions (no DOM, testable in Node).
// Technique: silhouette inflation, as in Teddy (Igarashi et al., SIGGRAPH 1999)
// and Monster Mash (Dvorožňák et al., 2020): the drawn shape is filled, its distance
// to the outline becomes height, and both sides meet at the rim, giving a closed body.
// The drawing's dark lines are raised as relief: line as volume.

export const DEFAULTS = { volume: 0.5, line: 0.5 };

/**
 * Analyse pixels of a drawing.
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img  RGBA pixels (already small, ~200 px)
 * @returns {{W:number,H:number,pad:number,w0:number,h0:number,mask:Uint8Array,dist:Float32Array,ink:Float32Array,rim:Uint8Array}}
 */
export function analysePixels(img) {
  const w0 = img.width, h0 = img.height, src = img.data;
  const pad = 2;
  const W = w0 + pad * 2, H = h0 + pad * 2, N = W * H;

  // 1. Background colour: median of the border pixels.
  const border = [[], [], []];
  for (let x = 0; x < w0; x++) for (const y of [0, h0 - 1]) pushRGB(x, y);
  for (let y = 0; y < h0; y++) for (const x of [0, w0 - 1]) pushRGB(x, y);
  function pushRGB(x, y) { const i = (y * w0 + x) * 4; border[0].push(src[i]); border[1].push(src[i + 1]); border[2].push(src[i + 2]); }
  const bg = border.map((c) => c.sort((a, b) => a - b)[c.length >> 1]);
  const bgLum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];

  // 2. Distance of every pixel from the background colour, threshold by Otsu.
  const diff = new Float32Array(w0 * h0);
  const hist = new Uint32Array(256);
  const ink0 = new Float32Array(w0 * h0);
  for (let p = 0; p < w0 * h0; p++) {
    const i = p * 4;
    const dr = src[i] - bg[0], dg = src[i + 1] - bg[1], db = src[i + 2] - bg[2];
    const d = Math.min(255, Math.sqrt(dr * dr + dg * dg + db * db));
    diff[p] = d;
    hist[d | 0]++;
    const lum = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    const dark = bgLum > 1 ? Math.max(0, (bgLum - lum) / bgLum) : 0;
    ink0[p] = smoothstep(0.35, 0.7, dark);
  }
  const t = Math.max(24, otsu(hist, w0 * h0));

  let fg = new Uint8Array(N);
  for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) {
    if (diff[y * w0 + x] > t) fg[(y + pad) * W + x + pad] = 1;
  }

  // 3. Close small gaps in the line (dilate, then erode).
  fg = erode(dilate(dilate(fg, W, H), W, H), W, H);
  fg = erode(fg, W, H);

  // 4. Everything not reachable from the border is inside: fills the enclosed areas.
  const outside = new Uint8Array(N);
  const stack = [];
  for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
  for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
  while (stack.length) {
    const p = stack.pop();
    if (outside[p] || fg[p]) continue;
    outside[p] = 1;
    const x = p % W, y = (p / W) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < W - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - W);
    if (y < H - 1) stack.push(p + W);
  }
  let mask = new Uint8Array(N);
  for (let p = 0; p < N; p++) mask[p] = outside[p] ? 0 : 1;
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    if (x < pad || y < pad || x >= W - pad || y >= H - pad) mask[y * W + x] = 0;
  }

  // 5. Keep the meaningful parts: drop specks smaller than 1.5% of the largest part.
  mask = keepLargeComponents(mask, W, H, 0.015);
  // 5b. Opening: splashes, drips and thin hair-like protrusions are not the body. Erode, keep
  //     the large parts, and grow back: the outline follows the figure, not every splash
  //     (31.10.2026, watercolour zebras came out as a block).
  const r = Math.max(1, Math.round(Math.max(w0, h0) / 50));
  let opened = mask;
  for (let i = 0; i < r; i++) opened = erode(opened, W, H);
  opened = keepLargeComponents(opened, W, H, 0.03);
  for (let i = 0; i < r; i++) opened = dilate(opened, W, H);
  let kept = 0, before = 0;
  for (let p = 0; p < N; p++) { opened[p] &= mask[p]; kept += opened[p]; before += mask[p]; }
  if (kept > before * 0.5) mask = opened; // never lose the subject itself (thin line drawings)

  let area = 0;
  for (let p = 0; p < N; p++) area += mask[p];
  if (area < w0 * h0 * 0.01) throw Object.assign(new Error('no_subject'), { code: 'no_subject' });
  if (area > w0 * h0 * 0.97) throw Object.assign(new Error('no_background'), { code: 'no_background' });

  // 6. Distance to the outline (chamfer 3-4), in pixels.
  const dist = chamfer(mask, W, H);

  // 7. Rim: inside pixels with any outside neighbour (8-connected). Height 0 there, so the
  //    front and back surfaces share these vertices and the body is closed.
  const rim = new Uint8Array(N);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const p = y * W + x;
    if (!mask[p]) continue;
    for (let dy = -1; dy <= 1 && !rim[p]; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!mask[p + dy * W + dx]) { rim[p] = 1; break; }
    }
  }

  const ink = new Float32Array(N);
  for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) ink[(y + pad) * W + x + pad] = ink0[y * w0 + x];

  return { W, H, pad, w0, h0, mask, dist, ink: blur(ink, mask, W, H, 1), rim };
}

/**
 * Build an indexed, closed mesh from an analysis.
 * @returns {{positions:Float32Array, uvs:Float32Array, indices:Uint32Array, triangles:number}}
 */
/** Height of the inflated body above the drawing plane, per analysis pixel (pixel units). */
export function heightField(a, opts = {}) {
  const volume = clamp01(opts.volume ?? DEFAULTS.volume);
  const line = clamp01(opts.line ?? DEFAULTS.line);
  const { W, H, mask, dist, ink, rim } = a;
  const N = W * H;
  let dmax = 0;
  for (let p = 0; p < N; p++) if (dist[p] > dmax) dmax = dist[p];
  const maxH = (0.12 + 0.6 * volume) * dmax;
  const relief = line * 0.12 * dmax;
  // Height: sqrt profile gives rounded edges, like a pillow or a cast.
  const h = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    if (!mask[p] || rim[p]) continue;
    h[p] = maxH * Math.sqrt(dist[p] / dmax) + relief * ink[p] * Math.min(1, dist[p] / 3);
  }
  return blur(h, mask, W, H, 2, rim);
}

export function buildSculpt(a, opts = {}) {
  const { W, H, pad, w0, h0, mask } = a;
  const N = W * H;
  const h = heightField(a, opts);

  // 1. Plane triangulation of the shape, oriented for the front (counter-clockwise from +z).
  //    Image y points down, so a front triangle has a negative signed area in image space.
  const nodes = []; // extra nodes from chord splits: { x, y, z, ref } in pixel space
  const nx = (id) => (id < N ? id % W : nodes[id - N].x);
  const ny = (id) => (id < N ? (id / W) | 0 : nodes[id - N].y);
  let tris = [];
  const addTri = (p1, p2, p3) => {
    const area = (nx(p2) - nx(p1)) * (ny(p3) - ny(p1)) - (nx(p3) - nx(p1)) * (ny(p2) - ny(p1));
    tris.push(area < 0 ? [p1, p2, p3] : [p1, p3, p2]);
  };
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const a0 = y * W + x, b0 = a0 + 1, c0 = a0 + W, d0 = c0 + 1;
    const ins = mask[a0] + mask[b0] + mask[c0] + mask[d0];
    if (ins === 4) { addTri(a0, c0, b0); addTri(b0, c0, d0); }
    else if (ins === 3) {
      const q = [a0, b0, d0, c0].filter((p) => mask[p]);
      addTri(q[0], q[1], q[2]);
    }
  }

  // 2. Boundary of the plane surface: edges used by one triangle. Front and back are welded
  //    only along it, so every edge of the final body is used exactly twice (closed, printable).
  const key = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  const edgeTris = (list) => {
    const m = new Map();
    list.forEach((t, i) => { for (let k = 0; k < 3; k++) { const e = key(t[k], t[(k + 1) % 3]); const v = m.get(e); if (v) v.push(i); else m.set(e, [i]); } });
    return m;
  };
  let edges = edgeTris(tris);
  const onBoundary = new Set();
  for (const [e, ts] of edges) if (ts.length === 1) { onBoundary.add(Math.floor(e / 4294967296)); onBoundary.add(e % 4294967296); }

  // 3. A chord joins two boundary nodes through the inside (thin necks). After welding it
  //    would be shared by four triangles, so split it with a new inside node.
  const height = (id) => (id < N ? h[id] : nodes[id - N].z);
  // Split in passes: within one pass a triangle is split at most once, so a triangle with
  // two chords is handled over two passes from its updated pieces.
  for (let pass = 0; pass < 8; pass++) {
    const used = new Set();
    const out = [];
    let any = false;
    for (const [e, ts] of edges) {
      if (ts.length !== 2 || used.has(ts[0]) || used.has(ts[1])) continue;
      const a0 = Math.floor(e / 4294967296), b0 = e % 4294967296;
      if (!onBoundary.has(a0) || !onBoundary.has(b0)) continue;
      any = true;
      const m = N + nodes.length;
      const opp = ts.map((i) => tris[i].find((v) => v !== a0 && v !== b0));
      nodes.push({ x: (nx(a0) + nx(b0)) / 2, y: (ny(a0) + ny(b0)) / 2, z: Math.max(0.35, (height(opp[0]) + height(opp[1])) / 4) });
      for (const i of ts) {
        const t = tris[i];
        used.add(i);
        for (let k = 0; k < 3; k++) {
          const u = t[k], v = t[(k + 1) % 3], w = t[(k + 2) % 3];
          if ((u === a0 && v === b0) || (u === b0 && v === a0)) { out.push([u, m, w], [m, v, w]); break; }
        }
      }
    }
    if (!any) break;
    tris = tris.filter((_, i) => !used.has(i)).concat(out);
    edges = edgeTris(tris);
  }

  // 4. Smooth the outline: pixel steps become a clean contour. Only boundary nodes move,
  //    along their two boundary neighbours (Laplacian smoothing), so topology is unchanged.
  const bx = new Map(), by = new Map();
  {
    const nbr = new Map();
    const finalEdges = edgeTris(tris);
    for (const [e, ts] of finalEdges) {
      if (ts.length !== 1) continue;
      const a1 = Math.floor(e / 4294967296), b1 = e % 4294967296;
      (nbr.get(a1) || nbr.set(a1, []).get(a1)).push(b1);
      (nbr.get(b1) || nbr.set(b1, []).get(b1)).push(a1);
    }
    for (const id of nbr.keys()) { bx.set(id, nx(id)); by.set(id, ny(id)); }
    for (let it = 0; it < 3; it++) {
      const tx = new Map(), ty = new Map();
      for (const [id, ns] of nbr) {
        if (ns.length !== 2) { tx.set(id, bx.get(id)); ty.set(id, by.get(id)); continue; } // keep pinch points
        tx.set(id, 0.5 * bx.get(id) + 0.25 * (bx.get(ns[0]) + bx.get(ns[1])));
        ty.set(id, 0.5 * by.get(id) + 0.25 * (by.get(ns[0]) + by.get(ns[1])));
      }
      for (const id of nbr.keys()) { bx.set(id, tx.get(id)); by.set(id, ty.get(id)); }
    }
  }

  // 5. Vertices. Boundary nodes: one shared vertex at z = 0. Inside nodes: front and back.
  const unit = 2 / Math.max(w0, h0);
  const minZ = 0.35; // half a pixel: inside nodes never collapse onto the rim plane
  const front = new Map(), back = new Map();
  const pos = [], uv = [];
  let n = 0;
  const vertex = (id) => {
    if (front.has(id)) return;
    const x = bx.has(id) ? bx.get(id) : nx(id), y = by.has(id) ? by.get(id) : ny(id);
    const X = (x - pad - w0 / 2) * unit, Y = (h0 / 2 - (y - pad)) * unit;
    const u = clamp01((x - pad) / Math.max(1, w0 - 1)), v = clamp01(1 - (y - pad) / Math.max(1, h0 - 1));
    if (onBoundary.has(id)) { pos.push(X, Y, 0); uv.push(u, v); front.set(id, n); back.set(id, n); n++; return; }
    const Z = Math.max(minZ, height(id)) * unit;
    pos.push(X, Y, Z); uv.push(u, v); front.set(id, n++);
    pos.push(X, Y, -Z); uv.push(u, v); back.set(id, n++);
  };
  const idx = [];
  for (const [a0, b0, c0] of tris) {
    vertex(a0); vertex(b0); vertex(c0);
    idx.push(front.get(a0), front.get(b0), front.get(c0));
    idx.push(back.get(a0), back.get(c0), back.get(b0));
  }

  return {
    positions: new Float32Array(pos),
    uvs: new Float32Array(uv),
    indices: new Uint32Array(idx),
    triangles: idx.length / 3,
  };
}

/** A closed (watertight, 2-manifold) mesh uses every edge exactly twice. The printability check. */
export function isClosed(indices) {
  const count = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[i + k], b = indices[i + ((k + 1) % 3)];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  for (const c of count.values()) if (c !== 2) return false;
  return count.size > 0;
}

/* ---------- helpers ---------- */
function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
function smoothstep(a, b, v) { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); }

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = i; }
  }
  return thr;
}

function dilate(m, W, H) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H && m[yy * W + xx]) { v = 1; break; }
    }
    o[y * W + x] = v;
  }
  return o;
}

function erode(m, W, H) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 1;
    for (let dy = -1; dy <= 1 && v; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H || !m[yy * W + xx]) { v = 0; break; }
    }
    o[y * W + x] = v;
  }
  return o;
}

function keepLargeComponents(mask, W, H, ratio) {
  const label = new Int32Array(mask.length);
  const sizes = [0];
  let next = 1;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    let size = 0;
    const stack = [s];
    label[s] = next;
    while (stack.length) {
      const p = stack.pop();
      size++;
      const x = p % W, y = (p / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (mask[q] && !label[q]) { label[q] = next; stack.push(q); }
      }
    }
    sizes.push(size);
    next++;
  }
  const largest = Math.max(0, ...sizes);
  const out = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p++) if (label[p] && sizes[label[p]] >= largest * ratio) out[p] = 1;
  return out;
}

function chamfer(mask, W, H) {
  const INF = 1e9;
  const d = new Float32Array(mask.length);
  for (let p = 0; p < mask.length; p++) d[p] = mask[p] ? INF : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (!d[p]) continue;
    let v = d[p];
    if (x > 0) v = Math.min(v, d[p - 1] + 3);
    if (y > 0) {
      v = Math.min(v, d[p - W] + 3);
      if (x > 0) v = Math.min(v, d[p - W - 1] + 4);
      if (x < W - 1) v = Math.min(v, d[p - W + 1] + 4);
    }
    d[p] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const p = y * W + x;
    if (!d[p]) continue;
    let v = d[p];
    if (x < W - 1) v = Math.min(v, d[p + 1] + 3);
    if (y < H - 1) {
      v = Math.min(v, d[p + W] + 3);
      if (x < W - 1) v = Math.min(v, d[p + W + 1] + 4);
      if (x > 0) v = Math.min(v, d[p + W - 1] + 4);
    }
    d[p] = v;
  }
  for (let p = 0; p < d.length; p++) d[p] /= 3;
  return d;
}

// Box blur restricted to the mask. Pixels in `fixed` keep their value.
function blur(src, mask, W, H, passes, fixed) {
  let a = src;
  for (let k = 0; k < passes; k++) {
    const b = new Float32Array(a.length);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (!mask[p]) continue;
      if (fixed && fixed[p]) { b[p] = a[p]; continue; }
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const q = p + dy * W + dx;
        if (mask[q]) { s += a[q]; c++; }
      }
      b[p] = s / c;
    }
    a = b;
  }
  return a;
}
