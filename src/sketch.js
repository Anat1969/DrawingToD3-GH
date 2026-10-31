// Drawing in 3D, browser side: the pen, the transparent sheet, and the wire.
// The pure geometry lives in sketch-core.js. The wire is built with the same tube as the
// line sculpture, so a drawing made here and a drawing turned into a line are the same material.
import * as THREE from 'three';
import { tubeMesh } from './line-core.js';
import { isClosed } from './sculpt-core.js';
import { drawingAnimation } from './sculpt.js';
import * as core from './sketch-core.js';

const INK = 0x1a1611;   // one line, one colour (the same as the line sculpture)
const SHEET = 2.6;      // size of the drawing sheet, world units
const START_VIEW = { target: [0, 1, 0], position: [-1.25, 1.6, 4.05] }; // three quarters: the sheet reads as a plane in space

export function createSketch(stage, { onChange = () => {}, onBeforeDraw = () => {} } = {}) {
  const { scene, camera, controls, canvas } = stage;
  const wireMat = new THREE.MeshStandardMaterial({ color: INK, roughness: 0.4, metalness: 0.3 });
  const group = new THREE.Group();
  group.name = 'sketch';

  let strokes = [];
  let undoStack = [], redoStack = [];
  let params = core.normalizeParams();
  let tool = 'pen';
  let tempOrbit = false;  // Space held: orbit for a moment, then back to the pen
  let active = false;
  let hideHelpers = false;
  let anim = null;
  let closed = null;

  /* ---------- helpers: sheet, pen, drop line (never part of the work) ---------- */
  const helpers = new THREE.Group();
  helpers.name = 'sketch-helpers';
  helpers.visible = false;
  scene.add(helpers);

  const sheet = new THREE.Group();
  const fillMat = new THREE.MeshBasicMaterial({ color: 0x17140f, transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide });
  sheet.add(new THREE.Mesh(new THREE.PlaneGeometry(SHEET, SHEET), fillMat));
  const gridPts = [];
  const h = SHEET / 2;
  for (let i = 0; i <= 8; i++) {
    const t = -h + (i / 8) * SHEET;
    gridPts.push(-h, t, 0, h, t, 0, t, -h, 0, t, h, 0);
  }
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
  const gridMat = new THREE.LineBasicMaterial({ color: 0x17140f, transparent: true, opacity: 0.08, depthWrite: false });
  sheet.add(new THREE.LineSegments(gridGeo, gridMat));
  const frameGeo = new THREE.BufferGeometry();
  frameGeo.setAttribute('position', new THREE.Float32BufferAttribute([-h, -h, 0, h, -h, 0, h, -h, 0, h, h, 0, h, h, 0, -h, h, 0, -h, h, 0, -h, -h, 0], 3));
  const frameMat = new THREE.LineBasicMaterial({ color: 0x17140f, transparent: true, opacity: 0.32, depthWrite: false });
  sheet.add(new THREE.LineSegments(frameGeo, frameMat));
  helpers.add(sheet);

  // The pen tip: the window light, always seen. A ring around it when it will continue a line.
  const pen = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 12), new THREE.MeshBasicMaterial({ color: 0xe8b26a, depthTest: false, transparent: true }));
  pen.renderOrder = 20;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.055, 32), new THREE.MeshBasicMaterial({ color: 0xb8803f, depthTest: false, transparent: true, side: THREE.DoubleSide }));
  ring.renderOrder = 20;
  pen.add(ring);
  pen.visible = false;
  helpers.add(pen);

  // Drop line from the pen to the floor, and its foot: where in depth the pen is.
  const dropGeo = new THREE.BufferGeometry();
  dropGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  const drop = new THREE.Line(dropGeo, new THREE.LineBasicMaterial({ color: 0x17140f, transparent: true, opacity: 0.35, depthWrite: false }));
  const foot = new THREE.Mesh(new THREE.RingGeometry(0.025, 0.032, 24), new THREE.MeshBasicMaterial({ color: 0x17140f, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
  foot.rotation.x = -Math.PI / 2;
  drop.visible = foot.visible = false;
  helpers.add(drop, foot);

  // The line being drawn right now.
  const live = new THREE.Mesh(new THREE.BufferGeometry(), wireMat);
  live.visible = false;
  helpers.add(live);

  /* ---------- the sheet in space ---------- */
  const viewNow = () => ({ position: camera.position.toArray(), target: controls.target.toArray() });
  const currentPlane = () => core.planeFor(params.plane, params.offset, viewNow());
  let strokePlane = null;

  function placeSheet(plane) {
    sheet.position.set(...plane.origin);
    if (params.plane === 'view' && !strokePlane) sheet.quaternion.copy(camera.quaternion);
    else sheet.lookAt(sheet.position.clone().add(new THREE.Vector3(...plane.normal)));
  }

  stage.addFrameHook(() => {
    helpers.visible = active && !hideHelpers;
    if (!helpers.visible) return;
    sheet.visible = !orbitNow() || !!strokePlane;
    placeSheet(strokePlane || currentPlane());
    fillMat.opacity = strokePlane ? 0.06 : 0.035;
    ring.quaternion.copy(camera.quaternion); // the ring faces the viewer (the pen itself never turns)
  });

  /* ---------- pointer to space ---------- */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function rayFrom(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return { o: raycaster.ray.origin.toArray(), d: raycaster.ray.direction.toArray(), x: e.clientX - r.left, y: e.clientY - r.top };
  }
  const tmp = new THREE.Vector3();
  function project(p) {
    tmp.set(p[0], p[1], p[2]).project(camera);
    const r = canvas.getBoundingClientRect();
    return [(tmp.x * 0.5 + 0.5) * r.width, (-tmp.y * 0.5 + 0.5) * r.height, tmp.z > -1 && tmp.z < 1];
  }
  const snapAt = (ray) => (params.snap && strokes.length ? core.nearestPoint(strokes, project, ray.x, ray.y) : null);

  function showPen(p, snapping) {
    pen.visible = !!p;
    drop.visible = foot.visible = !!p && p[1] > 0.02;
    if (!p) return;
    pen.position.set(...p);
    ring.visible = !!snapping;
    const a = dropGeo.attributes.position;
    a.setXYZ(0, p[0], p[1], p[2]);
    a.setXYZ(1, p[0], 0, p[2]);
    a.needsUpdate = true;
    dropGeo.computeBoundingSphere();
    foot.position.set(p[0], 0.002, p[2]);
  }

  /* ---------- drawing ---------- */
  let drawing = null; // { id, raw, s, last }
  const pointers = new Set();
  const orbitNow = () => tool === 'orbit' || tempOrbit;

  function startStroke(e) {
    const ray = rayFrom(e);
    const base = currentPlane();
    const hit = snapAt(ray);
    const plane = hit ? core.planeThrough(base, hit.point) : base;
    const first = hit ? hit.point : core.rayPlane(ray.o, ray.d, plane);
    if (!first) return;
    onBeforeDraw();
    strokePlane = plane;
    drawing = { id: e.pointerId, raw: [first], s: first, last: first, spin: controls.autoRotate };
    controls.autoRotate = false; // the sheet must not turn under the pen
    showPen(first, !!hit);
    renderLive();
  }

  function moveStroke(e) {
    const ray = rayFrom(e);
    const hit = core.rayPlane(ray.o, ray.d, strokePlane);
    if (!hit) return;
    drawing.last = hit;
    drawing.s = core.follow(drawing.s, hit, 0.45);
    if (core.dist(drawing.raw[drawing.raw.length - 1], drawing.s) > 0.003) drawing.raw.push(drawing.s);
    showPen(drawing.s, false);
    scheduleLive();
  }

  function endStroke(commit = true) {
    const d = drawing;
    drawing = null;
    strokePlane = null;
    live.visible = false;
    if (!d) return;
    controls.autoRotate = d.spin;
    if (!commit) return;
    const pts = core.finishStroke([...d.raw, d.last]);
    if (!pts) return;
    undoStack.push(strokes);
    redoStack = [];
    const g = core.nextGroup(strokes);
    const next = [...strokes, { g, pts }];
    const onAxis = pts.every((p) => Math.abs(p[0] - core.CENTER[0]) < 0.01);
    if (params.symmetry && !onAxis) next.push({ g, pts: core.mirror(pts) });
    strokes = next;
    rebuild();
  }

  let liveFrame = 0;
  function scheduleLive() { if (!liveFrame) liveFrame = requestAnimationFrame(() => { liveFrame = 0; renderLive(); }); }
  function renderLive() {
    if (!drawing) return;
    const pts = drawing.raw.length > 1 ? drawing.raw : [drawing.raw[0], drawing.s];
    const paths = [pts];
    if (params.symmetry) paths.push(core.mirror(pts));
    const t = tubeMesh(paths.map((p) => p.map((q) => [q[0], q[1], q[2], 1])), core.radiusFor(params.thickness), 8);
    live.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
    g.setIndex(new THREE.BufferAttribute(t.indices, 1));
    g.computeVertexNormals();
    live.geometry = g;
    live.visible = t.triangles > 0;
  }

  canvas.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    if (!active) return;
    // Keys belong to the stage now (Space to orbit), not to the last button pressed.
    if (document.activeElement && document.activeElement !== document.body && !typing(document.activeElement)) document.activeElement.blur();
    if (orbitNow()) return;
    if (pointers.size > 1) { endStroke(false); showPen(null); return; } // two fingers: orbit, not draw
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startStroke(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!active) return;
    if (drawing && e.pointerId === drawing.id) { moveStroke(e); return; }
    if (orbitNow() || pointers.size > 0) { showPen(null); return; }
    const ray = rayFrom(e);
    const hit = snapAt(ray);
    showPen(hit ? hit.point : core.rayPlane(ray.o, ray.d, currentPlane()), !!hit);
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (drawing && e.pointerId === drawing.id) endStroke(e.type === 'pointerup');
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => { if (!drawing) showPen(null); });

  // Space held: orbit for a moment. Ctrl+Z / Ctrl+Shift+Z: undo and redo.
  const typing = (t) => t && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|search|email|url|number)$/.test(t.type)));
  addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.code === 'Space' && !typing(e.target)) { e.preventDefault(); if (!tempOrbit) { tempOrbit = true; applyControls(); showPen(null); } return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !typing(e.target)) {
      e.preventDefault();
      if (e.shiftKey) api.redo(); else api.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); api.redo(); }
  });
  addEventListener('keyup', (e) => { if (e.code === 'Space' && tempOrbit) { e.preventDefault(); tempOrbit = false; applyControls(); } });
  addEventListener('blur', () => { if (tempOrbit) { tempOrbit = false; applyControls(); } });

  function applyControls() {
    const orbit = !active || orbitNow();
    if (orbit) {
      controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      // The left button and one finger belong to the pen; the right button and two fingers orbit.
      controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      controls.touches = { ONE: -1, TWO: THREE.TOUCH.DOLLY_ROTATE };
    }
    canvas.style.cursor = active ? (orbit ? 'grab' : 'crosshair') : '';
  }

  /* ---------- the work ---------- */
  function rebuild() {
    for (const o of [...group.children]) {
      group.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.isSprite) { o.material.map?.dispose(); o.material.dispose(); }
    }
    anim = null;
    closed = null;
    const paths = core.tubePaths(strokes);
    if (paths.length) {
      const radius = core.radiusFor(params.thickness);
      const t = tubeMesh(paths, radius, 8);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
      g.setIndex(new THREE.BufferAttribute(t.indices, 1));
      g.computeVertexNormals();
      const wire = new THREE.Mesh(g, wireMat);
      wire.name = 'line';
      group.add(wire);
      closed = isClosed(t.indices);
      anim = drawingAnimation(group, g, t.timeline, null, radius);
    }
    if (active) stage.refresh({ closed, lines: strokes.length });
    onChange(api.state);
  }

  const api = {
    enter({ strokes: s = [], params: p = {} } = {}) {
      active = true;
      strokes = s;
      undoStack = [];
      redoStack = [];
      params = core.normalizeParams({ ...params, ...p });
      stage.setBackdrop('paper');
      stage.setRaw(group, { source: 'ציור במרחב', closed: null, lines: 0, sketch: true }, { view: START_VIEW });
      controls.autoRotate = false;
      applyControls();
      rebuild();
    },
    leave() {
      if (drawing) endStroke(false);
      active = false;
      tempOrbit = false;
      showPen(null);
      applyControls();
    },
    load(s, p) {
      strokes = s;
      undoStack = [];
      redoStack = [];
      if (p) params = core.normalizeParams({ ...params, ...p });
      rebuild();
    },
    undo() { if (!undoStack.length) return; redoStack.push(strokes); strokes = undoStack.pop(); rebuild(); },
    redo() { if (!redoStack.length) return; undoStack.push(strokes); strokes = redoStack.pop(); rebuild(); },
    clear() { if (!strokes.length) return; undoStack.push(strokes); redoStack = []; strokes = []; rebuild(); },
    setTool(next) { tool = next === 'orbit' ? 'orbit' : 'pen'; if (drawing) endStroke(false); showPen(null); applyControls(); },
    setParams(p) {
      const before = params.thickness;
      params = core.normalizeParams({ ...params, ...p });
      if (params.thickness !== before) rebuild();
    },
    /** Hide the sheet and the pen (while the drawing replays, and for the archive picture). */
    setHelpersHidden(on) { hideHelpers = !!on; },
    withoutHelpers(fn) {
      const was = helpers.visible;
      helpers.visible = false;
      try { return fn(); } finally { helpers.visible = was; }
    },
    get state() {
      return { count: strokes.length, groups: new Set(strokes.map((s) => s.g)).size, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, closed };
    },
    get params() { return { ...params }; },
    get data() { return core.serialize(strokes); },
    get animation() { return anim; },
    get active() { return active; },
    get tool() { return tool; },
  };
  return api;
}
