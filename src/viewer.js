// Stage: a Three.js viewer lit like the inspiration image.
// One warm window light from the side, a soft shadow, a weak fill, fog that swallows the distance.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const DARK = new THREE.Color(0x0c0b09);
const PAPER = new THREE.Color(0xece6da);
const SIZE = 2; // the subject is normalised to this size

// View-mode state per mesh. Kept outside userData, because GLTFExporter writes userData into the file.
const viewState = new WeakMap();
const vs = (m) => { let v = viewState.get(m); if (!v) { v = {}; viewState.set(m, v); } return v; };

export function createStage(container, { onFrame } = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = DARK.clone();
  scene.fog = new THREE.Fog(DARK.clone(), 5, 11);

  // A dim room reflection so textured materials do not look flat. Kept low: low key.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.22;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
  camera.position.set(-2.6, 1.5, 4.2);

  const hemi = new THREE.HemisphereLight(0xb9c2cc, 0x2a1f14, 0.16);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffd9a8, 3.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 14;
  key.shadow.camera.left = key.shadow.camera.bottom = -3;
  key.shadow.camera.right = key.shadow.camera.top = 3;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 6;
  scene.add(key, key.target);

  const rim = new THREE.DirectionalLight(0x9fb2c8, 0.6);
  rim.position.set(0, 2.5, -4);
  scene.add(rim);

  // Invisible floor that only receives the shadow. No grid, no axes.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.55 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 1.6;
  controls.maxDistance = 9;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.autoRotate = !reduced;
  controls.autoRotateSpeed = 0.9;
  controls.target.set(0, 0.8, 0);

  let holder = null;      // group holding the current subject
  let info = null;        // facts about the subject
  let mode = 'source';
  let lightAngle = 300;

  function setLight(deg) {
    lightAngle = deg;
    const a = THREE.MathUtils.degToRad(deg);
    const r = 5;
    key.position.set(Math.cos(a) * r, 2.6, Math.sin(a) * r);
    key.target.position.set(0, 0.5, 0);
  }
  setLight(lightAngle);

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const hooks = []; // per-frame work of other modules (the 3D drawing sheet and pen)
  let running = true;
  document.addEventListener('visibilitychange', () => {
    running = document.visibilityState === 'visible';
    if (running) requestAnimationFrame(loop);
  });
  function loop() {
    if (!running) return;
    controls.update();
    for (const fn of hooks) fn();
    renderer.render(scene, camera);
    if (onFrame && holder) onFrame(project());
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Screen-space circle around the subject's bounding sphere, for the annotation.
  const tmp = new THREE.Vector3();
  function project() {
    if (!holder) return null;
    const sphere = info.sphere;
    tmp.copy(sphere.center).project(camera);
    const w = container.clientWidth, h = container.clientHeight;
    const cx = (tmp.x * 0.5 + 0.5) * w;
    const cy = (-tmp.y * 0.5 + 0.5) * h;
    const dist = camera.position.distanceTo(sphere.center);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const r = (sphere.radius / (dist * Math.tan(fov / 2))) * (h / 2);
    return { cx, cy, r: r * 0.82, w, h };
  }

  function prepare(object) {
    const meshes = [];
    let tris = 0;
    object.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      if (!vs(o).source) vs(o).source = o.material; // a refreshed mesh keeps its real material
      meshes.push(o);
      const g = o.geometry;
      tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    });
    return { meshes, tris: Math.round(tris) };
  }

  function setObject(object, meta = {}, opts = {}) {
    clear();
    const { meshes, tris } = prepare(object);
    if (!meshes.length) throw new Error('empty_model');

    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = SIZE / Math.max(size.x, size.y, size.z, 1e-6);

    object.position.sub(center);
    holder = new THREE.Group();
    holder.add(object);
    holder.scale.setScalar(s);
    holder.position.y = (size.y * s) / 2; // stand on the floor
    scene.add(holder);

    const worldBox = new THREE.Box3().setFromObject(holder);
    const sphere = worldBox.getBoundingSphere(new THREE.Sphere());
    const max = Math.max(size.x, size.y, size.z);
    info = {
      meshes, tris, sphere,
      proportion: [size.x, size.y, size.z].map((v) => Math.round((v / max) * 100)),
      ...meta,
    };

    // Frame with generous dark space around the subject (low key: the darkness does the rest).
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const dist = (sphere.radius / Math.sin(fov / 2)) * 1.35;
    if (opts.keepView) { applyMode(mode); return info; } // live slider edits: do not move the camera
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).add(new THREE.Vector3(-0.5, 0.22, 0.84).normalize().multiplyScalar(dist));
    controls.minDistance = dist * 0.45;
    controls.maxDistance = dist * 2.2;
    scene.fog.near = dist * 0.9;
    scene.fog.far = dist * 2.4;
    controls.update();
    applyMode(mode);
    return info;
  }

  // A subject in its own world coordinates, not normalised: the 3D drawing needs a space
  // that stays put while lines are added to it. refresh() re-reads it after each change.
  let rawMeta = null;
  function setRaw(object, meta = {}, { view } = {}) {
    clear();
    holder = new THREE.Group();
    holder.add(object);
    scene.add(holder);
    rawMeta = meta;
    if (view) {
      controls.target.set(...view.target);
      camera.position.set(...view.position);
      controls.minDistance = 0.8;
      controls.maxDistance = 14;
      scene.fog.near = 7;
      scene.fog.far = 22;
      controls.update();
    }
    return refresh();
  }

  function refresh(meta) {
    if (!holder || !rawMeta) return info;
    if (meta) rawMeta = { ...rawMeta, ...meta };
    const { meshes, tris } = prepare(holder);
    const box = new THREE.Box3();
    for (const m of meshes) box.expandByObject(m);
    let sphere, proportion = null;
    if (box.isEmpty()) {
      sphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 1);
    } else {
      sphere = box.getBoundingSphere(new THREE.Sphere());
      const size = box.getSize(new THREE.Vector3());
      const max = Math.max(size.x, size.y, size.z, 1e-6);
      proportion = [size.x, size.y, size.z].map((v) => Math.round((v / max) * 100));
    }
    info = { meshes, tris, sphere, proportion, ...rawMeta };
    applyMode(mode);
    return info;
  }

  function clear() {
    if (!holder) return;
    scene.remove(holder);
    holder.traverse((o) => {
      if (!o.isMesh) return;
      const v = viewState.get(o);
      if (v && v.edges) v.edges.geometry.dispose();
      o.geometry.dispose();
    });
    holder = null;
    info = null;
    rawMeta = null;
  }

  const clay = new THREE.MeshStandardMaterial({ color: 0xcfc4b2, roughness: 0.92, metalness: 0 });
  const inkLine = new THREE.LineBasicMaterial({ color: 0x17140f });

  let backdrop = 'dark'; // 'paper' for line sculptures: a black line needs a light ground
  function applyMode(next) {
    mode = next;
    const paper = mode === 'ink' || backdrop === 'paper';
    scene.background.copy(paper ? PAPER : DARK);
    scene.fog.color.copy(paper ? PAPER : DARK);
    floor.material.opacity = paper ? 0.16 : 0.55;
    renderer.toneMappingExposure = paper ? 1.05 : 0.85;
    container.classList.toggle('paper', paper);
    if (!holder) return;

    for (const m of info.meshes) {
      const v = vs(m);
      if (v.edges) v.edges.visible = false;
      if (mode === 'source') {
        m.material = v.source;
      } else if (mode === 'clay') {
        m.material = clay;
      } else {
        // Line as volume, colour as transparent smoke.
        const src = Array.isArray(v.source) ? v.source[0] : v.source;
        if (!v.smoke) {
          v.smoke = new THREE.MeshBasicMaterial({
            map: src && src.map ? src.map : null,
            color: src && src.map ? 0xffffff : 0xb9ad99,
            transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide,
          });
        }
        m.material = v.smoke;
        if (m.name === 'line') { m.material = v.source; continue; } // a wire is already a line
        if (!v.edges) {
          v.edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 28), inkLine);
          m.add(v.edges);
        }
        v.edges.visible = true;
      }
      m.castShadow = mode !== 'ink';
    }
  }

  function loadUrl(url, kind = 'glb') {
    return new Promise((resolve, reject) => {
      const done = (obj) => resolve(obj);
      if (kind === 'stl') {
        new STLLoader().load(url, (g) => done(stlMesh(g)), undefined, reject);
      } else if (kind === 'obj') {
        new OBJLoader().load(url, done, undefined, reject);
      } else {
        const loader = new GLTFLoader();
        loader.setCrossOrigin('anonymous');
        loader.load(url, (gltf) => done(gltf.scene), undefined, reject);
      }
    });
  }

  function stlMesh(geometry) {
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xcfc4b2, roughness: 0.85 }));
  }

  async function exportFile(format) {
    if (!holder) return null;
    const subject = holder.children[0];
    const was = mode;
    const overlays = [];
    subject.traverse((o) => { if (o.isSprite) overlays.push(o); }); // the pen tip is not part of the work
    overlays.forEach((o) => o.parent.remove(o));
    applyMode('source'); // export the real materials, not the view mode
    for (const m of info.meshes) { const v = viewState.get(m); if (v && v.edges) m.remove(v.edges); }
    try {
      if (format === 'stl') {
        const data = new STLExporter().parse(subject, { binary: true });
        return new Blob([data], { type: 'model/stl' });
      }
      const data = await new GLTFExporter().parseAsync(subject, { binary: true });
      return new Blob([data], { type: 'model/gltf-binary' });
    } finally {
      for (const m of info.meshes) { const v = viewState.get(m); if (v && v.edges) m.add(v.edges); }
      overlays.forEach((o) => subject.add(o));
      applyMode(was);
    }
  }

  // A still of the stage for the archive card. Rendered and read in the same task,
  // so it works without preserveDrawingBuffer.
  function snapshot(side = 480) {
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const k = side / Math.max(src.width, src.height);
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * k);
    c.height = Math.round(src.height * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  }

  return {
    setObject, setRaw, refresh, loadUrl, clear, exportFile, snapshot,
    scene, camera, controls,
    addFrameHook(fn) { hooks.push(fn); },
    setMode: applyMode,
    canvas: renderer.domElement,
    setBackdrop(next) { backdrop = next; applyMode(mode); },
    setLight,
    setSpin(on) { controls.autoRotate = on; },
    /** Straight on, the way the drawing was made: the view to judge resemblance from. */
    viewFront() {
      if (!info) return;
      const c = info.sphere.center;
      const dist = (info.sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.12;
      controls.autoRotate = false;
      controls.target.copy(c);
      camera.position.set(c.x, c.y, c.z + dist);
      controls.update();
    },
    get info() { return info; },
    get hasSubject() { return !!holder; },
    THREE,
  };
}

// A sample subject: a small house in three quarters, as an architect would draw it.
export function sampleObject(THREE_) {
  const T = THREE_ || THREE;
  const g = new T.Group();
  const wall = new T.MeshStandardMaterial({ color: 0xd9cdb8, roughness: 0.9 });
  const roof = new T.MeshStandardMaterial({ color: 0x6f6a52, roughness: 0.8 });
  const dark = new T.MeshStandardMaterial({ color: 0x2a241c, roughness: 0.7 });
  const warm = new T.MeshStandardMaterial({ color: 0xe8b26a, emissive: 0xe8b26a, emissiveIntensity: 0.6, roughness: 0.5 });

  const body = new T.Mesh(new T.BoxGeometry(1.6, 1, 1.1), wall);
  body.position.y = 0.5;
  g.add(body);

  const shape = new T.Shape();
  shape.moveTo(-0.9, 0); shape.lineTo(0.9, 0); shape.lineTo(0, 0.75); shape.closePath();
  const roofGeo = new T.ExtrudeGeometry(shape, { depth: 1.24, bevelEnabled: false });
  roofGeo.translate(0, 1, -0.62);
  g.add(new T.Mesh(roofGeo, roof));

  const chimney = new T.Mesh(new T.BoxGeometry(0.18, 0.5, 0.18), wall);
  chimney.position.set(0.45, 1.45, 0.2);
  g.add(chimney);

  const door = new T.Mesh(new T.BoxGeometry(0.3, 0.55, 0.02), dark);
  door.position.set(-0.35, 0.275, 0.56);
  g.add(door);

  const win = new T.Mesh(new T.BoxGeometry(0.34, 0.3, 0.02), warm);
  win.position.set(0.35, 0.6, 0.56);
  g.add(win);

  const side = new T.Mesh(new T.BoxGeometry(0.02, 0.3, 0.3), warm);
  side.position.set(0.81, 0.6, 0);
  g.add(side);
  return g;
}
