// Browser side of the local engines: reads the drawing once, then builds
// either the inflated body or the line sculpture with Three.js.
import * as THREE from 'three';
import { analysePixels, buildSculpt, heightField, isClosed, DEFAULTS } from './sculpt-core.js';
import { extractStrokes, liftStrokes, tubeMesh, LINE_DEFAULTS } from './line-core.js';

export { DEFAULTS, LINE_DEFAULTS };
const GRID = 200;      // body analysis resolution (longest side)
const STROKES = 420;   // stroke analysis resolution (longest side)
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
  const strokes = extractStrokes(strokeCanvas.getContext('2d').getImageData(0, 0, strokeCanvas.width, strokeCanvas.height));
  const texture = new THREE.CanvasTexture(draw(img, TEXTURE));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { analysis, pixels, strokes, strokeSize: { sw: strokeCanvas.width, sh: strokeCanvas.height }, texture };
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

  const paths = liftStrokes(prepared.strokes, prepared.strokeSize, heightAt, toWorld, opts);
  const thickness = Math.max(0, Math.min(1, opts.thickness ?? LINE_DEFAULTS.thickness));
  const radius = 0.004 + 0.02 * thickness;
  const tube = tubeMesh(paths, radius, 8);
  if (!tube.triangles) throw Object.assign(new Error('no_lines'), { code: 'no_lines' });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tube.positions, 3));
  g.setIndex(new THREE.BufferAttribute(tube.indices, 1));
  g.computeVertexNormals();
  const wire = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x1d1913, roughness: 0.36, metalness: 0.45 }));
  wire.name = 'line';

  const group = new THREE.Group();
  group.add(wire);
  if (opts.smoke !== false) {
    const smoke = colourSmoke(prepared, heightAt, toWorld, unit);
    if (smoke) group.add(smoke);
  }
  return { object: group, closed: isClosed(tube.indices), lines: prepared.strokes.length, continuous: paths.length === 1 && prepared.strokes.length > 1 };
}

let sprite = null;
function softSprite() {
  if (sprite) return sprite;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  sprite = new THREE.CanvasTexture(c);
  return sprite;
}

// Colour washes become a translucent cloud inside the volume the drawing describes.
function colourSmoke(prepared, heightAt, toWorld, unit) {
  const { pixels } = prepared;
  const { width: w, height: hh, data } = pixels;
  const pos = [], col = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 24000 && pos.length < 2600 * 3; k++) {
    const x = Math.floor(rnd() * w), y = Math.floor(rnd() * hh), i = (y * w + x) * 4;
    const r = data[i], gg = data[i + 1], b = data[i + 2];
    const sat = Math.max(r, gg, b) - Math.min(r, gg, b);
    const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
    if (sat < 32 || lum < 60) continue;
    const u = x / (w - 1), v = y / (hh - 1);
    const depth = heightAt(u, v);
    if (depth <= 0) continue;
    const [X, Y] = toWorld(u, v);
    pos.push(X + (rnd() - 0.5) * 6 * unit, Y + (rnd() - 0.5) * 6 * unit, (rnd() * 2 - 1) * depth * 0.9);
    col.push(r / 255, gg / 255, b / 255);
  }
  if (pos.length < 30) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ size: 0.11, map: softSprite(), vertexColors: true, transparent: true, opacity: 0.32, depthWrite: false, sizeAttenuation: true });
  const p = new THREE.Points(g, m);
  p.name = 'smoke';
  return p;
}
