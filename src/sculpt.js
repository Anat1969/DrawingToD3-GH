// Browser side of the local engines: reads the drawing once, then builds
// either the inflated body or the line sculpture with Three.js.
import * as THREE from 'three';
import { analysePixels, buildSculpt, heightField, isClosed, DEFAULTS } from './sculpt-core.js';
import { extractStrokes, liftStrokes, tubeMesh, wrapLoops, depthScale, LINE_DEFAULTS } from './line-core.js';

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
  const analysis = analysePixels(pixels);
  const strokeCanvas = draw(img, STROKES);
  const strokeImage = strokeCanvas.getContext('2d').getImageData(0, 0, strokeCanvas.width, strokeCanvas.height);
  const texture = new THREE.CanvasTexture(draw(img, TEXTURE));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { analysis, pixels, strokeImage, strokeCache: new Map(), strokeSize: { sw: strokeCanvas.width, sh: strokeCanvas.height }, texture };
}

/** Strokes for a sensitivity, cached: moving other sliders does not re-trace the drawing. */
function strokesFor(prepared, sensitivity) {
  const key = Math.round((sensitivity ?? LINE_DEFAULTS.sensitivity) * 20);
  if (!prepared.strokeCache.has(key)) prepared.strokeCache.set(key, extractStrokes(prepared.strokeImage, { sensitivity: key / 20 }));
  return prepared.strokeCache.get(key);
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
export function lineSculpture(prepared, opts) {
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
  const radius = 0.004 + 0.02 * thickness;

  // Wrapping loops lie on the same surface as the strokes (same depth scale), just outside it.
  const k = depthScale(opts.depth);
  const zGrid = (gx, gy) => sample(gx, gy) * unit * k;
  const toWGrid = (gx, gy) => [(gx - pad - w0 / 2) * unit, (h0 / 2 - (gy - pad)) * unit];
  const loops = wrapLoops(a, zGrid, toWGrid, { wrap: opts.wrap, lift: radius * 0.6 });

  const paths = liftStrokes(strokes, prepared.strokeSize, heightAt, toWorld, { ...opts, extra: loops });
  const tube = tubeMesh(paths, radius, 8);
  if (!tube.triangles) throw Object.assign(new Error('no_lines'), { code: 'no_lines' });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tube.positions, 3));
  g.setIndex(new THREE.BufferAttribute(tube.indices, 1));
  g.computeVertexNormals();
  // One line, one colour: the drawing's ink continues into the wrapping without a seam.
  const wire = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x1a1611, roughness: 0.4, metalness: 0.3 }));
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

// Colour as sprayed pigment in the air: soft round puffs of different sizes and transparencies,
// coloured by the local average of the wash, spread through the depth of the body.
function colourCloud(prepared, sample, zScale, gxy, toWorld, amount) {
  const { width: w, height: hh, data } = prepared.pixels;
  // Local average colour (5x5) of the coloured pixels: a wash, not a speckle.
  const avg = (x, y) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(hh - 1, Math.max(0, y + dy)), i = (yy * w + xx) * 4;
      const sat = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
      if (sat < 22) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    return n ? [r / n / 255, g / n / 255, b / n / 255] : null;
  };
  const pos = [], tint = [], size = [], alpha = [];
  let seed = 4242;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const target = Math.round(250 + 900 * amount);
  for (let k = 0; k < 40000 && size.length < target; k++) {
    const x = Math.floor(rnd() * w), y = Math.floor(rnd() * hh), i = (y * w + x) * 4;
    const sat = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (sat < 28 || lum < 55) continue;
    const u = x / (w - 1), v = y / (hh - 1);
    const depth = sample(...gxy(u, v)) * zScale;
    if (!(depth > 0)) continue;
    const c = avg(x, y);
    if (!c) continue;
    const [X, Y] = toWorld(u, v);
    pos.push(X + (rnd() - 0.5) * 0.03, Y + (rnd() - 0.5) * 0.03, (rnd() * 2 - 1) * depth * 0.95);
    tint.push(...c);
    size.push(0.06 + Math.pow(rnd(), 2) * 0.34);                       // many small, a few large puffs
    alpha.push((0.035 + Math.pow(rnd(), 3) * 0.2) * (0.5 + amount));    // mostly faint, some denser
  }
  if (size.length < 20) return null;
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
        gl_PointSize = size * uScale / max(0.001, -mv.z);
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
