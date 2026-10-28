import './styles/tokens.css';
import './styles/app.css';
import { createStage, sampleObject } from './viewer.js';
import { prepareDrawing, checkFile } from './image.js';
import { startConversion, getStatus, ApiError, ERRORS } from './api.js';
import * as archive from './history.js';

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
  service: $('service'), serviceText: $('serviceText'), serviceHint: $('serviceHint'),
  archiveList: $('archiveList'), archiveEmpty: $('archiveEmpty'),
};

/* ---------------- State ---------------- */
const state = {
  drawing: null,   // { dataUrl, thumb, name }
  phase: 'idle',   // idle | ready | uploading | processing | done | failed
  jobId: null,
  pollToken: 0,
  editing: false,
  service: 'checking', // checking | ready | off | unknown
};

/* ---------------- Stage ---------------- */
let stage = null;
try {
  stage = createStage(el.stage, { onFrame: drawAnnotation });
} catch (err) {
  console.error(err);
  el.note.textContent = 'הדפדפן לא תומך בתצוגה תלת-ממדית (WebGL). עדיין אפשר להמיר ולהוריד קבצים.';
}

function showSample() {
  if (!stage) return;
  const info = stage.setObject(sampleObject(), { source: 'מודל לדוגמה' });
  setFacts(info);
  setDownloads({ local: true });
  el.caption.innerHTML = '<span>SAMPLE / מודל לדוגמה</span><span>גוררים לסיבוב, גלגלת לזום</span>';
  resetAnnotation();
}

/* Annotation: circle around the subject, a leading line, and a label of real facts.
   Grammar taken from the inspiration image: "Bold: light". */
let ann = null;
function resetAnnotation() { ann = null; el.annotation.innerHTML = ''; }
function drawAnnotation(p) {
  if (!p || !stage || !stage.info) return;
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
    const [x, y, z] = info.proportion;
    box.innerHTML = `<b>פרופורציה:</b> <span dir="ltr">${x} × ${y} × ${z}</span><br><b>משולשים:</b> <span dir="ltr">${info.tris.toLocaleString('he-IL')}</span>`;
    fo.appendChild(box);
    el.annotation.append(circle, line, fo);
    ann = { circle, line, fo, last: '' };
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
    el.factSize.textContent = el.factTris.textContent = el.factSource.textContent = '-';
    return;
  }
  el.factSize.textContent = info.proportion.join(' × ');
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
  if (local && stage && stage.hasSubject) {
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
  el.downloadsEmpty.hidden = el.downloads.querySelectorAll('.btn').length > 0;
}

async function exportLocal(fmt) {
  const blob = await stage.exportFile(fmt);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `model.${fmt}`;
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
el.lightAngle.addEventListener('input', () => stage && stage.setLight(Number(el.lightAngle.value)));

/* ---------------- Drawing input ---------------- */
function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

function setPhase(phase) {
  state.phase = phase;
  const busy = phase === 'uploading' || phase === 'processing';
  el.convert.disabled = !state.drawing || busy || state.service === 'off';
  el.sample.hidden = !!state.drawing;
  el.reset.hidden = !state.drawing || busy;
  el.drop.disabled = busy;
  el.progress.hidden = !(busy || phase === 'done');
  document.querySelectorAll('input[name="texture"]').forEach((r) => { r.disabled = busy; });
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
    el.preview.src = dataUrl;
    el.preview.hidden = false;
    el.dropEmpty.hidden = true;
    setPhase('ready');
    setStatus(state.service === 'off'
      ? 'הציור מוכן. ההמרה תיפתח כששירות ההמרה יחובר.'
      : 'הציור מוכן. ההמרה לוקחת בדרך כלל שתיים עד חמש דקות.');
  } catch {
    setStatus('לא ניתן לקרוא את הקובץ. בוחרים תמונה אחרת.', 'error');
  }
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
  state.drawing = null;
  el.preview.hidden = true;
  el.preview.removeAttribute('src');
  el.dropEmpty.hidden = false;
  setPhase('idle');
  setProgress(0);
  setStatus('');
});

/* ---------------- Conversion ---------------- */
async function convert() {
  if (!state.drawing || state.phase === 'uploading' || state.phase === 'processing') return;
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
  el.convert.textContent = 'המרה למודל';
  setDownloads({ urls: d.modelUrls });
  const entry = archive.get(id);
  setStatus('המודל מוכן. גוררים לסיבוב, ובוחרים "חימר" כדי לשפוט צורה.', 'ok');
  el.caption.innerHTML = `<span>MODEL / ${escapeHtml(entry ? entry.name : id)}</span><span>${d.expiresAt ? 'זמין עד ' + new Date(d.expiresAt).toLocaleDateString('he-IL') : ''}</span>`;
  if (!stage || !d.modelUrls.glb) return;
  el.note.textContent = 'טוענים את המודל...';
  try {
    const obj = await stage.loadUrl(d.modelUrls.glb, 'glb');
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
function renderArchive() {
  const items = archive.list();
  el.archiveEmpty.hidden = items.length > 0;
  el.archiveList.textContent = '';
  for (const it of items) {
    const li = document.createElement('li');
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
    const st = { SUCCEEDED: 'מוכן', FAILED: 'נכשל', CANCELED: 'בוטל' }[it.status] || 'בתהליך';
    const expired = it.expiresAt && it.expiresAt < Date.now();
    meta.textContent = `${new Date(it.date).toLocaleDateString('he-IL')} · ${expired ? 'פג תוקף' : st}`;
    const row = document.createElement('div');
    row.className = 'row';
    const open = document.createElement('a');
    open.className = 'btn';
    open.href = '#/model/' + encodeURIComponent(it.id);
    open.textContent = 'פתיחה בסטודיו';
    row.appendChild(open);
    if (state.editing) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn quiet';
      del.textContent = 'מחיקה';
      del.addEventListener('click', () => { archive.remove(it.id); renderArchive(); });
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
      { label: 'ניקוי הארכיון', disabled: archive.list().length === 0, onSelect: () => { if (confirm('למחוק את כל ההמרות מהארכיון בדפדפן הזה?')) { archive.clearAll(); renderArchive(); } } },
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
  if (hash.startsWith('#/archive')) view = 'archive';
  else if (hash.startsWith('#/method')) view = 'method';
  else if (hash.startsWith('#/model/')) modelId = decodeURIComponent(hash.slice(8));

  document.querySelectorAll('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== view; });
  document.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = { studio: 'ציור לתלת-ממד', archive: 'ארכיון | ציור לתלת-ממד', method: 'שיטה | ציור לתלת-ממד' }[view];
  if (view === 'archive') renderArchive();
  if (modelId && modelId !== state.jobId) {
    state.jobId = modelId;
    openTask(modelId);
  }
  window.scrollTo({ top: 0 });
}
addEventListener('hashchange', route);

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
setPhase('idle');
checkService();
renderArchive();
const active = archive.getActive();
if (active && !location.hash.startsWith('#/model/')) history.replaceState(null, '', '#/model/' + active);
route();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
