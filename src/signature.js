// Anat's own signature, drawn once and kept as lines (Anat, 1.11.2026: "add a pad for my
// signature"). Lines, not a picture: the signature stays sharp at any size, also on an image
// saved at twice the screen resolution. Pure functions plus a small browser pad.

const KEY = 'drawing3d.signature.v1';

/**
 * Normalise strokes (arrays of [x, y] in any units) to the signature's own box: height 1,
 * width = aspect, top-left at 0. A single dot or an empty pad gives null.
 */
export function normalise(strokes) {
  const pts = strokes.flat();
  if (pts.length < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const h = Math.max(1e-6, y1 - y0), w = x1 - x0;
  if (w < 1e-6 && h < 1e-5) return null;
  return {
    aspect: w / h,
    strokes: strokes.filter((s) => s.length).map((s) => s.map(([x, y]) => [Math.round(((x - x0) / h) * 1e4) / 1e4, Math.round(((y - y0) / h) * 1e4) / 1e4])),
  };
}

/** The lag of a pen: each point is pulled part of the way to the pointer (a round, calm line). */
export const follow = (prev, next, k = 0.5) => (prev ? [prev[0] + (next[0] - prev[0]) * k, prev[1] + (next[1] - prev[1]) * k] : next.slice());

/**
 * Draw a signature into a 2D context, with its bottom-left corner at (x, y) and the given height.
 * Each stroke is a curve through the midpoints of its points (quadratic), round ends, black ink.
 */
export function drawSignature(ctx, sig, x, y, height, colour = '#111') {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, height * 0.055);
  const P = ([px, py]) => [x + px * height, y - height + py * height];
  for (const s of sig.strokes) {
    ctx.beginPath();
    if (s.length === 1) { const [a, b] = P(s[0]); ctx.arc(a, b, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fillStyle = colour; ctx.fill(); continue; }
    let [ax, ay] = P(s[0]);
    ctx.moveTo(ax, ay);
    for (let i = 1; i < s.length - 1; i++) {
      const [bx, by] = P(s[i]), [cx, cy] = P(s[i + 1]);
      ctx.quadraticCurveTo(bx, by, (bx + cx) / 2, (by + cy) / 2);
    }
    const [ex, ey] = P(s[s.length - 1]);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
  ctx.restore();
}

export function loadSignature(storage = globalThis.localStorage) {
  try {
    const s = JSON.parse(storage.getItem(KEY));
    return s && Array.isArray(s.strokes) && s.aspect > 0 ? s : null;
  } catch { return null; }
}
export function saveSignature(sig, storage = globalThis.localStorage) {
  try { if (sig) storage.setItem(KEY, JSON.stringify(sig)); else storage.removeItem(KEY); return true; } catch { return false; }
}

/**
 * The pad: a dialog with a paper strip to sign on. Resolves with the saved signature, null when
 * the font is chosen again, or undefined when closed without a change.
 */
export function openSignaturePad() {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sign-dialog';
    dlg.setAttribute('dir', 'rtl');
    dlg.innerHTML = `
      <h2><b>החתימה שלי:</b> חותמים פעם אחת</h2>
      <p class="hint">חותמים על הדף בעכבר, בעט או באצבע. החתימה תופיע קטנה ושחורה בפינה השמאלית התחתונה של כל תמונה שנשמרת.</p>
      <canvas class="sign-pad" width="1200" height="400" aria-label="משטח חתימה"></canvas>
      <div class="actions">
        <button type="button" class="btn primary" data-act="save" disabled>שמירת החתימה</button>
        <button type="button" class="btn" data-act="clear">ניקוי</button>
        <button type="button" class="btn quiet" data-act="font">חזרה לחתימה בגופן</button>
        <button type="button" class="btn quiet" data-act="close">סגירה</button>
      </div>`;
    document.body.appendChild(dlg);
    const cv = dlg.querySelector('canvas'), ctx = cv.getContext('2d');
    const saveBtn = dlg.querySelector('[data-act="save"]');
    let strokes = [], cur = null, s = null;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * cv.width, ((e.clientY - r.top) / r.height) * cv.height]; };
    const paint = () => {
      ctx.fillStyle = '#ece6da';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.strokeStyle = 'rgba(23,20,15,0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(60, cv.height * 0.72); ctx.lineTo(cv.width - 60, cv.height * 0.72); ctx.stroke(); // the line to sign on
      const all = [...strokes, ...(cur ? [cur] : [])];
      const sig = normalise(all.length ? all : [[[0, 0]]]);
      // Draw in pad pixels directly (not normalised) so the pen stays under the hand.
      ctx.save(); ctx.strokeStyle = '#111'; ctx.lineCap = ctx.lineJoin = 'round'; ctx.lineWidth = 7;
      for (const st of all) { if (st.length < 2) continue; ctx.beginPath(); ctx.moveTo(...st[0]); for (let i = 1; i < st.length - 1; i++) ctx.quadraticCurveTo(st[i][0], st[i][1], (st[i][0] + st[i + 1][0]) / 2, (st[i][1] + st[i + 1][1]) / 2); ctx.lineTo(...st[st.length - 1]); ctx.stroke(); }
      ctx.restore();
      saveBtn.disabled = !sig;
    };
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); s = pos(e); cur = [s]; paint(); });
    cv.addEventListener('pointermove', (e) => { if (!cur) return; s = follow(s, pos(e)); const l = cur[cur.length - 1]; if (Math.hypot(s[0] - l[0], s[1] - l[1]) > 2) { cur.push(s); paint(); } });
    const end = (e) => { if (!cur) return; cur.push(pos(e)); strokes.push(cur); cur = null; paint(); };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    const done = (value) => { dlg.close(); dlg.remove(); resolve(value); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(undefined); });
    dlg.querySelector('[data-act="clear"]').addEventListener('click', () => { strokes = []; paint(); });
    dlg.querySelector('[data-act="close"]').addEventListener('click', () => done(undefined));
    dlg.querySelector('[data-act="font"]').addEventListener('click', () => { saveSignature(null); done(null); });
    saveBtn.addEventListener('click', () => { const sig = normalise(strokes); if (sig) { saveSignature(sig); done(sig); } });
    paint();
    dlg.showModal();
  });
}
