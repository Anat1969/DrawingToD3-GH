// Reading a picture as a landscape you can walk into (pure functions, no DOM, testable in Node).
// An object is inflated toward the viewer; a landscape is laid out in depth: the bottom of the
// picture is near, the horizon is far, the sky stands at the back, and things stand upright on
// the ground at the depth where they touch it.
// Method: Tour Into the Picture (Horry, Anjyo & Arai, SIGGRAPH 1997) and Automatic Photo
// Pop-up (Hoiem, Efros & Hebert, SIGGRAPH 2005): ground, standing things, and sky, seen from
// the camera that took the picture. Anat, 31.10.2026: "sea and beach spread into the depth".

export const FOCAL = 1 / (2 * Math.tan((32 * Math.PI) / 360)); // the stage camera: 32 degrees over the picture height
export const EYE = 1;                                             // camera height above the ground

/**
 * Find the horizon: a straight change of colour across the whole width, with calm (sky) above.
 * @param img RGBA pixels, ~200 px
 * @returns {{row:number, score:number, agree:number, calm:number}} row as a share of the height
 */
export function findHorizon(img) {
  const { width: W, height: H, data } = img;
  // Row-wise smoothing per column (box 5 tall, 9 wide) of the colour.
  const sm = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -4; dx <= 4; dx++) {
      const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx)), i = (yy * W + xx) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    const o = (y * W + x) * 3;
    sm[o] = r / n; sm[o + 1] = g / n; sm[o + 2] = b / n;
  }
  const colMean = (y0, y1, x) => {
    let r = 0, g = 0, b = 0;
    for (let y = y0; y < y1; y++) { const o = (y * W + x) * 3; r += sm[o]; g += sm[o + 1]; b += sm[o + 2]; }
    const n = y1 - y0;
    return [r / n, g / n, b / n];
  };
  let best = { row: 0.5, score: -Infinity, agree: 0, calm: 0 };
  const y0 = Math.round(H * 0.1), y1 = Math.round(H * 0.7);
  for (let y = y0; y < y1; y++) {
    let agree = 0;
    for (let x = 0; x < W; x++) {
      const a = colMean(Math.max(0, y - 6), y - 1, x), b = colMean(y + 1, Math.min(H, y + 6), x);
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 20) agree++;
    }
    agree /= W;
    // Calm above: mean distance of the band above from its own mean colour.
    const top = Math.max(0, y - Math.round(H * 0.2)), bot = Math.max(top + 1, y - 3);
    let mr = 0, mg = 0, mb = 0, n = 0;
    for (let yy = top; yy < bot; yy++) for (let x = 0; x < W; x++) { const i = (yy * W + x) * 4; mr += data[i]; mg += data[i + 1]; mb += data[i + 2]; n++; }
    mr /= n; mg /= n; mb /= n;
    let calm = 0;
    for (let yy = top; yy < bot; yy++) for (let x = 0; x < W; x++) { const i = (yy * W + x) * 4; calm += Math.hypot(data[i] - mr, data[i + 1] - mg, data[i + 2] - mb); }
    calm /= n;
    const score = agree - calm / 60;
    // Sky above: blue leads in the band above (a cloudy sky is still blue-grey; red hair, warm
    // paper or a white page are not).
    const skyLike = mb >= mr + 4 && mb >= mg - 6;
    if (score > best.score) best = { row: y / H, score, agree, calm, skyLike };
  }
  return best;
}

/** A landscape when the horizon is straight across the picture and the sky above it is calm. */
export const isLandscape = (h) => h.score > 0.6 || (h.skyLike && h.agree > 0.8 && h.calm < 45); // a cloudy sky over a straight horizon (a desert photograph)

/**
 * The camera of the picture. Picture coordinates: u across (0..aspect), v down (0..1), both in
 * picture heights. World: x across, y up from the ground, z toward the viewer (the scene lies
 * at negative z). depth (0..1) sets how far the back wall stands.
 */
export function sceneCamera(horizon, aspect = 1, depth = 0.5) {
  const vh = Math.min(0.85, Math.max(0.05, horizon));
  const f = FOCAL, hc = EYE;
  const near = (f * hc) / Math.max(0.05, 1 - vh);           // the bottom edge of the picture
  const far = near * (1.6 + 4 * Math.max(0, Math.min(1, depth))); // the back wall: sea and sky (depth 0.5: 3.6 times the near edge)
  const tFar = (f * hc) / far;                               // below the horizon, where the ground meets the wall
  const cx = aspect / 2;
  /** Depth of the ground at picture row v (picture heights below the top). */
  const groundDepth = (v) => { const t = v - vh; return t <= tFar ? far : (f * hc) / t; };
  return {
    vh, near, far, tFar, aspect, f, hc,
    groundDepth,
    /** A point on the ground, or on the back wall above where the ground ends. */
    ground(u, v) {
      const t = v - vh;
      if (t > tFar) { const d = (f * hc) / t; return [((u - cx) * d) / f, 0, -d]; }
      return [((u - cx) * far) / f, hc - (t * far) / f, -far];
    },
    /** A point of something standing upright on the ground, touching it at row vc. */
    standing(u, v, vc) {
      const d = groundDepth(vc);
      return [((u - cx) * d) / f, Math.max(0, hc - ((v - vh) * d) / f), -d];
    },
    /** Where the camera stood, and where it looked: the front view gives the picture back. */
    viewpoint: { position: [0, hc, 0], target: [0, hc, -near] },
    /** Size in the world of something that covers s picture heights at depth d. */
    worldSize: (s, d) => (s * d) / f,
  };
}

/**
 * Things that stand: clusters of ink (a boat, a tree, a figure) with mass and height that do not
 * reach the bottom edge (the foreground ground does). Each gets the row where it touches the
 * ground: its lowest ink.
 * @param ink  Uint8Array mask (stroke image pixels)
 * @returns {{label:Int32Array, things:Array<{id:number,x0:number,x1:number,y0:number,y1:number,contact:number,standing:boolean}>}}
 */
export function standingThings(ink, W, H, horizonRow, opts = {}) {
  const r = opts.reach ?? Math.max(2, Math.round(Math.max(W, H) / 70));
  // Dilate by r (separable box), so the strokes of one thing join into one cluster.
  const tmp = new Uint8Array(W * H), grown = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { let run = -1e9; for (let x = 0; x < W; x++) { if (ink[y * W + x]) run = x; tmp[y * W + x] = x - run <= r ? 1 : 0; } run = 1e9; for (let x = W - 1; x >= 0; x--) { if (ink[y * W + x]) run = x; if (run - x <= r) tmp[y * W + x] = 1; } }
  for (let x = 0; x < W; x++) { let run = -1e9; for (let y = 0; y < H; y++) { if (tmp[y * W + x]) run = y; grown[y * W + x] = y - run <= r ? 1 : 0; } run = 1e9; for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) run = y; if (run - y <= r) grown[y * W + x] = 1; } }
  const label = new Int32Array(W * H).fill(-1);
  const things = [];
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!grown[s] || label[s] >= 0) continue;
    const id = things.length;
    let x0 = W, x1 = 0, y0 = H, y1 = 0, n = 0, inkLow = 0, footL = W, footR = -1;
    stack.push(s); label[s] = id;
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p / W) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (ink[p] && y > inkLow) inkLow = y;
      if (y >= H - Math.max(2, Math.round(H * 0.03))) { if (x < footL) footL = x; if (x > footR) footR = x; } // its foot on the bottom edge
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= W * H || label[q] >= 0 || !grown[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
        label[q] = id; stack.push(q);
      }
    }
    const h = (y1 - y0) / H, contact = inkLow / H;
    // Stands: a real mass with height, resting on the ground below the horizon. What reaches the
    // bottom edge is the foreground ground itself; small marks (footprints) lie on the ground.
    const resting = n > W * H * 0.015 && h > 0.06 && contact < 0.97 && contact > horizonRow + 0.02;
    // A tree or a tower at the side of the picture runs off the bottom edge, but its foot there
    // is narrow; the foreground ground runs along the whole edge (31.10.2026).
    const foot = footR >= footL ? (footR - footL) / W : 1;
    const tall = n > W * H * 0.01 && h > 0.35 && y0 / H < horizonRow + 0.1 && foot < 0.22;
    const standing = resting || tall;
    things.push({ id, x0, x1, y0, y1, contact, standing, size: n });
  }
  return { label, things };
}
