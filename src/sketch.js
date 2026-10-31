// Drawing in 3D, browser side: the pen, the transparent sheet, and the wire.
// Two results from the same strokes:
//   sculpt (default): the drawing is read like a drawing on paper and wound into space by the
//     line sculpture engine: the outline sits on the rim, inner lines on the surface, and the
//     thread wraps the volume, front, rim and back. Anat, 31.10.2026: "the line is not flat,
//     it wraps space". What was drawn stays on the sheet as a faint pencil line.
//   line: each line stays where the pen put it.
// The pure geometry lives in sketch-core.js.
import * as THREE from 'three';
import { tubeMesh } from './line-core.js';
import { isClosed } from './sculpt-core.js';
import { drawingAnimation, prepareSculpt, lineSculpture } from './sculpt.js';
import * as core from './sketch-core.js';

const INK = 0x1a1611;   // one line, one colour (the same as the line sculpture)
const SHEET = 2.6;      // size of the drawing sheet, world units
const FRONT_VIEW = { target: [0, 1, 0], position: [0, 1.15, 4.4] };    // like a sheet of paper on the desk
const ANGLE_VIEW = { target: [0, 1, 0], position: [-1.25, 1.6, 4.05] }; // three quarters: the sheet reads as a plane in space
const PENCIL = 0x6b6457;

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
  // Reading a drawing needs a page: in sculpt mode the pen always draws on the front sheet.
  const planeKind = () => (params.result === 'sculpt' ? 'wall' : params.plane);
  const currentPlane = () => (params.result === 'sculpt' ? core.planeFor('wall', 0) : core.planeFor(params.plane, params.offset, viewNow()));
  let strokePlane = null;

  function placeSheet(plane) {
    sheet.position.set(...plane.origin);
    if (planeKind() === 'view' && !strokePlane) sheet.quaternion.copy(camera.quaternion);
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
  // The drawing as pencil on the sheet: what the engine reads (never exported).
  const pencil = new THREE.Group();
  helpers.add(pencil);
  const pencilMat = new THREE.LineBasicMaterial({ color: PENCIL, transparent: true, opacity: 0.55, depthWrite: false });
  function drawPencil() {
    for (const o of [...pencil.children]) { pencil.remove(o); o.geometry.dispose(); }
    if (params.result !== 'sculpt') return;
    for (const s of strokes) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(s.pts.flat(), 3));
      pencil.add(new THREE.Line(g, pencilMat));
    }
  }

  function emptyGroup() {
    for (const o of [...group.children]) {
      group.remove(o);
      o.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.isSprite) { c.material.map?.dispose(); c.material.dispose(); }
      });
    }
    anim = null;
    closed = null;
    reading = null;
  }

  // Reading: strokes to a page, the page through the line engine, the result back onto the strokes.
  let version = 0;        // bumps when the strokes change
  let page = null;        // { version, prepared, layout }
  let readToken = 0;
  let reading = null;     // { lines, loops, error }
  let busy = false;
  let sliderFrame = 0;    // slider moves are read once per frame
  async function readDrawing() {
    const token = ++readToken;
    if (!strokes.length) { emptyGroup(); busy = false; finish(); return; }
    busy = true;
    onChange(api.state);
    try {
      if (!page || page.version !== version) {
        const layout = core.paperLayout(strokes, 560);
        const c = document.createElement('canvas');
        c.width = layout.width;
        c.height = layout.height;
        const g = c.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, c.width, c.height);
        g.strokeStyle = '#141210';
        g.lineWidth = layout.line;
        g.lineCap = g.lineJoin = 'round';
        for (const s of strokes) {
          g.beginPath();
          s.pts.forEach((p, i) => { const [x, y] = layout.toPage(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
          g.stroke();
        }
        const prepared = await prepareSculpt(c.toDataURL('image/png'));
        if (token !== readToken) return;
        page = { version, prepared, layout };
      }
      // The engine works in page units: the wire radius is given so it lands on the slider's weight.
      const r = lineSculpture(page.prepared, {
        depth: params.depth, wrap: params.wrap, radius: core.radiusFor(params.thickness) / page.layout.scale,
        sensitivity: 0.75, cloud: 0, continuous: true,
      });
      if (token !== readToken) return;
      emptyGroup();
      // Back onto the strokes: the engine's page is 2 units on its long side, centred.
      const { scale, center } = page.layout;
      r.object.scale.setScalar(scale);
      r.object.position.set(center[0], center[1], 0);
      r.object.traverse((o) => { if (o.isMesh) o.material = wireMat; }); // one ink for every result
      group.add(r.object);
      anim = r.animation;
      closed = r.closed;
      reading = { lines: r.lines, loops: r.loops, error: null };
    } catch (err) {
      if (token !== readToken) return;
      // No enclosed shape to wind around (an open scribble): keep the lines where they are,
      // and say what would give them a volume.
      buildLines();
      reading = { lines: strokes.length, loops: 0, error: err.code || 'failed' };
    }
    busy = false;
    finish();
  }

  function finish() {
    if (active) stage.refresh({ closed, lines: strokes.length });
    onChange(api.state);
  }

  function rebuild() {
    version++;
    drawPencil();
    if (params.result === 'sculpt') { readDrawing(); return; }
    readToken++;
    busy = false;
    buildLines();
    finish();
  }

  function buildLines() {
    emptyGroup();
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
  }

  const api = {
    enter({ strokes: s = [], params: p = {} } = {}) {
      active = true;
      strokes = s;
      undoStack = [];
      redoStack = [];
      params = core.normalizeParams({ ...params, ...p });
      stage.setBackdrop('paper');
      stage.setRaw(group, { source: 'ציור במרחב', closed: null, lines: 0, sketch: true }, { view: params.result === 'sculpt' ? FRONT_VIEW : ANGLE_VIEW });
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
      const before = params;
      params = core.normalizeParams({ ...params, ...p });
      const shape = ['thickness', 'result', 'depth', 'wrap'].some((k) => params[k] !== before[k]);
      if (!shape) return;
      if (params.result !== before.result) { drawPencil(); rebuild(); return; }
      // Same strokes, new settings: the page is kept, only the wire is rebuilt.
      if (params.result === 'sculpt') { cancelAnimationFrame(sliderFrame); sliderFrame = requestAnimationFrame(readDrawing); } else { buildLines(); finish(); }
    },
    /** Back to the front, where the drawing reads like paper. */
    front() {
      controls.target.set(...FRONT_VIEW.target);
      camera.position.set(...FRONT_VIEW.position);
      controls.update();
    },
    /** Hide the sheet and the pen (while the drawing replays, and for the archive picture). */
    setHelpersHidden(on) { hideHelpers = !!on; },
    withoutHelpers(fn) {
      const was = helpers.visible;
      helpers.visible = false;
      try { return fn(); } finally { helpers.visible = was; }
    },
    get state() {
      return {
        count: strokes.length, groups: new Set(strokes.map((s) => s.g)).size, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, closed,
        result: params.result, busy, loops: reading ? reading.loops : 0, error: reading ? reading.error : null,
      };
    },
    get params() { return { ...params }; },
    get data() { return core.serialize(strokes); },
    get animation() { return anim; },
    get active() { return active; },
    get tool() { return tool; },
  };
  return api;
}
