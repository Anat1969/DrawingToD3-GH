// Browser side of the local sculpting engine: reads the drawing, builds a Three.js mesh.
import * as THREE from 'three';
import { analysePixels, buildSculpt, isClosed, DEFAULTS } from './sculpt-core.js';

export { DEFAULTS };
const GRID = 200;      // analysis resolution (longest side)
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

/** Analyse once per drawing; rebuilding with new slider values is then fast. */
export async function prepareSculpt(src) {
  const img = await loadImage(src);
  const small = draw(img, GRID);
  const data = small.getContext('2d').getImageData(0, 0, small.width, small.height);
  const analysis = analysePixels(data);
  const texture = new THREE.CanvasTexture(draw(img, TEXTURE));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { analysis, texture };
}

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
