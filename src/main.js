import './styles/tokens.css';
import './styles/app.css';
import { createStage, sampleObject } from './viewer.js';
import { prepareDrawing, checkFile } from './image.js';
import { startConversion, getStatus, ApiError, ERRORS } from './api.js';
import * as archive from './history.js';
import { prepareSculpt, sculptMesh, lineSculpture } from './sculpt.js';
import * as works from './store.js';
import { createSketch } from './sketch.js';
import { deserialize as readStrokes } from './sketch-core.js';

const POLL_MS = 3000;
const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'), note: $('stageNote'), caption: $('stageCaption'), annotation: $('annotation'), thirds: $('thirds'),
  thirdsBtn: $('thirdsBtn'), spinBtn: $('spinBtn'), lightAngle: $('lightAngle'),
  drop: $('drop'), dropEmpty: $('dropEmpty'), file: $('file'), preview: $('preview'),
  convert: $('convertBtn'), sample: $('sampleBtn'), reset: $('resetBtn'),
  progress: $('progress'), progressBar: $('progressBar'), progressPct: $('progressPct'), progressEta: $('progressEta'),
  status: $('status'), factSize: $('factSize'), factTris: $('factTris'), factSource: $('factSource'),
  downloads: $('downloads'), downloadsEmpty: $('downloadsEmpty'), openLocal: $('openLocalBtn'), localFile: $('localFile'),
  factClosed: $('factClosed'), volume: $('volume'), volumeVal: $('volumeVal'), lineRelief: $('lineRelief'), lineVal: $('lineVal'),
  depth: $('depth'), depthVal: $('depthVal'), thickness: $('thickness'), thicknessVal: $('thicknessVal'), continuous: $('continuous'), wrap: $('wrap'), wrapVal: $('wrapVal'), sensitivity: $('sensitivity'), sensitivityVal: $('sensitivityVal'), cloud: $('cloud'), cloudVal: $('cloudVal'),
  anim: $('anim'), playBtn: $('playBtn'), scrub: $('scrub'), animTime: $('animTime'), recordBtn: $('recordBtn'),
  saveBox: $('saveBox'), workName: $('workName'), saveBtn: $('saveBtn'),
  service: $('service'), serviceText: $('serviceText'), serviceHint: $('serviceHint'),
  archiveList: $('archiveList'), archiveEmpty: $('archiveEmpty'),
  skOffset: $('skOffset'), skOffsetVal: $('skOffsetVal'), skThickness: $('skThickness'), skThicknessVal: $('skThicknessVal'),
  skDepth: $('skDepth'), skDepthVal: $('skDepthVal'), skWrap: $('skWrap'), skWrapVal: $('skWrapVal'), skFront: $('skFront'), sketchPanel: document.querySelector('.sketch-panel'),
  skSnap: $('skSnap'), skMirror: $('skMirror'), skUndo: $('skUndo'), skRedo: $('skRedo'), skNew: $('skNew'), skStatus: $('skStatus'),
};

/* ---------------- State ---------------- */
const ENGINES = ['line', 'local', 'ai'];
const ENGINE_LABEL = { line: 'קו במרחב', local: 'גוף מנופח', ai: 'בינה מלאכותית', sketch: 'ציור במרחב' };
const state = {
  drawing: null,   // { dataUrl, thumb, name }
  phase: 'idle',   // idle | ready | uploading | processing | done | failed
  jobId: null,
  pollToken: 0,
  editing: false,
  service: 'checking', // checking | ready | off | unknown
  engine: readEngine(), // line | local | ai
  sculpt: null,         // drawing analysed once for the local engines
  workId: null,         // saved work currently open
  anim: null,           // drawing animation of the current line sculpture
  mode: 'image',        // image (a drawing becomes a body) | sketch (drawing in 3D)
  sketchId: null,       // saved 3D drawing currently open
};
function readEngine() { try { const v = localStorage.getItem('drawing3d.engine.v2'); return ENGINES.includes(v) ? v : 'line'; } catch { return 'line'; } }

/* ---------------- Stage ---------------- */
let stage = null;
try {
  stage = createStage(el.stage, { onFrame: drawAnnotation });
} catch (err) {
  console.error(err);
  el.note.textContent = 'הדפדפן לא תומך בתצוגה תלת-ממדית (WebGL). עדיין אפשר להמיר ולהוריד קבצים.';
}
const sketch = stage ? createSketch(stage, { onChange: onSketchChange, onBeforeDraw: () => stopDrawing(true) }) : null;

function showSample() {
  if (!stage) return;
  stage.setBackdrop('dark');
  const info = stage.setObject(sampleObject(), { source: 'מודל לדוגמה' });
  setFacts(info);
  setDownloads({ local: true });
  el.caption.innerHTML = '<span>SAMPLE / מודל לדוגמה</span><span>גוררים לסיבוב, גלגלת לזום</span>';
  resetAnnotation();
}

/* Annotation: circle around the subject, a leading line, and a label of real facts.
   Grammar taken from the inspiration image: "Bold: light". */
let ann = null;
function annText(info) {
  const [x, y, z] = info.proportion;
  if (info.reading === 'scene') return `<b>נוף:</b> אופק ב-<span dir="ltr">${Math.round(info.horizon * 100)}%</span> מהגובה · <b>עומדים:</b> <span dir="ltr">${info.standing}</span><br><b>קווים:</b> <span dir="ltr">${info.lines}</span>${info.continuous ? ' · חוט אחד' : ''}`;
  if (info.lines) return `<b>קווים:</b> <span dir="ltr">${info.lines}</span> · <b>ליפופים:</b> <span dir="ltr">${info.loops || 0}</span>${info.continuous ? ' · חוט אחד' : ''}<br><b>פרופורציה:</b> <span dir="ltr">${x} × ${y} × ${z}</span>`;
  return `<b>פרופורציה:</b> <span dir="ltr">${x} × ${y} × ${z}</span><br><b>משולשים:</b> <span dir="ltr">${info.tris.toLocaleString('he-IL')}</span>`;
}
function updateAnnotation(info) { if (ann) { ann.box.innerHTML = annText(info); ann.last = ''; } }
function resetAnnotation() { ann = null; el.annotation.innerHTML = ''; }
function drawAnnotation(p) {
  if (!p || !stage || !stage.info || state.mode === 'sketch' || !stage.info.proportion) return;
  const info = stage.info;
  if (!ann) {
    const ns = 'http://www.w3.org/2000/svg';
    const circle = document.createElementNS(ns, 'circle');
    const line = document.createElementNS(ns, 'line');
    circle.classList.add('draw');
    line.classList.add('draw');
    const fo = document.createElementNS(ns, 'foreignObject');
    fo.setAttribute('width', '240');
    fo.setAttribute('height', '60');
    const box = document.createElement('div');
    box.className = 'ann-label';
    box.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    box.innerHTML = annText(info);
    fo.appendChild(box);
    el.annotation.append(circle, line, fo);
    ann = { circle, line, fo, box, last: '' };
  }
  // Label sits up and to the left of the subject, like the callouts in the image.
  const r = Math.max(24, Math.min(p.r, Math.min(p.w, p.h) * 0.42));
  const a = (-135 * Math.PI) / 180;
  const sx = p.cx + Math.cos(a) * r, sy = p.cy + Math.sin(a) * r;
  const len = Math.min(70, p.w * 0.08);
  let ex = sx - len, ey = sy - len;
  ex = Math.max(10, ex); ey = Math.max(70, ey);
  const key = [p.cx, p.cy, r, ex, ey].map((v) => Math.round(v)).join(',');
  if (key === ann.last) return;
  ann.last = key;
  ann.circle.setAttribute('cx', p.cx); ann.circle.setAttribute('cy', p.cy); ann.circle.setAttribute('r', r);
  ann.circle.style.setProperty('--len', Math.ceil(2 * Math.PI * r));
  ann.line.setAttribute('x1', sx); ann.line.setAttribute('y1', sy); ann.line.setAttribute('x2', ex); ann.line.setAttribute('y2', ey);
  ann.line.style.setProperty('--len', Math.ceil(Math.hypot(sx - ex, sy - ey)));
  ann.fo.setAttribute('x', Math.max(4, ex - 240));
  ann.fo.setAttribute('y', Math.max(4, ey - 58));
}

function setFacts(info) {
  if (!info) {
    el.factSize.textContent = el.factTris.textContent = el.factSource.textContent = el.factClosed.textContent = '-';
    return;
  }
  el.factClosed.textContent = info.closed === true ? 'כן' : info.closed === false ? 'לא' : '-';
  el.factSize.textContent = info.proportion ? info.proportion.join(' × ') : '-';
  el.factTris.textContent = info.tris.toLocaleString('he-IL');
  el.factSource.textContent = info.source || '-';
}

const FORMAT_LABEL = { glb: 'GLB', stl: 'STL', '3mf': '3MF', obj: 'OBJ', fbx: 'FBX', usdz: 'USDZ' };
const FORMAT_HINT = { glb: 'צפייה', stl: 'הדפסה', '3mf': 'הדפסה', obj: 'עריכה', fbx: 'אנימציה', usdz: 'אייפון' };

function setDownloads({ urls, local } = {}) {
  el.downloads.querySelectorAll('.btn').forEach((b) => b.remove());
  const keys = urls ? ['glb', 'stl', '3mf', 'obj'].filter((k) => urls[k]) : [];
  for (const k of keys) {
    const a = document.createElement('a');
    a.className = 'btn';
    a.href = urls[k];
    a.target = '_blank';
    a.rel = 'noopener';
    a.download = `drawing-model.${k}`;
    a.dataset.format = k;
    a.innerHTML = `${FORMAT_LABEL[k]} <small>${FORMAT_HINT[k]}</small>`;
    el.downloads.appendChild(a);
  }
  if (local && stage && stage.hasSubject && (state.mode !== 'sketch' || (sketch && sketch.state.count))) {
    for (const k of ['glb', 'stl']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.dataset.export = k;
      b.innerHTML = `ייצוא ${FORMAT_LABEL[k]} <small>${FORMAT_HINT[k]}</small>`;
      b.addEventListener('click', () => exportLocal(k));
      el.downloads.appendChild(b);
    }
  }
  el.downloadsEmpty.textContent = state.mode === 'sketch' ? 'הקבצים יופיעו כאן אחרי הקו הראשון.' : 'הקבצים יופיעו כאן אחרי ההמרה.';
  el.downloadsEmpty.hidden = el.downloads.querySelectorAll('.btn').length > 0;
}

async function exportLocal(fmt) {
  const blob = await stage.exportFile(fmt);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.mode === 'sketch' ? 'sketch' : 'model'}.${fmt}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------------- Stage tools ---------------- */
document.querySelectorAll('[data-mode]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    stage && stage.setMode(b.dataset.mode);
  });
});
el.thirdsBtn.addEventListener('click', () => {
  const on = el.thirdsBtn.getAttribute('aria-pressed') !== 'true';
  el.thirdsBtn.setAttribute('aria-pressed', String(on));
  el.thirds.hidden = !on;
});
el.spinBtn.addEventListener('click', () => {
  const on = el.spinBtn.getAttribute('aria-pressed') !== 'true';
  el.spinBtn.setAttribute('aria-pressed', String(on));
  stage && stage.setSpin(on);
});
if (matchMedia('(prefers-reduced-motion: reduce)').matches) el.spinBtn.setAttribute('aria-pressed', 'false');
// Front: the view the drawing was made from, to compare with it.
document.getElementById('frontBtn').addEventListener('click', () => {
  if (!stage) return;
  stage.viewFront();
  el.spinBtn.setAttribute('aria-pressed', 'false');
});
el.lightAngle.addEventListener('input', () => stage && stage.setLight(Number(el.lightAngle.value)));

/* ---------------- Drawing input ---------------- */
function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

function setPhase(phase) {
  state.phase = phase;
  const busy = phase === 'uploading' || phase === 'processing' || phase === 'sculpting';
  const needsService = state.engine === 'ai' && state.service === 'off';
  el.convert.disabled = !state.drawing || busy || needsService;
  el.convert.textContent = phase === 'failed' ? 'ניסיון נוסף' : state.engine === 'ai' ? 'המרה למודל' : 'פיסול מהציור';
  el.saveBox.hidden = phase !== 'sculpted';
  el.anim.hidden = !(phase === 'sculpted' && state.engine === 'line' && state.anim);
  document.querySelectorAll('input[name="engine"]').forEach((r) => { r.disabled = busy; });
  el.sample.hidden = !!state.drawing;
  el.reset.hidden = !state.drawing || busy;
  el.drop.disabled = busy;
  el.progress.hidden = !(phase === 'uploading' || phase === 'processing' || phase === 'done');
  document.querySelectorAll('input[name="texture"]').forEach((r) => { r.disabled = busy; });
  if (state.mode === 'sketch' && sketch) {
    const n = sketch.state.count;
    el.saveBox.hidden = !n;
    el.anim.hidden = !(n && state.anim);
  }
}

function setProgress(pct, eta) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  el.progressBar.style.width = v + '%';
  el.progressPct.textContent = v + '%';
  el.progressEta.textContent = eta || '';
}

async function useDrawing(src, name) {
  try {
    const { dataUrl, thumb } = await prepareDrawing(src);
    state.drawing = { dataUrl, thumb, name };
    state.sculpt = null;
    state.workId = null;
    el.workName.value = name.replace(/\.[a-z0-9]+$/i, '');
    el.saveBtn.textContent = 'שמירה לארכיון';
    el.preview.src = dataUrl;
    el.preview.hidden = false;
    el.dropEmpty.hidden = true;
    setPhase('ready');
    setStatus(readyText());
  } catch {
    setStatus('לא ניתן לקרוא את הקובץ. בוחרים תמונה אחרת.', 'error');
  }
}

function readyText() {
  if (state.engine !== 'ai') return 'הציור מוכן. הפיסול לוקח שנייה או שתיים.';
  return state.service === 'off'
    ? 'הציור מוכן. ההמרה תיפתח כששירות ההמרה יחובר. אפשר לעבור לפיסול מקומי.'
    : 'הציור מוכן. ההמרה לוקחת בדרך כלל שתיים עד חמש דקות.';
}

async function pickFile(file) {
  const problem = checkFile(file);
  if (problem) { setStatus(ERRORS[problem], 'error'); return; }
  const url = URL.createObjectURL(file);
  await useDrawing(url, file.name);
  URL.revokeObjectURL(url);
}

el.drop.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', (e) => { pickFile(e.target.files[0]); e.target.value = ''; });
['dragenter', 'dragover'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
el.drop.addEventListener('drop', (e) => pickFile(e.dataTransfer.files[0]));
el.sample.addEventListener('click', () => useDrawing('/sample-drawing.svg', 'בית, רישום לדוגמה'));
el.reset.addEventListener('click', () => {
  stopDrawing(true);
  state.drawing = null;
  state.sculpt = null;
  state.workId = null;
  if (location.hash.startsWith('#/work/')) history.replaceState(null, '', '#/');
  el.preview.hidden = true;
  el.preview.removeAttribute('src');
  el.dropEmpty.hidden = false;
  setPhase('idle');
  setProgress(0);
  setStatus('');
});

/* ---------------- Conversion ---------------- */
/* ---------------- Local sculpting engine ---------------- */
async function sculptNow() {
  if (!stage) { setStatus('הדפדפן לא תומך בתצוגה תלת-ממדית (WebGL).', 'error'); return; }
  ++state.pollToken;
  state.jobId = null;
  if (location.hash.startsWith('#/model/')) history.replaceState(null, '', state.workId ? '#/work/' + state.workId : '#/');
  setPhase('sculpting');
  setStatus('מפסלים...');
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); // let the status paint
  try {
    if (!state.sculpt) state.sculpt = await prepareSculpt(state.drawing.dataUrl);
    renderSculpt(false);
    setPhase('sculpted');
    setStatus(state.engine === 'line'
      ? 'הפסל הקווי מוכן. מסובבים כדי לראות את החוט מתלפף מאחור, מכווננים "עומק" ו"עובי", ושומרים לארכיון.'
      : 'הפסל מוכן. מכווננים "נפח" ו"קו", בוחנים במצב "חימר", ושומרים לארכיון.', 'ok');
  } catch (err) {
    console.warn('sculpt failed', err);
    setPhase('failed');
    setStatus(ERRORS[err.code] || 'הפיסול נכשל. נסו ציור עם קו מתאר ברור.', 'error');
  }
}

function params() {
  return state.engine === 'line'
    ? { reading: state.reading, colour: document.getElementById('colourThread').checked, depth: el.depth.value / 100, thickness: el.thickness.value / 100, wrap: el.wrap.value / 100, sensitivity: el.sensitivity.value / 100, cloud: el.cloud.value / 100, continuous: el.continuous.checked }
    : { volume: el.volume.value / 100, line: el.lineRelief.value / 100 };
}

function setParams(p = {}) {
  const set = (input, out, v) => { if (typeof v === 'number') { input.value = Math.round(v * 100); out.textContent = input.value; } };
  set(el.depth, el.depthVal, p.depth);
  set(el.thickness, el.thicknessVal, p.thickness);
  set(el.volume, el.volumeVal, p.volume);
  set(el.lineRelief, el.lineVal, p.line);
  if (typeof p.continuous === 'boolean') el.continuous.checked = p.continuous;
  document.getElementById('colourThread').checked = p.colour !== false;
  setReading(['auto', 'object', 'scene'].includes(p.reading) ? p.reading : 'auto');
  set(el.wrap, el.wrapVal, p.wrap);
  set(el.sensitivity, el.sensitivityVal, p.sensitivity);
  set(el.cloud, el.cloudVal, typeof p.smoke === 'boolean' ? (p.smoke ? 0.6 : 0) : p.cloud); // works saved before the cloud slider
}

function renderSculpt(keepView) {
  let info;
  stage.setBackdrop(state.engine === 'line' ? 'paper' : 'dark');
  if (state.engine === 'line') {
    const r = lineSculpture(state.sculpt, params());
    stopDrawing(true);
    state.anim = r.animation;
    play.p = 1;
    showProgress();
    info = stage.setObject(r.object, { source: r.reading === 'scene' ? 'פיסול קווי, נוף' : 'פיסול קווי', closed: r.closed, lines: r.lines, loops: r.loops, continuous: r.continuous, reading: r.reading, horizon: r.horizon, standing: r.standing, viewpoint: r.viewpoint }, { keepView });
    showReading(r);
  } else {
    stopDrawing(true);
    state.anim = null;
    const { object, closed } = sculptMesh(state.sculpt, params());
    info = stage.setObject(object, { source: 'פיסול מקומי', closed }, { keepView });
  }
  if (keepView) updateAnnotation(info); else resetAnnotation();
  setFacts(info);
  if (!keepView) setDownloads({ local: true });
  el.caption.innerHTML = `<span>SCULPT / ${escapeHtml(state.drawing.name)}</span><span>${ENGINE_LABEL[state.engine]}</span>`;
}

let sliderFrame = 0;
function liveUpdate() {
  if (state.phase !== 'sculpted' || !state.sculpt) return;
  cancelAnimationFrame(sliderFrame);
  sliderFrame = requestAnimationFrame(() => renderSculpt(true));
}
for (const [input, out] of [[el.volume, el.volumeVal], [el.lineRelief, el.lineVal], [el.depth, el.depthVal], [el.thickness, el.thicknessVal], [el.wrap, el.wrapVal], [el.sensitivity, el.sensitivityVal], [el.cloud, el.cloudVal]]) {
  input.addEventListener('input', () => { out.textContent = input.value; liveUpdate(); });
}
el.continuous.addEventListener('change', liveUpdate);
document.getElementById('colourThread').addEventListener('change', liveUpdate);

/* ---------------- Reading: an object, or a landscape laid out in depth ---------------- */
state.reading = 'auto';
function setReading(next) {
  state.reading = next;
  document.querySelectorAll('[data-reading]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.reading === next)));
}
document.querySelectorAll('[data-reading]').forEach((b) => b.addEventListener('click', () => {
  setReading(b.dataset.reading);
  if (state.phase === 'sculpted' && state.sculpt && state.engine === 'line') renderSculpt(false);
}));
function showReading(r) {
  const note = document.getElementById('readingNote');
  const auto = state.reading === 'auto';
  note.textContent = r.reading === 'scene'
    ? `${auto ? 'זוהה נוף' : 'נקרא כנוף'}: קו אופק ב-${Math.round(r.horizon * 100)}% מהגובה. הקרקע נפרשת לעומק, השמיים עומדים מאחור, ו${r.standing ? 'הדבר העומד' : 'כל מה שבתמונה'} ${r.standing ? 'עומד במקום שבו הוא נוגע בקרקע' : 'שוכב על הקרקע'}. "חזית" מחזירה למבט של הציור.`
    : `${auto ? 'זוהה דבר' : 'נקרא כדבר'}: הגוף מנופח אל המתבונן, והחוט עוטף את המתאר.`;
}

/* ---------------- Drawing the work from the first line (animation) ---------------- */
const play = { on: false, p: 1, last: 0, frame: 0, recorder: null };
const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
function showProgress() {
  el.scrub.value = Math.round(play.p * 1000);
  const d = state.anim ? state.anim.duration : 0;
  el.animTime.textContent = `${fmt(play.p * d)} / ${fmt(d)}`;
  el.annotation.classList.toggle('hidden-while-drawing', play.p < 1);
  if (sketch) sketch.setHelpersHidden(state.mode === 'sketch' && play.p < 1); // the sheet steps aside while the drawing replays
  el.playBtn.textContent = play.on ? 'השהיה' : play.p > 0 && play.p < 1 ? 'המשך' : 'ציור מההתחלה';
}
function tick(now) {
  if (!play.on || !state.anim) return;
  const dt = Math.min(0.1, (now - play.last) / 1000);
  play.last = now;
  play.p = Math.min(1, play.p + dt / state.anim.duration);
  state.anim.set(play.p);
  showProgress();
  if (play.p >= 1) { play.on = false; showProgress(); finishRecording(); return; }
  play.frame = requestAnimationFrame(tick);
}
function startDrawing(fromStart) {
  if (!state.anim) return;
  if (fromStart || play.p >= 1) play.p = 0;
  play.on = true;
  play.last = performance.now();
  state.anim.set(play.p);
  showProgress();
  cancelAnimationFrame(play.frame);
  play.frame = requestAnimationFrame(tick);
}
function stopDrawing(reset) {
  play.on = false;
  cancelAnimationFrame(play.frame);
  if (reset) {
    if (play.recorder) { play.recorder.cancelled = true; try { play.recorder.stop(); } catch { /* ignore */ } }
    play.p = 1;
    if (state.anim) state.anim.set(1);
  }
  showProgress();
}
el.playBtn.addEventListener('click', () => (play.on ? stopDrawing(false) : startDrawing(false)));
el.scrub.addEventListener('input', () => {
  if (!state.anim) return;
  play.on = false;
  cancelAnimationFrame(play.frame);
  play.p = el.scrub.value / 1000;
  state.anim.set(play.p);
  showProgress();
});

// Video: the stage canvas is recorded while the drawing plays from the first line to the last.
function pickVideoType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) if (MediaRecorder.isTypeSupported(t)) return t;
  return null;
}
function recordDrawing() {
  const type = pickVideoType();
  if (!type || !stage || !stage.canvas.captureStream || !state.anim) {
    setStatus('הדפדפן הזה לא תומך בהקלטת וידאו. ב-Chrome זה עובד.', 'error');
    return;
  }
  const chunks = [];
  const rec = new MediaRecorder(stage.canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 6_000_000 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    el.recordBtn.disabled = false;
    el.recordBtn.textContent = 'שמירת וידאו';
    const cancelled = rec.cancelled;
    play.recorder = null;
    if (cancelled || !chunks.length) return;
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // ASCII file name: Chrome drops non-Latin names on late downloads (seen in testing).
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    a.download = `drawing-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus('הווידאו נשמר בהורדות.', 'ok');
  };
  play.recorder = rec;
  el.recordBtn.disabled = true;
  el.recordBtn.textContent = 'מקליטים...';
  setStatus('מקליטים את הציור מההתחלה. הווידאו יורד בסוף.');
  rec.start(250);
  startDrawing(true);
}
function finishRecording() {
  const rec = play.recorder;
  if (rec && rec.state === 'recording') setTimeout(() => rec.state === 'recording' && rec.stop(), 900); // hold the last frame
}
el.recordBtn.addEventListener('click', () => { if (!play.recorder) recordDrawing(); });

/* ---------------- Saving to the archive ---------------- */
async function saveWork() {
  if (state.phase !== 'sculpted' || !state.drawing) return;
  const id = state.workId || works.newId();
  const existing = state.workId ? await works.getWork(id).catch(() => null) : null;
  const work = {
    id,
    name: el.workName.value.trim() || state.drawing.name,
    engine: state.engine,
    params: params(),
    drawing: state.drawing.dataUrl,
    drawingThumb: state.drawing.thumb,
    thumb: stage.snapshot(),
    created: existing ? existing.created : new Date().toISOString(),
    date: new Date().toISOString(),
  };
  try {
    await works.saveWork(work);
  } catch (err) {
    console.warn('save failed', err);
    setStatus('השמירה נכשלה. ייתכן שהדפדפן חוסם אחסון (חלון פרטי) או שהאחסון מלא.', 'error');
    return;
  }
  state.workId = id;
  state.drawing.name = work.name;
  el.saveBtn.textContent = 'עדכון בארכיון';
  history.replaceState(null, '', '#/work/' + id);
  setStatus(existing ? 'העבודה עודכנה בארכיון.' : 'העבודה נשמרה בארכיון.', 'ok');
  const menu = document.querySelector('ai-menu');
  if (menu) menu.status = 'נשמר';
}
el.saveBtn.addEventListener('click', () => (state.mode === 'sketch' ? saveSketch() : saveWork()));

async function openWork(id) {
  let work;
  try { work = await works.getWork(id); } catch { work = null; }
  if (!work) { setStatus('העבודה לא נמצאה בארכיון של הדפדפן הזה.', 'error'); return; }
  if (work.engine === 'sketch') { location.replace('#/draw/' + encodeURIComponent(work.id)); return; }
  state.drawing = { dataUrl: work.drawing, thumb: work.drawingThumb, name: work.name };
  state.sculpt = null;
  state.workId = work.id;
  el.preview.src = work.drawing;
  el.preview.hidden = false;
  el.dropEmpty.hidden = true;
  el.workName.value = work.name;
  el.saveBtn.textContent = 'עדכון בארכיון';
  setEngine(work.engine === 'local' ? 'local' : 'line');
  setParams(work.params);
  await sculptNow();
}

function setEngine(next) {
  state.engine = next;
  try { localStorage.setItem('drawing3d.engine.v2', next); } catch { /* ignore */ }
  document.querySelectorAll('input[name="engine"]').forEach((r) => { r.checked = r.value === next; });
  document.querySelectorAll('[data-engine-panel]').forEach((p) => { p.hidden = p.dataset.enginePanel !== next; });
  setPhase(state.phase);
  if (state.phase === 'ready') setStatus(readyText());
  // Switching between the two local engines re-sculpts the same drawing at once.
  if (state.phase === 'sculpted' && state.sculpt && next !== 'ai') { renderSculpt(false); }
}
document.querySelectorAll('input[name="engine"]').forEach((r) => r.addEventListener('change', () => setEngine(r.value)));

async function convert() {
  if (!state.drawing || state.phase === 'uploading' || state.phase === 'processing' || state.phase === 'sculpting') return;
  if (state.engine !== 'ai') return sculptNow();
  const texture = document.querySelector('input[name="texture"]:checked').value === '1';
  setPhase('uploading');
  setProgress(2, '');
  setStatus('שולחים את הציור...');
  try {
    const { id } = await startConversion(state.drawing.dataUrl, texture);
    archive.upsert({ id, name: state.drawing.name, date: new Date().toISOString(), thumb: state.drawing.thumb, texture, status: 'PENDING' });
    archive.setActive(id);
    renderArchive();
    history.replaceState(null, '', '#/model/' + id);
    await follow(id);
  } catch (err) {
    fail(err);
  }
}
el.convert.addEventListener('click', convert);

function fail(err) {
  if (err instanceof ApiError && err.code === 'server_not_configured') setService('off');
  setPhase('failed');
  setStatus(err instanceof ApiError ? err.message : ERRORS.failed, 'error');
  el.convert.textContent = 'ניסיון נוסף';
}

function eta(started, pct) {
  if (pct < 5) return 'מעריכים זמן...';
  const left = ((Date.now() - started) / pct) * (100 - pct) / 1000;
  if (left < 60) return 'פחות מדקה';
  return `עוד כ-${Math.round(left / 60)} דק׳`;
}

// Poll a task until it ends. Survives reloads: the active id is stored.
async function follow(id) {
  const token = ++state.pollToken;
  state.jobId = id;
  setPhase('processing');
  const started = Date.now();
  let misses = 0;
  while (token === state.pollToken) {
    let d;
    try {
      d = await getStatus(id);
      misses = 0;
    } catch (err) {
      if (err.code === 'network' && ++misses < 5) { await wait(POLL_MS * misses); continue; }
      archive.setActive(null);
      throw err;
    }
    if (token !== state.pollToken) return;
    if (d.status === 'SUCCEEDED') {
      archive.setActive(null);
      archive.upsert({ id, status: 'SUCCEEDED', expiresAt: d.expiresAt });
      renderArchive();
      setProgress(100, '');
      await showResult(id, d);
      return;
    }
    if (d.status === 'FAILED' || d.status === 'CANCELED') {
      archive.setActive(null);
      archive.upsert({ id, status: d.status });
      renderArchive();
      throw new ApiError('failed', d.error);
    }
    setProgress(Math.max(4, d.progress), eta(started, d.progress));
    setStatus(d.status === 'PENDING' ? 'בתור להמרה...' : 'בונים את הגוף...');
    await wait(POLL_MS);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function showResult(id, d) {
  setPhase('done');
  setDownloads({ urls: d.modelUrls });
  const entry = archive.get(id);
  setStatus('המודל מוכן. גוררים לסיבוב, ובוחרים "חימר" כדי לשפוט צורה.', 'ok');
  el.caption.innerHTML = `<span>MODEL / ${escapeHtml(entry ? entry.name : id)}</span><span>${d.expiresAt ? 'זמין עד ' + new Date(d.expiresAt).toLocaleDateString('he-IL') : ''}</span>`;
  if (!stage || !d.modelUrls.glb) return;
  el.note.textContent = 'טוענים את המודל...';
  try {
    const obj = await stage.loadUrl(d.modelUrls.glb, 'glb');
    stage.setBackdrop('dark');
    const info = stage.setObject(obj, { source: 'Meshy' });
    resetAnnotation();
    setFacts(info);
    el.note.textContent = '';
  } catch {
    el.note.textContent = 'לא ניתן להציג את המודל בדפדפן. הקבצים זמינים להורדה.';
  }
}

async function openTask(id) {
  ++state.pollToken;
  setStatus('בודקים את מצב ההמרה...');
  try {
    const d = await getStatus(id);
    if (d.status === 'SUCCEEDED') return showResult(id, d);
    if (d.status === 'FAILED' || d.status === 'CANCELED') throw new ApiError('failed', d.error);
    await follow(id);
  } catch (err) {
    fail(err);
  }
}

/* ---------------- Local 3D file ---------------- */
el.openLocal.addEventListener('click', () => el.localFile.click());
el.localFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !stage) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const kind = ext === 'stl' ? 'stl' : ext === 'obj' ? 'obj' : 'glb';
  const url = URL.createObjectURL(file);
  el.note.textContent = 'טוענים את הקובץ...';
  try {
    const obj = await stage.loadUrl(url, kind);
    stage.setBackdrop('dark');
    const info = stage.setObject(obj, { source: file.name });
    resetAnnotation();
    setFacts(info);
    setDownloads({ local: true });
    el.note.textContent = '';
    el.caption.innerHTML = `<span>FILE / ${escapeHtml(file.name)}</span><span></span>`;
    setStatus('הקובץ נטען. אפשר לייצא אותו ל-STL להדפסה.', 'ok');
  } catch (err) {
    console.warn('local model failed', err);
    el.note.textContent = '';
    setStatus('לא ניתן לקרוא את הקובץ. נתמכים GLB, STL ו-OBJ.', 'error');
  } finally {
    URL.revokeObjectURL(url);
  }
});

/* ---------------- Archive ---------------- */
// Two sources: saved works (IndexedDB) and AI conversions (task ids in localStorage).
let archiveCache = [];
async function renderArchive() {
  const saved = await works.listWorks().catch(() => []);
  const items = [
    ...saved.map((w) => ({ kind: 'work', engine: w.engine, id: w.id, name: w.name, date: w.date, thumb: w.thumb, meta: ENGINE_LABEL[w.engine] || 'פסל' })),
    ...archive.list().map((it) => {
      const st = { SUCCEEDED: 'מוכן', FAILED: 'נכשל', CANCELED: 'בוטל' }[it.status] || 'בתהליך';
      const expired = it.expiresAt && it.expiresAt < Date.now();
      return { kind: 'task', id: it.id, name: it.name, date: it.date, thumb: it.thumb, meta: 'בינה מלאכותית · ' + (expired ? 'פג תוקף' : st) };
    }),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  archiveCache = items;

  el.archiveEmpty.hidden = items.length > 0;
  el.archiveList.textContent = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.dataset.kind = it.kind;
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (it.thumb) {
      const img = document.createElement('img');
      img.src = it.thumb;
      img.alt = '';
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '<span>NO PREVIEW</span>';
    }
    const body = document.createElement('div');
    body.className = 'body';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = it.name || 'ציור';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${new Date(it.date).toLocaleDateString('he-IL')} · ${it.meta}`;
    const row = document.createElement('div');
    row.className = 'row';
    const open = document.createElement('a');
    open.className = 'btn';
    open.href = (it.kind === 'task' ? '#/model/' : it.engine === 'sketch' ? '#/draw/' : '#/work/') + encodeURIComponent(it.id);
    open.textContent = 'פתיחה בסטודיו';
    row.appendChild(open);
    if (state.editing) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn quiet';
      del.textContent = 'מחיקה';
      del.addEventListener('click', async () => {
        if (it.kind === 'work') await works.deleteWork(it.id).catch(() => {});
        else archive.remove(it.id);
        if (state.workId === it.id) { state.workId = null; el.saveBtn.textContent = 'שמירה לארכיון'; }
        if (state.sketchId === it.id) { state.sketchId = null; if (state.mode === 'sketch') el.saveBtn.textContent = 'שמירה לארכיון'; saveDraft(); }
        renderArchive();
      });
      row.appendChild(del);
    }
    body.append(name, meta, row);
    li.append(thumb, body);
    el.archiveList.appendChild(li);
  }
  updateMenu();
}

/* ---------------- Logo menu (A&I). Editing actions live only here. ---------------- */
function updateMenu() {
  const menu = document.querySelector('ai-menu');
  if (!menu) return;
  const apply = () => {
    menu.items = [
      { label: 'מצב עריכה', pressed: state.editing, onSelect: () => { state.editing = !state.editing; renderArchive(); } },
      { label: 'ניקוי הארכיון', disabled: archiveCache.length === 0, onSelect: async () => { if (confirm('למחוק את כל העבודות מהארכיון בדפדפן הזה?')) { archive.clearAll(); await works.clearWorks().catch(() => {}); state.workId = null; state.sketchId = null; saveDraft(); renderArchive(); } } },
    ];
    menu.status = state.editing ? 'מצב עריכה' : '';
  };
  if (customElements.get('ai-menu')) apply();
  else customElements.whenDefined('ai-menu').then(apply);
}

/* ---------------- Router ---------------- */
function route() {
  const hash = location.hash || '#/';
  let view = 'studio';
  let modelId = null;
  let workId = null;
  let nav = null;
  let sketchId = null;
  if (hash.startsWith('#/archive')) view = 'archive';
  else if (hash.startsWith('#/draw')) { nav = 'draw'; sketchId = decodeURIComponent(hash.slice(7)) || null; }
  else if (hash.startsWith('#/method')) view = 'method';
  else if (hash.startsWith('#/model/')) modelId = decodeURIComponent(hash.slice(8));
  else if (hash.startsWith('#/work/')) workId = decodeURIComponent(hash.slice(7));

  document.querySelectorAll('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== view; });
  setStudioMode(view === 'studio' && nav === 'draw' ? 'sketch' : 'image');
  document.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === (nav || view)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = nav === 'draw' ? 'ציור במרחב | ציור לתלת-ממד' : { studio: 'ציור לתלת-ממד', archive: 'ארכיון | ציור לתלת-ממד', method: 'שיטה | ציור לתלת-ממד' }[view];
  if (view === 'archive') renderArchive();
  if (modelId && modelId !== state.jobId) {
    state.jobId = modelId;
    setEngine('ai');
    openTask(modelId);
  }
  if (workId && workId !== state.workId) openWork(workId);
  if (sketchId && sketchId !== state.sketchId && state.mode === 'sketch') openSketch(sketchId);
  window.scrollTo({ top: 0 });
}
addEventListener('hashchange', route);

/* ---------------- Drawing in 3D ---------------- */
// The studio has two modes on one stage: a drawing becomes a body (image), or the pen draws
// straight into space (sketch). The draft of the 3D drawing is saved on every line.
const DRAFT = 'drawing3d.sketch.draft.v1';
function readDraft() { try { return JSON.parse(localStorage.getItem(DRAFT)) || null; } catch { return null; } }
function saveDraft() {
  if (!sketch || !sketch.active) return true;
  try {
    localStorage.setItem(DRAFT, JSON.stringify({ strokes: sketch.data, params: sketch.params, workId: state.sketchId, name: el.workName.value }));
    return true;
  } catch {
    return false;
  }
}

function setStudioMode(next) {
  if (next === 'sketch' && !sketch) next = 'image';
  const was = state.mode;
  state.mode = next;
  document.querySelectorAll('[data-for]').forEach((n) => { n.hidden = n.dataset.for !== next; });
  el.stage.classList.toggle('sketching', next === 'sketch');
  if (was === next) return;
  stopDrawing(true);
  resetAnnotation();
  if (next === 'sketch') {
    const draft = readDraft();
    state.sketchId = draft && draft.workId ? draft.workId : null;
    el.workName.value = (draft && draft.name) || 'ציור במרחב';
    el.saveBtn.textContent = state.sketchId ? 'עדכון בארכיון' : 'שמירה לארכיון';
    el.spinBtn.setAttribute('aria-pressed', 'false');
    sketch.enter(draft ? { strokes: readStrokes(draft.strokes), params: draft.params } : {});
    syncSketchControls();
    stage.setSpin(false);
  } else {
    if (sketch) sketch.leave();
    el.workName.value = state.drawing ? state.drawing.name : '';
    el.saveBtn.textContent = state.workId ? 'עדכון בארכיון' : 'שמירה לארכיון';
    state.anim = null;
    if (!stage) { /* nothing to show */ } else if (state.phase === 'sculpted' && state.sculpt) renderSculpt(false);
    else if (state.phase === 'done' && state.jobId) openTask(state.jobId);
    else showSample();
    setFacts(stage ? stage.info : null);
  }
  setPhase(state.phase);
}

function syncSketchControls() {
  const p = sketch.params;
  document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === sketch.tool)));
  document.querySelectorAll('[data-plane]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.plane === p.plane)));
  document.querySelectorAll('[data-result]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.result === p.result)));
  el.sketchPanel.dataset.shows = p.result;
  el.skDepth.value = Math.round(p.depth * 100); el.skDepthVal.textContent = el.skDepth.value;
  el.skWrap.value = Math.round(p.wrap * 100); el.skWrapVal.textContent = el.skWrap.value;
  el.skOffset.value = Math.round(p.offset * 100); el.skOffsetVal.textContent = el.skOffset.value;
  el.skThickness.value = Math.round(p.thickness * 100); el.skThicknessVal.textContent = el.skThickness.value;
  el.skSnap.checked = p.snap;
  el.skMirror.checked = p.symmetry;
}

const PLANE_HINT = { view: 'המשטח עומד מול המבט. מקיפים, והקו הבא נוחת בעומק אחר.', wall: 'מציירים על קיר קבוע. "עומק המשטח" מקרב ומרחיק אותו.', side: 'מציירים על קיר צד. מקיפים מעט כדי לראות אותו.', floor: 'מציירים על הרצפה. "עומק המשטח" מרים אותה לגובה.' };
function onSketchChange(st) {
  if (!sketch || !sketch.active) return;
  state.anim = sketch.animation;
  play.p = 1;
  showProgress();
  el.skUndo.disabled = !st.canUndo;
  el.skRedo.disabled = !st.canRedo;
  el.skNew.disabled = !st.count && !state.sketchId;
  setFacts(stage.info);
  setDownloads({ local: true });
  el.caption.innerHTML = `<span>SKETCH / <span dir="ltr">${st.groups}</span> קווים</span><span>${sketch.tool === 'orbit' ? 'גוררים להקפה' : 'גוררים לציור · ימני להקפה'}</span>`;
  setPhase(state.phase);
  const kept = saveDraft();
  if (!kept) setSketchStatus('הטיוטה גדולה מדי לשמירה אוטומטית בדפדפן. שומרים לארכיון כדי לא לאבד אותה.', 'error');
  else if (!st.count) setSketchStatus(st.result === 'sculpt' ? 'מציירים צורה עם קו מתאר סגור. אחרי כל קו הציור נקרא, והחוט מתלפף סביב הנפח.' : PLANE_HINT[sketch.params.plane]);
  else if (st.busy) setSketchStatus('קוראים את הציור ומלפפים...');
  else if (st.result === 'sculpt' && st.error) setSketchStatus('אין עדיין צורה סגורה ללפף סביבה. סוגרים את קו המתאר, והחוט יתלפף סביב הנפח.', 'error');
  else if (st.result === 'sculpt') setSketchStatus(`${st.groups} קווים · ${st.loops} ליפופים סביב הנפח · ${st.closed ? 'חוט סגור, מוכן להדפסה' : 'בודקים גוף סגור'}. מקיפים כדי לראות את הגב.`, st.closed ? 'ok' : '');
  else setSketchStatus(`${st.groups} קווים · ${st.closed ? 'חוט סגור, מוכן להדפסה' : 'בודקים גוף סגור'} · הטיוטה נשמרת לבד.`, st.closed ? 'ok' : '');
}
function setSketchStatus(text, kind = '') {
  el.skStatus.textContent = text;
  el.skStatus.className = 'status' + (kind ? ' ' + kind : '');
}

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
  sketch.setTool(b.dataset.tool);
  syncSketchControls();
  onSketchChange(sketch.state);
}));
document.querySelectorAll('[data-plane]').forEach((b) => b.addEventListener('click', () => {
  sketch.setParams({ plane: b.dataset.plane });
  syncSketchControls();
  setSketchStatus(PLANE_HINT[b.dataset.plane]);
  saveDraft();
}));
document.querySelectorAll('[data-result]').forEach((b) => b.addEventListener('click', () => {
  stopDrawing(true);
  sketch.setParams({ result: b.dataset.result });
  syncSketchControls();
  saveDraft();
}));
el.skDepth.addEventListener('input', () => { el.skDepthVal.textContent = el.skDepth.value; sketch.setParams({ depth: el.skDepth.value / 100 }); saveDraft(); });
el.skWrap.addEventListener('input', () => { el.skWrapVal.textContent = el.skWrap.value; sketch.setParams({ wrap: el.skWrap.value / 100 }); saveDraft(); });
el.skFront.addEventListener('click', () => sketch.front());
el.skOffset.addEventListener('input', () => { el.skOffsetVal.textContent = el.skOffset.value; sketch.setParams({ offset: el.skOffset.value / 100 }); saveDraft(); });
el.skThickness.addEventListener('input', () => { el.skThicknessVal.textContent = el.skThickness.value; sketch.setParams({ thickness: el.skThickness.value / 100 }); });
el.skSnap.addEventListener('change', () => { sketch.setParams({ snap: el.skSnap.checked }); saveDraft(); });
el.skMirror.addEventListener('change', () => { sketch.setParams({ symmetry: el.skMirror.checked }); saveDraft(); });
el.skUndo.addEventListener('click', () => sketch.undo());
el.skRedo.addEventListener('click', () => sketch.redo());
el.skNew.addEventListener('click', () => {
  stopDrawing(true);
  state.sketchId = null;
  el.workName.value = 'ציור במרחב';
  el.saveBtn.textContent = 'שמירה לארכיון';
  history.replaceState(null, '', '#/draw');
  sketch.clear(); // still undoable
  onSketchChange(sketch.state);
});

async function saveSketch(quiet = false) {
  if (!sketch || !sketch.state.count) return null;
  const id = state.sketchId || works.newId();
  const existing = state.sketchId ? await works.getWork(id).catch(() => null) : null;
  stopDrawing(true);
  const work = {
    id,
    name: el.workName.value.trim() || 'ציור במרחב',
    engine: 'sketch',
    params: sketch.params,
    strokes: sketch.data,
    thumb: sketch.withoutHelpers(() => stage.snapshot()),
    created: existing ? existing.created : new Date().toISOString(),
    date: new Date().toISOString(),
  };
  try {
    await works.saveWork(work);
  } catch (err) {
    console.warn('save failed', err);
    setSketchStatus('השמירה נכשלה. ייתכן שהדפדפן חוסם אחסון (חלון פרטי) או שהאחסון מלא.', 'error');
    return null;
  }
  if (quiet) return id;
  state.sketchId = id;
  el.saveBtn.textContent = 'עדכון בארכיון';
  history.replaceState(null, '', '#/draw/' + id);
  saveDraft();
  setSketchStatus(existing ? 'הציור עודכן בארכיון.' : 'הציור נשמר בארכיון.', 'ok');
  const menu = document.querySelector('ai-menu');
  if (menu) menu.status = 'נשמר';
  return id;
}

async function openSketch(id) {
  let work;
  try { work = await works.getWork(id); } catch { work = null; }
  if (!work || work.engine !== 'sketch') { setSketchStatus('הציור לא נמצא בארכיון של הדפדפן הזה.', 'error'); return; }
  // An unsaved draft is never lost: it goes to the archive before another work opens.
  if (!state.sketchId && sketch.state.count) {
    const name = el.workName.value;
    el.workName.value = 'טיוטה ' + new Date().toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
    await saveSketch(true);
    el.workName.value = name;
  }
  stopDrawing(true);
  state.sketchId = work.id;
  el.workName.value = work.name;
  el.saveBtn.textContent = 'עדכון בארכיון';
  sketch.load(readStrokes(work.strokes), work.params);
  syncSketchControls();
  setSketchStatus(`נפתח מהארכיון: ${work.name}. ממשיכים לצייר, והעדכון נשמר ב"עדכון בארכיון".`, 'ok');
}

/* ---------------- Boot ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Conversion service state ---------------- */
const SERVICE_TEXT = { checking: 'בודקים חיבור...', ready: 'מחובר', off: 'לא מחובר', unknown: 'לא ידוע' };
function setService(next) {
  state.service = next;
  el.service.dataset.state = next;
  el.serviceText.textContent = SERVICE_TEXT[next];
  el.serviceHint.hidden = next !== 'off';
  setPhase(state.phase);
}
async function checkService() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const d = await res.json();
    setService(res.ok && d.configured ? 'ready' : res.ok ? 'off' : 'unknown');
  } catch {
    setService('unknown'); // offline or no server: do not block, the attempt will explain
  }
}

showSample();
setEngine(state.engine);
setPhase('idle');
checkService();
renderArchive();
const active = archive.getActive();
if (active && !location.hash.startsWith('#/model/')) history.replaceState(null, '', '#/model/' + active);
route();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
