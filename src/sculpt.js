// Browser side of the local engines: reads the drawing once, then builds
// either the inflated body or the line sculpture with Three.js.
import * as THREE from 'three';
import { analysePixels, buildSculpt, heightField, isClosed, DEFAULTS } from './sculpt-core.js';
import { findHorizon, isLandscape, sceneCamera, standingThings } from './scene-core.js';
import { extractStrokes, liftStrokes, tubeMesh, wrapLoops, depthScale, wireRadius, threadThroughInk, stitchLoops, makeRouter, threadColours, identityMarks, LINE_DEFAULTS } from './line-core.js';

export { DEFAULTS, LINE_DEFAULTS };
const GRID = 200;      // body analysis resolution (longest side)
const STROKES = 560;   // stroke analysis resolution (longest side): enough for fine lines
const TEXTURE = 1024;  // texture resolution (longest side)

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(Object.assign(new Error('read'), { code: 'read' }));
    img.src = src;
  });
}

function draw(img, side) {
  const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(8, Math.round(img.naturalWidth * k));
  c.height = Math.max(8, Math.round(img.naturalHeight * k));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** Read the drawing once. Slider changes then only rebuild geometry. */
export async function prepareSculpt(src) {
  const img = await loadImage(src);
  const small = draw(img, GRID);
  const pixels = small.getContext('2d').getImageData(0, 0, small.width, small.height);
  // A picture with no paper around it (a landscape) has no silhouette: keep the reason, the
  // landscape reading does not need one.
  let analysis = null, analysisError = null;
  try { analysis = analysePixels(pixels); } catch (err) { analysisError = err; }
  const horizon = findHorizon(pixels);
  const strokeCanvas = draw(img, STROKES);
  const strokeImage = strokeCanvas.getContext('2d').getImageData(0, 0, strokeCanvas.width, strokeCanvas.height);
  const texture = new THREE.CanvasTexture(draw(img, TEXTURE));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { analysis, analysisError, horizon, pixels, strokeImage, strokeCache: new Map(), strokeSize: { sw: strokeCanvas.width, sh: strokeCanvas.height }, texture };
}

/** Strokes for a sensitivity, cached: moving other sliders does not re-trace the drawing. */
function strokesFor(prepared, sensitivity) {
  const key = Math.round((sensitivity ?? LINE_DEFAULTS.sensitivity) * 20);
  if (!prepared.strokeCache.has(key)) prepared.strokeCache.set(key, extractStrokes(prepared.strokeImage, { sensitivity: key / 20 }));
  return prepared.strokeCache.get(key);
}

/**
 * A landscape laid out in depth: the ground recedes from the bottom of the picture to the
 * horizon, the sky stands as a back wall, and things (a boat) stand upright where they touch
 * the ground. Seen from the picture's own camera (the front view) it gives the picture back;
 * walking round it shows the sea and the beach spread into the distance.
 */
function sceneSculpture(prepared, opts) {
  const { sw, sh } = prepared.strokeSize;
  const strokes = strokesFor(prepared, opts.sensitivity);
  if (!strokes.length) throw Object.assign(new Error('no_lines'), { code: 'no_lines' });
  const vh = prepared.horizon.row;
  const cam = sceneCamera(vh, sw / sh, opts.depth ?? LINE_DEFAULTS.depth);
  if (!strokes.things) strokes.things = standingThings(strokes.ink, sw, sh, vh);
  const { label, things } = strokes.things;
  // A standing thing has a little body: its lines bulge toward the viewer from its outline.
  if (!strokes.bulge) strokes.bulge = insideDistance(label, things, sw, sh);
  const bulge = strokes.bulge;
  const at = (x, y) => {
    const xi = Math.max(0, Math.min(sw - 1, Math.round(x))), yi = Math.max(0, Math.min(sh - 1, Math.round(y)));
    const p = yi * sw + xi, id = label[p];
    const u = x / sh, v = y / sh;
    if (id >= 0 && things[id].standing) {
      const q = cam.standing(u, v, things[id].contact);
      q[2] += cam.worldSize(bulge[p] / sh, -q[2]) * 0.8;
      return q;
    }
    return cam.ground(u, v);
  };
  // Far lines are drawn as thick as near ones look: the weight follows the depth.
  const weightAt = (z) => Math.max(1, Math.min(6, -z / cam.near));
  const continuous = opts.continuous ?? LINE_DEFAULTS.continuous;
  const lines2d = continuous && strokes.length > 1 ? [threadFor(strokes).path] : strokes;
  const jump = cam.near * 0.35;
  const paths = lines2d.map((l) => layOnGround(l.map(([x, y]) => { const q = at(x, y); return [q[0], q[1], q[2], weightAt(q[2])]; }), jump));
  const thickness = Math.max(0, Math.min(1, opts.thickness ?? LINE_DEFAULTS.thickness));
  const radius = wireRadius(strokes.lineWidth ?? 3, cam.near / (cam.f * sh), thickness);
  // The thread's colour: seen from the picture's camera, every point falls on its place in the picture.
  const colourAt = colouredThread(prepared, strokes, opts, ([x, y, z]) => {
    const d = Math.max(1e-6, -z);
    return [(cam.aspect / 2 + (x * cam.f) / d) / cam.aspect, cam.vh + ((cam.hc - y) * cam.f) / d];
  });
  const tube = tubeMesh(paths, radius, 8, { colorAt: colourAt });
  if (!tube.triangles) throw Object.assign(new Error('no_lines'), { code: 'no_lines' });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tube.positions, 3));
  g.setIndex(new THREE.BufferAttribute(tube.indices, 1));
  g.computeVertexNormals();
  const wire = new THREE.Mesh(g, wireMaterial(tube, g));
  wire.name = 'line';
  const group = new THREE.Group();
  group.add(wire);
  const cloud = opts.cloud === true ? 0.6 : opts.cloud === false ? 0 : (opts.cloud ?? LINE_DEFAULTS.cloud);
  const cloudPoints = cloud > 0 ? sceneCloud(prepared, cam, at, cloud) : null;
  if (cloudPoints) group.add(cloudPoints);
  return {
    object: group, closed: isClosed(tube.indices), lines: strokes.length, loops: 0,
    continuous: paths.length === 1 && strokes.length > 1,
    reading: 'scene', horizon: vh, standing: things.filter((t) => t.standing).length,
    viewpoint: cam.viewpoint,
    animation: drawingAnimation(group, g, tube.timeline, cloudPoints, radius),
  };
}

// Where the thread passes between two depths (the edge of the boat against the sea behind it),
// it goes down to the ground, along the sand or the water, and back up: one thread lying on the
// beach, instead of a line flying through the air. From the front these joins look short.
function layOnGround(path, jump) {
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const b = path[i];
    const a = out.at(-1);
    if (a && Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > jump) {
      const steps = (p, q, n) => { for (let k = 1; k < n; k++) { const f = k / n; out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f, p[3] + (q[3] - p[3]) * f]); } };
      const a0 = [a[0], 0, a[2], a[3]], b0 = [b[0], 0, b[2], b[3]];
      const n = (p, q) => Math.max(2, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / (jump * 0.25)));
      if (a[1] > 1e-6) { steps(a, a0, n(a, a0)); out.push(a0); }
      steps(a0, b0, n(a0, b0));
      if (b[1] > 1e-6) { out.push(b0); steps(b0, b, n(b0, b)); }
    }
    out.push(b);
  }
  return out;
}

// Distance (pixels) from the outline of each standing thing, inside it: its bulge.
function insideDistance(label, things, W, H) {
  const m = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) m[p] = label[p] >= 0 && things[label[p]].standing ? 1 : 0;
  return chamfer2(m, W, H);
}

// The landscape's colour, sprayed where it lies: sea and sand on the receding ground, the sky
// on the back wall, the boat's colour on the boat. A puff covers the same share of the picture
// near or far, so far puffs are larger in the world.
function sceneCloud(prepared, cam, at, amount) {
  const { width: w, height: hh, data } = prepared.pixels;
  const { sw, sh } = prepared.strokeSize;
  const pos = [], tint = [], size = [], alpha = [];
  let seed = 7331;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const target = Math.round(2500 + 6500 * amount);
  for (let k = 0; k < 60000 && size.length < target; k++) {
    const x = rnd() * (w - 1), y = rnd() * (hh - 1), i = (Math.round(y) * w + Math.round(x)) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), sat = mx ? (mx - Math.min(r, g, b)) / mx : 0;
    if (mx > 238 && sat < 0.06) continue; // bare paper
    const sx = (x / (w - 1)) * (sw - 1), sy = (y / (hh - 1)) * (sh - 1);
    const q = at(sx + (rnd() - 0.5) * 2, sy + (rnd() - 0.5) * 2);
    pos.push(q[0], q[1], q[2]);
    tint.push(r / 255, g / 255, b / 255);
    const d = -q[2];
    size.push(cam.worldSize(0.012 + Math.pow(rnd(), 2) * 0.04, d) * 2.2);
    alpha.push((0.12 + Math.pow(rnd(), 2) * 0.3) * (0.5 + amount));
  }
  return size.length >= 20 ? cloudPoints(pos, tint, size, alpha) : null;
}

/**
 * Colour along the thread (Anat, 31.10.2026: "add colours and colour transitions"): the thread
 * takes the colour of the washes it passes through; over bare paper, and on short very dark
 * marks (eyes, nostrils, a mouth), it keeps the ink. Off (opts.colour === false): one ink.
 * toPicture: world point => [u, v] over the picture (0..1).
 */
function colouredThread(prepared, strokes, opts, toPicture) {
  if (opts.colour === false) return null;
  const { width: w, height: h } = prepared.pixels;
  if (!strokes.colourMap) strokes.colourMap = threadColours(prepared.pixels, identityMarks(strokes, prepared.strokeImage, w, h));
  const map = strokes.colourMap;
  return (q) => { const [u, v] = toPicture(q); return map(u, v); };
}

function wireMaterial(tube, g) {
  if (tube.colors) {
    g.setAttribute('color', new THREE.BufferAttribute(tube.colors, 3));
    return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 });
  }
  return new THREE.MeshStandardMaterial({ color: 0x1a1611, roughness: 0.4, metalness: 0.3 });
}

/** One thread routed along the ink (cached with the strokes): joins run on drawn lines. */
function threadFor(strokes) {
  if (!strokes.thread) strokes.thread = threadThroughInk(strokes);
  return strokes.thread;
}

/**
 * The drawn thread, then each stitched outline, as one path. Every outline starts at its point
 * nearest to where the thread is, and the way there runs along the drawing's ink on the front
 * surface, so no straight join cuts across a face (31.10.2026, faces painting).
 */
function joinAlongInk(thread, loops, strokes, size, heightAt, k, unit, w0, h0) {
  const { sw, sh } = size;
  const route = makeRouter(strokes);
  const toPx = (X, Y) => [((X / unit + w0 / 2) / (w0 - 1)) * (sw - 1), ((h0 / 2 - Y / unit) / (h0 - 1)) * (sh - 1)];
  const lift = ([x, y]) => {
    const u = x / (sw - 1), v = y / (sh - 1);
    return [(u * (w0 - 1) - w0 / 2) * unit, (h0 / 2 - v * (h0 - 1)) * unit, heightAt(u, v) * k, 1];
  };
  const path = thread.slice();
  const left = loops.slice();
  while (left.length) {
    const e = path.at(-1);
    let bi = 0, bj = 0, bd = Infinity;
    left.forEach((l, i) => l.forEach((q, j) => {
      const d = (q[0] - e[0]) ** 2 + (q[1] - e[1]) ** 2;
      if (d < bd) { bd = d; bi = i; bj = j; }
    }));
    const l = left.splice(bi, 1)[0];
    const loop = l.slice(bj).concat(l.slice(0, bj)); // an outline is closed: start where it is nearest
    const a = toPx(e[0], e[1]), b = toPx(loop[0][0], loop[0][1]);
    const r = Math.hypot(b[0] - a[0], b[1] - a[1]) > 3 ? route(a, b) : null;
    if (r) for (let i = 1; i < r.length - 1; i++) path.push(lift(r[i]));
    for (const q of loop) path.push(q);
  }
  return path;
}

/** Inflated closed body. */
export function sculptMesh(prepared, opts) {
  const m = buildSculpt(prepared.analysis, opts);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: prepared.texture, roughness: 0.82, metalness: 0 });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'sculpt';
  return { object: mesh, closed: isClosed(m.indices) };
}

/** Line sculpture: the ink as one wire in space, colour as transparent smoke. */
/** How the picture is read: 'object' (inflated and wrapped) or 'scene' (laid out in depth). */
export function readingOf(prepared, choice = 'auto') {
  if (choice === 'object' || choice === 'scene') return choice;
  return isLandscape(prepared.horizon) || !prepared.analysis ? 'scene' : 'object';
}

export function lineSculpture(prepared, opts) {
  if (readingOf(prepared, opts.reading) === 'scene') return sceneSculpture(prepared, opts);
  if (!prepared.analysis) throw prepared.analysisError;
  const a = prepared.analysis;
  const { W, pad, w0, h0 } = a;
  const unit = 2 / Math.max(w0, h0);
  const h = heightField(a, { volume: 0.6, line: 0 });
  const sample = (gx, gy) => {
    const x0 = Math.max(0, Math.min(W - 2, Math.floor(gx))), y0 = Math.max(0, Math.min(a.H - 2, Math.floor(gy)));
    const fx = Math.min(1, Math.max(0, gx - x0)), fy = Math.min(1, Math.max(0, gy - y0));
    const p = y0 * W + x0;
    return (h[p] * (1 - fx) + h[p + 1] * fx) * (1 - fy) + (h[p + W] * (1 - fx) + h[p + W + 1] * fx) * fy;
  };
  const gxy = (u, v) => [u * (w0 - 1) + pad, v * (h0 - 1) + pad];
  const heightAt = (u, v) => sample(...gxy(u, v)) * unit;
  const toWorld = (u, v) => [(u * (w0 - 1) - w0 / 2) * unit, (h0 / 2 - v * (h0 - 1)) * unit];

  const strokes = strokesFor(prepared, opts.sensitivity);
  const thickness = Math.max(0, Math.min(1, opts.thickness ?? LINE_DEFAULTS.thickness));
  // The wire has the drawing's line weight (measured), scaled by the thickness slider.
  const radius = opts.radius ?? wireRadius(strokes.lineWidth ?? 3, 2 / Math.max(prepared.strokeSize.sw, prepared.strokeSize.sh), thickness);

  // Wrapping loops lie on the same surface as the strokes (same depth scale), just outside it.
  const k = depthScale(opts.depth);
  const zGrid = (gx, gy) => sample(gx, gy) * unit * k;
  const toWGrid = (gx, gy) => [(gx - pad - w0 / 2) * unit, (h0 / 2 - (gy - pad)) * unit];
  // The wrap binds the outline like a whip stitch, so the drawing inside stays readable from the
  // front (Anat, 31.10.2026). The free spiral around the parts remains for shapes with no outline.
  let loops = stitchLoops(a, zGrid, toWGrid, { wrap: opts.wrap, lift: radius * 0.6 });
  if (!loops.length && (opts.wrap ?? LINE_DEFAULTS.wrap) > 0) loops = wrapLoops(a, zGrid, toWGrid, { wrap: opts.wrap, lift: radius * 0.6 });

  // One thread: the strokes joined along the ink (a one-line drawing), then the wrapping.
  const continuous = opts.continuous ?? LINE_DEFAULTS.continuous;
  const thread = continuous && strokes.length > 1 ? threadFor(strokes) : null;
  const drawnPaths = thread ? [thread.path] : strokes;
  const paths = thread && loops.length
    ? [joinAlongInk(liftStrokes(drawnPaths, prepared.strokeSize, heightAt, toWorld, { ...opts, extra: [] })[0], loops, strokes, prepared.strokeSize, heightAt, k, unit, w0, h0)]
    : liftStrokes(drawnPaths, prepared.strokeSize, heightAt, toWorld, { ...opts, extra: loops });
  // The thread's colour: from the front, a point at (X, Y) sits over its place in the drawing.
  const colourAt = colouredThread(prepared, strokes, opts, ([X, Y]) => [
    (X / unit + w0 / 2) / (w0 - 1), (h0 / 2 - Y / unit) / (h0 - 1),
  ]);
  const tube = tubeMesh(paths, radius, 8, { colorAt: colourAt });
  if (!tube.triangles) throw Object.assign(new Error('no_lines'), { code: 'no_lines' });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tube.positions, 3));
  g.setIndex(new THREE.BufferAttribute(tube.indices, 1));
  g.computeVertexNormals();
  // One line: the drawn line, the joins and the wrapping are one thread, one weight, no seam.
  // Its colour follows the drawing and passes smoothly from colour to colour (31.10.2026).
  const wire = new THREE.Mesh(g, wireMaterial(tube, g));
  wire.name = 'line';

  const group = new THREE.Group();
  group.add(wire);
  const cloud = opts.cloud === true ? 0.6 : opts.cloud === false ? 0 : (opts.cloud ?? LINE_DEFAULTS.cloud);
  let cloudPoints = null;
  if (cloud > 0) {
    cloudPoints = colourCloud(prepared, sample, unit * k, gxy, toWorld, cloud);
    if (cloudPoints) group.add(cloudPoints);
  }
  return {
    object: group, closed: isClosed(tube.indices), lines: strokes.length, loops: loops.turns ?? loops.length,
    continuous: paths.length === 1 && strokes.length + loops.length > 1,
    animation: drawingAnimation(group, g, tube.timeline, cloudPoints, radius),
  };
}

/**
 * Drawing the work from the first line to the last: the thread is revealed along its own
 * timeline (drawn lines at pen speed, wrapping faster), a warm pen tip leads it, and the
 * colour is sprayed in at the end. set(p) with p from 0 to 1.
 */
export function drawingAnimation(group, wireGeometry, tl, cloudPoints, radius) {
  const steps = tl.end.length;
  const duration = Math.max(10, Math.min(30, 8 + tl.duration * 0.45)); // seconds
  const lineShare = cloudPoints ? 0.86 : 1;
  const cloudCount = cloudPoints ? cloudPoints.geometry.attributes.position.count : 0;

  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g2 = c.getContext('2d');
  const r = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,236,200,1)');
  r.addColorStop(0.25, 'rgba(232,178,106,0.9)');
  r.addColorStop(1, 'rgba(232,178,106,0)');
  g2.fillStyle = r;
  g2.fillRect(0, 0, 64, 64);
  const tip = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthWrite: false, depthTest: false, transparent: true }));
  tip.renderOrder = 10; // the pen is always seen, also behind the wire
  tip.name = 'tip';
  tip.scale.setScalar(Math.max(0.07, radius * 14));
  tip.visible = false;

  let attached = false;
  function set(p) {
    p = Math.max(0, Math.min(1, p));
    if (!attached) { group.add(tip); attached = true; } // after framing, so it never changes the bounds
    const q = Math.min(1, p / lineShare);
    if (q >= 1 || !steps) {
      wireGeometry.setDrawRange(0, Infinity);
      tip.visible = false;
    } else {
      const target = q * tl.duration;
      let lo = 0, hi = steps - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tl.time[mid] < target) lo = mid + 1; else hi = mid; }
      wireGeometry.setDrawRange(0, q <= 0 ? 0 : tl.end[lo]);
      tip.position.set(tl.tip[lo * 3], tl.tip[lo * 3 + 1], tl.tip[lo * 3 + 2]);
      tip.visible = q > 0;
    }
    if (cloudPoints) {
      const cp = lineShare >= 1 ? 1 : Math.max(0, Math.min(1, (p - lineShare) / (1 - lineShare)));
      cloudPoints.geometry.setDrawRange(0, p >= 1 ? Infinity : Math.floor(cp * cloudCount));
    }
  }
  return { duration, set };
}

// Two-pass chamfer distance (1, 1.4) to the nearest pixel outside the mask.
function chamfer2(m, w, h) {
  const d = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) d[p] = m[p] ? 1e6 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!d[p]) continue;
    if (x > 0) d[p] = Math.min(d[p], d[p - 1] + 1);
    if (y > 0) d[p] = Math.min(d[p], d[p - w] + 1);
    if (x > 0 && y > 0) d[p] = Math.min(d[p], d[p - w - 1] + 1.4);
    if (x < w - 1 && y > 0) d[p] = Math.min(d[p], d[p - w + 1] + 1.4);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const p = y * w + x;
    if (!d[p]) continue;
    if (x < w - 1) d[p] = Math.min(d[p], d[p + 1] + 1);
    if (y < h - 1) d[p] = Math.min(d[p], d[p + w] + 1);
    if (x < w - 1 && y < h - 1) d[p] = Math.min(d[p], d[p + w + 1] + 1.4);
    if (x > 0 && y < h - 1) d[p] = Math.min(d[p], d[p + w - 1] + 1.4);
  }
  return d;
}

// A wash is clearly coloured: relative saturation, so skin, paper and pencil grey stay clear
// (a skin tone is about 0.28, the pink and orange washes 0.8 and more).
function isWash(d, i) {
  const mx = Math.max(d[i], d[i + 1], d[i + 2]);
  return mx > 40 && (mx - Math.min(d[i], d[i + 1], d[i + 2])) / mx >= 0.36;
}

// Colour as sprayed pigment in the air: soft round puffs of different sizes and transparencies,
// coloured by the local average of the wash, spread through the depth of the body.
function colourCloud(prepared, sample, zScale, gxy, toWorld, amount) {
  const { width: w, height: hh, data } = prepared.pixels;
  // Local average colour (5x5) of the coloured pixels: a wash, not a speckle.
  const avg = (x, y) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(hh - 1, Math.max(0, y + dy)), i = (yy * w + xx) * 4;
      if (!isWash(data, i)) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    return n ? [r / n / 255, g / n / 255, b / n / 255] : null;
  };
  const pos = [], tint = [], size = [], alpha = [];
  let seed = 4242;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // As many puffs as the colour needs: a colour-led illustration gets a dense spray that holds
  // the shape of each wash (pink hair, blue dress, striped stockings), a line drawing with a
  // little colour gets a light one. Anat, 31.10.2026: the colour is what makes it recognisable.
  let coloured = 0;
  const wash = new Uint8Array(w * hh);
  for (let p = 0; p < w * hh; p++) if (isWash(data, p * 4)) { wash[p] = 1; coloured++; }
  // Distance (pixels) to the edge of the wash: a puff never spills over its wash
  // (the hair colour stays off the faces), so the spray keeps the drawing's shapes.
  const edge = chamfer2(wash, w, hh);
  const pxToWorld = Math.abs(toWorld(1 / (w - 1), 0)[0] - toWorld(0, 0)[0]);
  const share = coloured / (w * hh);
  const target = Math.round(Math.min(9000, 250 + coloured * (0.25 + 0.75 * amount)));
  const small = Math.max(0.35, 1 - share * 1.4); // dense colour: smaller puffs keep the edges of each wash
  for (let k = 0; k < 120000 && size.length < target; k++) {
    const x = Math.floor(rnd() * w), y = Math.floor(rnd() * hh), i = (y * w + x) * 4;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (!isWash(data, i) || lum < 55) continue;
    const u = x / (w - 1), v = y / (hh - 1);
    const depth = sample(...gxy(u, v)) * zScale;
    if (!(depth > 0)) continue;
    const c = avg(x, y);
    if (!c) continue;
    const [X, Y] = toWorld(u, v);
    pos.push(X + (rnd() - 0.5) * 0.03, Y + (rnd() - 0.5) * 0.03, (rnd() * 2 - 1) * depth * 0.95);
    tint.push(...c);
    const room = (edge[y * w + x] + 1.5) * pxToWorld * 2.4;                       // the puff's diameter fits its wash
    size.push(Math.min(room, (0.05 + Math.pow(rnd(), 2) * 0.3) * small));       // many small, a few large puffs
    alpha.push((0.05 + Math.pow(rnd(), 3) * 0.22 + share * 0.18) * (0.5 + amount)); // denser where colour leads
  }
  if (size.length < 20) return null;
  return cloudPoints(pos, tint, size, alpha);
}

/** Soft airbrush puffs: positions, colours, world sizes and opacities. */
function cloudPoints(pos, tint, size, alpha) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('tint', new THREE.Float32BufferAttribute(tint, 3));
  g.setAttribute('size', new THREE.Float32BufferAttribute(size, 1));
  g.setAttribute('alpha', new THREE.Float32BufferAttribute(alpha, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 400 } },
    vertexShader: `
      attribute vec3 tint; attribute float size; attribute float alpha;
      uniform float uScale; varying vec3 vTint; varying float vAlpha;
      void main() {
        vTint = tint; vAlpha = alpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float k = length(modelMatrix[0].xyz); // the stage scales the work: puffs scale with it
        gl_PointSize = size * k * uScale / max(0.001, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vTint; varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float a = exp(-d * d * 3.2) * vAlpha;   // airbrush falloff
        gl_FragColor = vec4(vTint, a);
      }`,
    transparent: true, depthWrite: false,
  });
  const p = new THREE.Points(g, m);
  p.name = 'cloud';
  // Point size in pixels follows the canvas height and the camera's field of view.
  p.onBeforeRender = (renderer, scene, camera) => {
    m.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
  };
  return p;
}
