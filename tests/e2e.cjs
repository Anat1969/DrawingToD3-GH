// End-to-end: drive the built app in Chromium, click every control, mock the API.
// Run: npm run build && npm run preview (in another shell), then npm run test:e2e
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.SHOTS || path.join(os.tmpdir(), 'drawing3d-shots');
fs.mkdirSync(OUT, { recursive: true });
const AI_MENU = process.env.AI_MENU_FILE; // optional local copy of ai-menu.js

let failures = 0;
function ok(cond, msg) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true, locale: 'he-IL' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'warning' && /failed/.test(m.text())) console.log('  warn:', m.text()); if (m.type() === 'error' && !/fonts|ai-menu|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  if (AI_MENU) await page.route('**/ai-menu.js', (r) => r.fulfill({ path: AI_MENU, contentType: 'text/javascript' }));

  // API mocks
  let convertBody = null; let statusCalls = 0; let mode = 'ok'; let glbPath = null;
  await page.route('**/api/convert', async (r) => {
    convertBody = JSON.parse(r.request().postData());
    if (mode === 'unconfigured') return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"server_not_configured"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"task_abc123"}' });
  });
  await page.route('**/api/status**', async (r) => {
    statusCalls++;
    const done = statusCalls > 1;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(done
      ? { status: 'SUCCEEDED', progress: 100, modelUrls: { glb: '/mock/model.glb', stl: '/mock/model.stl', '3mf': '/mock/model.3mf' }, expiresAt: Date.now() + 3 * 864e5, error: null }
      : { status: 'IN_PROGRESS', progress: 40, modelUrls: {}, expiresAt: null, error: null }) });
  });
  let healthy = true;
  await page.route('**/api/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: healthy }) }));
  await page.route('**/mock/model.glb', (r) => r.fulfill({ path: glbPath, contentType: 'model/gltf-binary' }));

  // 1. Home
  await page.goto(BASE + '/');
  await page.waitForSelector('#stage canvas');
  await page.waitForTimeout(1800);
  ok(await page.getAttribute('html', 'dir') === 'rtl', 'document is RTL');
  ok(await page.locator('a.app-name').getAttribute('href') === '#/', 'app name links home');
  ok(await page.locator('ai-menu .logo').isVisible().catch(() => false) || await page.evaluate(() => !!document.querySelector('ai-menu')?.shadowRoot?.querySelector('.logo')), 'A&I logo button in the top bar');
  ok(!(await page.locator('header >> text=העתקת קישור').first().isVisible().catch(() => false)), 'no loose development buttons in the bar');
  ok(await page.locator('#annotation circle').count() === 1, 'annotation circle drawn around the subject');
  ok(/פרופורציה/.test(await page.locator('.ann-label').innerText()), 'annotation shows real facts');
  ok(await page.locator('#factTris').innerText() !== '-', 'facts filled for sample');
  ok(await page.locator('.btn.primary').count() === 1, 'exactly one lit primary button');
  await page.screenshot({ path: path.join(OUT, '01-home.png') });

  // 2. Stage tools
  for (const m of ['clay', 'ink', 'source']) {
    await page.click(`[data-mode="${m}"]`);
    ok(await page.getAttribute(`[data-mode="${m}"]`, 'aria-pressed') === 'true', `mode ${m} toggles`);
    if (m === 'ink') { ok(await page.locator('#stage.paper').count() === 1, 'ink mode turns stage to paper'); await page.waitForTimeout(400); await page.screenshot({ path: path.join(OUT, '02-ink.png') }); }
  }
  ok(await page.locator('#thirdsBtn').count() === 0, 'no rule-of-thirds button: only relevant tools');
  await page.click('#spinBtn');
  ok(await page.getAttribute('#spinBtn', 'aria-pressed') === 'false', 'spin toggles off');
  await page.locator('#lightAngle').fill('90');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '03-tools.png') });

  // 3. Local export (also makes the GLB used by the mocked conversion)
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="glb"]')]);
  glbPath = path.join(OUT, 'sample.glb'); await dl.saveAs(glbPath);
  ok(fs.statSync(glbPath).size > 1000, 'GLB export downloads a real file');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="stl"]')]);
  const stlPath = path.join(OUT, 'sample.stl'); await dl.saveAs(stlPath);
  ok(fs.statSync(stlPath).size > 1000, 'STL export downloads a real file');

  // 4. Wrong file type
  await page.setInputFiles('#file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  ok(/לא נתמך/.test(await page.locator('#status').innerText()), 'wrong file type rejected with message');

  // 4b. Line sculpture (default): the ink as one continuous wire in space
  ok(await page.locator('input[name="engine"][value="line"]').isChecked(), 'line in space is the default engine');
  ok(await page.locator('#convertBtn').innerText() === 'פיסול מהציור', 'primary button names the local action');
  await page.click('#sampleBtn');
  await page.waitForSelector('#preview:not([hidden])');
  await page.click('#convertBtn');
  const lined = await page.waitForFunction(() => document.querySelector('#factSource').textContent === 'פיסול קווי', null, { timeout: 15000 }).then(() => true, () => false);
  ok(lined, 'sample drawing becomes a line sculpture' + (lined ? '' : ': ' + await page.locator('#status').innerText()));
  ok(await page.locator('#factClosed').innerText() === 'כן', 'the wire is a closed body (printable)');
  ok(/קווים:/.test(await page.locator('.ann-label').innerText()) && /חוט אחד/.test(await page.locator('.ann-label').innerText()), 'annotation reports lines found and one thread');
  ok(!/NaN/.test(await page.locator('#factSize').innerText()), 'proportions are real numbers');
  ok(await page.locator('#stage.paper').count() === 1, 'line sculpture sits on paper: a black line needs a light ground');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, '03a-line.png') });
  let before = await page.locator('#factSize').innerText();
  await page.locator('#depth').fill('100');
  await page.waitForTimeout(400);
  ok(await page.locator('#factSize').innerText() !== before, 'depth slider reshapes the wire live');
  await page.locator('#thickness').fill('80');
  await page.click('#continuous');
  await page.waitForTimeout(400);
  ok(!/חוט אחד/.test(await page.locator('.ann-label').innerText()), 'continuous thread can be switched off');
  await page.click('#continuous');
  await page.waitForTimeout(300);
  ok(/ליפופים:\s*\d+/.test(await page.locator('.ann-label').innerText()), 'annotation reports wrapping loops');
  await page.locator('#wrap').fill('0');
  await page.waitForTimeout(400);
  ok(/ליפופים:\s*0/.test(await page.locator('.ann-label').innerText()), 'wrap at 0 removes the wrapping');
  await page.locator('#wrap').fill('60');
  await page.waitForTimeout(400);
  const loops = Number(((await page.locator('.ann-label').innerText()).match(/ליפופים:\s*(\d+)/) || [])[1]);
  ok(loops >= 20, `wrap winds the thread around the volume (${loops} turns)`);
  ok(await page.locator('#factClosed').innerText() === 'כן', 'wrapped thread is still a closed body');
  await page.locator('#sensitivity').fill('95');
  await page.waitForTimeout(600);
  ok(await page.locator('#sensitivityVal').innerText() === '95', 'line sensitivity slider works');
  await page.locator('#cloud').fill('90');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '03a2-wrap-cloud.png') });

  // Drawing the work from the first line to the last
  ok(await page.locator('#anim').isVisible(), 'animation controls appear for a line sculpture');
  ok(/\/ 0:[1-3]\d/.test(await page.locator('#animTime').innerText()), 'animation has a real duration');
  await page.locator('#scrub').fill('300');
  await page.waitForTimeout(300);
  ok(await page.locator('#playBtn').innerText() === 'המשך', 'scrubbing pauses mid-drawing');
  ok(await page.locator('#annotation.hidden-while-drawing').count() === 1, 'annotation steps aside while drawing');
  await page.screenshot({ path: path.join(OUT, '03a3-drawing.png') });
  await page.click('#playBtn');
  await page.waitForTimeout(1200);
  ok(Number(await page.locator('#scrub').inputValue()) > 300, 'play continues the drawing');
  ok(await page.locator('#playBtn').innerText() === 'השהיה', 'play button turns into pause');
  await page.click('#playBtn');
  await page.locator('#scrub').fill('1000');
  await page.waitForTimeout(300);
  ok(await page.locator('#playBtn').innerText() === 'ציור מההתחלה', 'at the end it offers to draw from the start');
  [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.click('#recordBtn')]);
  const video = path.join(OUT, 'drawing.webm'); await dl.saveAs(video);
  ok(fs.statSync(video).size > 50000 && /\.webm$/.test(dl.suggestedFilename()), `drawing is saved as a video (${fs.statSync(video).size} bytes, ${dl.suggestedFilename()})`);

  // Save to the archive
  ok(await page.locator('#saveBox').isVisible(), 'save appears once there is a sculpture');
  await page.fill('#workName', 'בית בקו');
  await page.click('#saveBtn');
  await page.waitForFunction(() => location.hash.startsWith('#/work/'));
  ok(/נשמרה בארכיון/.test(await page.locator('#status').innerText()), 'saved to the archive');
  ok(await page.locator('#saveBtn').innerText() === 'עדכון בארכיון', 'next save updates the same work');
  const workHash = await page.evaluate(() => location.hash);

  // Same drawing as an inflated body
  await page.click('label:has(input[name="engine"][value="local"])');
  await page.waitForFunction(() => document.querySelector('#factSource').textContent === 'פיסול מקומי', null, { timeout: 15000 });
  ok(await page.locator('#factClosed').innerText() === 'כן', 'switching engine re-sculpts the same drawing as a closed body');
  ok(await page.locator('#stage.paper').count() === 0, 'inflated body returns to the dark stage');
  const tris = Number((await page.locator('#factTris').innerText()).replace(/\D/g, ''));
  ok(tris > 5000, `body has real geometry (${tris} triangles)`);
  before = await page.locator('#factSize').innerText();
  await page.locator('#volume').fill('100');
  await page.waitForTimeout(400);
  ok(await page.locator('#factSize').innerText() !== before, 'volume slider reshapes the body live');
  await page.click('[data-mode="clay"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '03b-sculpt-clay.png') });
  await page.click('[data-mode="source"]');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="stl"]')]);
  const sculptStl = path.join(OUT, 'sculpt.stl'); await dl.saveAs(sculptStl);
  ok(fs.statSync(sculptStl).size > 100000, 'sculpt exports as STL');

  // Reopen the saved work from the archive: drawing, engine and settings come back
  await page.click('a[data-route="archive"]');
  await page.waitForSelector('#archiveList li[data-kind="work"]');
  ok(/בית בקו/.test(await page.locator('#archiveList li[data-kind="work"] .name').innerText()), 'archive shows the saved work by name');
  ok(/קו במרחב/.test(await page.locator('#archiveList li[data-kind="work"] .meta').innerText()), 'archive shows the engine');
  ok(await page.locator('#archiveList li[data-kind="work"] img').count() === 1, 'archive card has a picture of the sculpture');
  await page.screenshot({ path: path.join(OUT, '03c-archive.png') });
  await page.click('a.app-name');
  await page.click('#resetBtn');
  await page.goto(BASE + '/' + workHash);
  await page.reload();
  const reopened = await page.waitForFunction(() => document.querySelector('#factSource').textContent === 'פיסול קווי', null, { timeout: 15000 }).then(() => true, () => false);
  ok(reopened, 'saved work reopens as a line sculpture after reload');
  ok(await page.locator('#depth').inputValue() === '100' && await page.locator('#thickness').inputValue() === '80' && await page.locator('#wrap').inputValue() === '60' && await page.locator('#cloud').inputValue() === '90', 'saved settings come back');
  ok(await page.locator('#workName').inputValue() === 'בית בקו', 'saved name comes back');
  await page.click('#resetBtn');
  await page.goto(BASE + '/#/');

  // 4c. Drawing in 3D: the pen draws straight into space
  await page.click('a[data-route="draw"]');
  await page.waitForFunction(() => !document.querySelector('.sketch-panel').hidden);
  ok(await page.evaluate(() => location.hash) === '#/draw', 'nav opens drawing in space');
  ok(await page.locator('a[data-route="draw"][aria-current="page"]').count() === 1, 'nav marks drawing in space as current');
  ok(await page.locator('[data-for="image"]:visible').count() === 0, 'image tools step aside while drawing in space');
  ok(await page.locator('#stage.paper').count() === 1, 'drawing in space sits on paper');
  ok(await page.locator('.btn.primary:visible').count() <= 1, 'at most one lit button');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '10a-sketch-empty.png') });
  const cv = await page.locator('#stage canvas').boundingBox();
  const at = (fx, fy) => [cv.x + cv.width * fx, cv.y + cv.height * fy];
  async function stroke(pts, opts = {}) {
    await page.mouse.move(...at(...pts[0]));
    await page.mouse.down(opts);
    for (let i = 1; i < pts.length; i++) await page.mouse.move(...at(...pts[i]), { steps: 6 });
    await page.mouse.up(opts);
    await page.waitForTimeout(150);
  }
  const loop = (cx, cy, r, n = 28, turns = 1) => Array.from({ length: n + 1 }, (_, i) => { const a = (i / n) * Math.PI * 2 * turns; return [cx + Math.cos(a) * r * 0.7, cy + Math.sin(a) * r]; });
  const groups = async () => Number(((await page.locator('#stageCaption').innerText()).match(/(\d+)\s*קווים/) || [])[1]);
  // Default: the drawing is read and wound into space (Anat: "the line is not flat, it wraps space")
  ok(await page.getAttribute('[data-result="sculpt"]', 'aria-pressed') === 'true', 'reading the drawing into a wound sculpture is the default');
  const readDone = () => page.waitForFunction(() => /ליפופים|אין עדיין/.test(document.querySelector('#skStatus').textContent), null, { timeout: 15000 });
  const pear = Array.from({ length: 49 }, (_, i) => { const a = (i / 48) * Math.PI * 2; const r = 0.2 + 0.06 * Math.sin(a); return [0.5 + Math.cos(a) * r * 0.75, 0.55 + Math.sin(a) * r * 1.1]; });
  await stroke(pear);
  await stroke([[0.45, 0.45], [0.5, 0.55], [0.47, 0.7]]);
  await readDone();
  const wraps = Number(((await page.locator('#skStatus').innerText()).match(/(\d+) ליפופים/) || [])[1]);
  ok(wraps >= 10, `the drawn shape is read and the thread winds around its volume (${wraps} wraps)`);
  const zDepth = Number((await page.locator('#factSize').innerText()).split('×').map((v) => v.trim())[2]);
  ok(zDepth >= 20, `the result is not flat: depth is ${zDepth}% of the size`);
  ok(await page.locator('#factClosed').innerText() === 'כן', 'the wound thread is a closed body');
  await page.screenshot({ path: path.join(OUT, '10a2-sketch-read.png') });
  await page.mouse.move(...at(0.5, 0.5));
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(...at(0.78, 0.47), { steps: 15 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '10a3-sketch-read-side.png') });
  await page.locator('#skDepth').fill('100');
  await page.waitForTimeout(800);
  const zDeeper = Number((await page.locator('#factSize').innerText()).split('×').map((v) => v.trim())[2]);
  ok(zDeeper > zDepth, `depth slider pushes the body further out of the page (${zDepth} to ${zDeeper})`);
  await page.locator('#skWrap').fill('0');
  await page.waitForTimeout(800);
  ok(/ 0 ליפופים/.test(await page.locator('#skStatus').innerText()), 'wrap at 0 leaves only the drawn lines on the body');
  await page.locator('#skWrap').fill('45');
  await page.click('#skFront');
  await page.click('#skNew');
  // As drawn: each line stays where the pen put it
  await page.click('[data-result="line"]');
  ok(await page.locator('[data-plane="floor"]').isVisible() && await page.locator('#skDepth').isHidden(), 'as drawn: the sheet tools replace depth and wrap');
  await stroke(loop(0.5, 0.45, 0.22));
  ok(await groups() === 1, 'a drag draws one line in space');
  ok(await page.locator('#factClosed').innerText() === 'כן', 'the drawn wire is a closed body (printable)');
  ok(await page.locator('#saveBox').isVisible(), 'save appears once there is a line');
  // Continue the first line from its start: the second line snaps to it.
  await stroke([[0.5 + 0.22 * 0.7, 0.45], [0.75, 0.3], [0.82, 0.18]]);
  ok(await groups() === 2, 'a second line continues from the first');
  // Orbit with the right button, then draw at another depth.
  await page.mouse.move(...at(0.5, 0.5));
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(...at(0.75, 0.48), { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(300);
  ok(await groups() === 2, 'right drag orbits and does not draw');
  await stroke(loop(0.5, 0.5, 0.18, 36, 1.5));
  ok(await groups() === 3, 'after orbiting, the next line lands at another depth');
  const size2 = await page.locator('#factSize').innerText();
  ok(!/^100 × 100 × 0$|NaN/.test(size2) && /\d+ × \d+ × \d+/.test(size2), `the drawing has real depth (${size2})`);
  // Space held: orbit with the left button.
  await page.keyboard.down('Space');
  await stroke([[0.3, 0.6], [0.6, 0.62]]);
  await page.keyboard.up('Space');
  ok(await groups() === 3, 'holding Space orbits instead of drawing');
  // Symmetry: one gesture, two lines.
  await page.click('#skMirror');
  await page.click('[data-plane="floor"]');
  ok(await page.getAttribute('[data-plane="floor"]', 'aria-pressed') === 'true', 'floor sheet can be chosen');
  await page.locator('#skOffset').fill('-60');
  await stroke([[0.62, 0.7], [0.7, 0.75], [0.8, 0.72]]);
  ok(await groups() === 4, 'symmetric line counts as one gesture');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '10b-sketch.png') });
  // Undo and redo, by button and by keyboard.
  await page.click('#skUndo');
  ok(await groups() === 3, 'undo removes the last line (with its mirror)');
  await page.click('#skRedo');
  ok(await groups() === 4, 'redo brings it back');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  ok(await groups() === 3, 'Ctrl+Z undoes');
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(150);
  ok(await groups() === 4, 'Ctrl+Shift+Z redoes');
  await page.locator('#skThickness').fill('70');
  await page.waitForTimeout(300);
  ok(await page.locator('#factClosed').innerText() === 'כן', 'thicker wire is still closed');
  // View modes are for solid bodies: a drawn wire has none.
  ok(await page.locator('#modeSeg').isHidden(), 'view modes step aside for a drawn wire');
  if (0) await page.click('[data-mode="clay"]');
  // Replay in the real drawing order
  ok(await page.locator('#anim').isVisible(), 'the drawing can be replayed from the first line');
  await page.locator('#scrub').fill('400');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '10c-sketch-replay.png') });
  await page.locator('#scrub').fill('1000');
  // Export
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="stl"]')]);
  const sketchStl = path.join(OUT, 'sketch.stl'); await dl.saveAs(sketchStl);
  ok(fs.statSync(sketchStl).size > 20000 && dl.suggestedFilename() === 'sketch.stl', `the drawing exports as STL (${fs.statSync(sketchStl).size} bytes)`);
  // Draft survives a reload before saving
  await page.reload();
  await page.waitForFunction(() => /\d+\s*קווים/.test(document.querySelector('#stageCaption').textContent), null, { timeout: 8000 });
  ok(await groups() === 4, 'the draft comes back after reload, without saving');
  ok(await page.locator('#skThickness').inputValue() === '70' && await page.locator('#skMirror').isChecked(), 'draft settings come back');
  // Save to the archive and reopen from it
  await page.fill('#workName', 'כדור צמר');
  await page.click('#saveBtn');
  await page.waitForFunction(() => location.hash.startsWith('#/draw/w'));
  ok(/נשמר בארכיון/.test(await page.locator('#skStatus').innerText()), 'the drawing is saved to the archive');
  const sketchHash = await page.evaluate(() => location.hash);
  await page.click('#skNew');
  ok(await groups() === 0, 'new drawing starts empty');
  await page.click('#skUndo');
  ok(await groups() === 4, 'a new drawing can be undone');
  await page.click('#skNew');
  await page.click('a[data-route="archive"]');
  await page.waitForSelector('#archiveList li[data-kind="work"] >> text=כדור צמר');
  const card = page.locator('#archiveList li[data-kind="work"]', { hasText: 'כדור צמר' });
  ok(/ציור במרחב/.test(await card.locator('.meta').innerText()), 'archive card names the drawing in space');
  ok(await card.locator('img').count() === 1, 'archive card has a picture of the drawing');
  await card.locator('a.btn').click();
  await page.waitForFunction((h) => location.hash === h, sketchHash);
  await page.waitForFunction(() => /4\s*קווים/.test(document.querySelector('#stageCaption').textContent), null, { timeout: 8000 }).catch(() => {});
  ok(await groups() === 4 && await page.locator('#workName').inputValue() === 'כדור צמר', 'the drawing reopens from the archive');
  await page.screenshot({ path: path.join(OUT, '10d-sketch-reopened.png') });
  await page.click('a.app-name');
  await page.waitForFunction(() => !document.querySelector('[data-for="image"].panel').hidden);
  ok(await page.locator('#stage.paper').count() === 0 && /מודל לדוגמה/.test(await page.locator('#factSource').innerText()), 'back to the studio: the drawing tools step aside');

  // 4d. A landscape is laid out in depth, not inflated (Anat's beach with a boat, 31.10.2026)
  await page.setInputFiles('#file', path.join(__dirname, 'fixtures', 'boat.jpg'));
  await page.waitForSelector('#preview:not([hidden])');
  await page.click('#convertBtn');
  const scene = await page.waitForFunction(() => document.querySelector('#factSource').textContent === 'פיסול קווי, נוף', null, { timeout: 30000 }).then(() => true, () => false);
  ok(scene, 'a beach is read as a landscape' + (scene ? '' : ': ' + await page.locator('#factSource').innerText()));
  ok(/זוהה נוף/.test(await page.locator('#readingNote').innerText()), 'the note says a landscape was found and where its horizon is');
  const sz = (await page.locator('#factSize').innerText()).split('×').map((v) => Number(v.trim()));
  ok(sz[2] === 100, `the landscape is deepest along the view: ${sz.join(' × ')}`);
  ok(await page.locator('#factClosed').innerText() === 'כן', 'the landscape thread is a closed body too');
  ok(await page.locator('#colourThread').isChecked(), 'the coloured thread is on by default');
  await page.click('#frontBtn');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '11a-scene-front.png') });
  await page.click('#spinBtn').catch(() => {});
  await page.click('[data-reading="object"]');
  await page.waitForFunction(() => document.querySelector('#factSource').textContent === 'פיסול קווי', null, { timeout: 30000 });
  ok(/נקרא כדבר/.test(await page.locator('#readingNote').innerText()), 'it can be read as an object instead');
  await page.click('[data-reading="auto"]');
  await page.click('#resetBtn');

  // 4e. A photograph: near and far as layers, sharpness against a blurred background (1.11.2026)
  await page.setInputFiles('#file', path.join(__dirname, 'fixtures', 'photographer.jpg'));
  await page.waitForSelector('#preview:not([hidden])');
  await page.click('#convertBtn');
  const photo = await page.waitForFunction(() => document.querySelector('#factSource').textContent === 'פיסול קווי, צילום', null, { timeout: 30000 }).then(() => true, () => false);
  ok(photo, 'a shallow-focus photograph is read as near and far' + (photo ? '' : ': ' + await page.locator('#factSource').innerText()));
  ok(/זוהה צילום/.test(await page.locator('#readingNote').innerText()), 'the note explains the layers');
  ok(await page.locator('#modeSeg').isHidden(), 'no clay mode for a line sculpture');
  const pz = (await page.locator('#factSize').innerText()).split('×').map((v) => Number(v.trim()));
  ok(pz[2] >= 40, `near and far stand apart in depth (${pz.join(' × ')})`);
  await page.click('#frontBtn');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '12a-photo-front.png') });
  // The work alone as a picture, signed
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#imageBtn')]);
  const png = path.join(OUT, dl.suggestedFilename()); await dl.saveAs(png);
  ok(/^anat-[\d-]+\.png$/.test(dl.suggestedFilename()) && fs.statSync(png).size > 100000, `the picture is saved alone, signed (${dl.suggestedFilename()}, ${fs.statSync(png).size} bytes)`);
  // Her own signature: drawn once on a pad from the logo menu, then on every saved picture
  await page.evaluate(() => document.querySelector('ai-menu').shadowRoot.querySelector('.logo').click());
  await page.waitForTimeout(300);
  await page.evaluate(() => [...document.querySelector('ai-menu').shadowRoot.querySelectorAll('.item')].find((b) => b.textContent.includes('החתימה שלי')).click());
  await page.waitForSelector('.sign-dialog[open] canvas');
  ok(await page.locator('.sign-dialog [data-act="save"]').isDisabled(), 'nothing to save before signing');
  const pad = await page.locator('.sign-pad').boundingBox();
  const sign = async (pts) => { await page.mouse.move(pad.x + pad.width * pts[0][0], pad.y + pad.height * pts[0][1]); await page.mouse.down(); for (const q of pts.slice(1)) await page.mouse.move(pad.x + pad.width * q[0], pad.y + pad.height * q[1], { steps: 5 }); await page.mouse.up(); };
  await sign([[0.8, 0.6], [0.72, 0.4], [0.66, 0.65], [0.58, 0.45], [0.5, 0.62], [0.42, 0.4], [0.35, 0.6]]);
  await sign([[0.3, 0.5], [0.22, 0.62], [0.15, 0.45]]);
  await page.screenshot({ path: path.join(OUT, '12c-signature-pad.png') });
  await page.click('.sign-dialog [data-act="save"]');
  await page.waitForSelector('.sign-dialog', { state: 'detached' });
  ok(await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('drawing3d.signature.v1')); return s && s.strokes.length === 2 && s.aspect > 1; }), 'the signature is kept as two lines');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#imageBtn')]);
  const signed = path.join(OUT, 'signed-' + dl.suggestedFilename()); await dl.saveAs(signed);
  ok(/עם החתימה שלך/.test(await page.locator('#status').innerText()), 'the saved picture carries her own signature');

  // The studio fits the window: no page scroll
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(500);
  const over = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  ok(over <= 0, `the studio fits a 1600 x 900 window without scrolling (${over}px)`);
  await page.screenshot({ path: path.join(OUT, '12b-studio-1600.png') });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.click('#resetBtn');

  // 5. Unconfigured server message (AI engine)
  mode = 'unconfigured';
  await page.click('label:has(input[name="engine"][value="ai"])');
  ok(await page.locator('#convertBtn').innerText() === 'המרה למודל', 'AI engine names its action');
  await page.click('#sampleBtn');
  await page.waitForSelector('#preview:not([hidden])');
  ok(!(await page.locator('#convertBtn').isDisabled()), 'convert enabled after choosing a drawing');
  await page.click('#convertBtn');
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('error'));
  ok(/לא מחובר/.test(await page.locator('#status').innerText()), 'server not configured message');
  ok(await page.locator('#convertBtn').innerText() === 'ניסיון נוסף', 'retry offered after failure');
  ok(await page.locator('#convertBtn').isDisabled(), 'convert disabled once the server reports no key');
  ok(await page.locator('#serviceHint').isVisible(), 'explains what still works without the key');

  // 5b. Service state on load
  healthy = false;
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#service').dataset.state === 'off');
  ok(/לא מחובר/.test(await page.locator('#service').innerText()), 'service shows "not connected" on load');
  await page.click('#sampleBtn');
  await page.waitForSelector('#preview:not([hidden])');
  ok(await page.locator('#convertBtn').isDisabled(), 'convert stays disabled while not connected');
  ok(/יחובר/.test(await page.locator('#status').innerText()), 'status line does not promise a conversion time while not connected');
  await page.screenshot({ path: path.join(OUT, '04a-not-connected.png') });
  healthy = true;
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#service').dataset.state === 'ready');
  ok(/מחובר/.test(await page.locator('#service').innerText()) && await page.locator('#serviceHint').isHidden(), 'service shows "connected" when the key exists');
  await page.click('#sampleBtn');
  await page.waitForSelector('#preview:not([hidden])');

  // 6. Successful conversion
  mode = 'ok';
  await page.click('label:has(input[name="texture"][value="0"])');
  await page.click('#convertBtn');
  await page.waitForFunction(() => document.querySelector('#progressPct').textContent === '40%', null, { timeout: 8000 });
  ok(true, 'progress shows percent while processing');
  await page.screenshot({ path: path.join(OUT, '04-processing.png') });
  ok(/^data:image\/jpeg;base64,/.test(convertBody.image) && convertBody.texture === false, 'request carries the downscaled JPEG and the shape-only option');
  await page.waitForSelector('#downloads a[data-format="3mf"]', { timeout: 10000 });
  ok(await page.locator('#downloads a[data-format]').count() === 3, 'GLB, STL and 3MF links shown');
  ok(page.url().endsWith('#/model/task_abc123'), 'URL holds the model id (copy link shares it)');
  await page.waitForFunction(() => document.querySelector('#factSource').textContent === 'Meshy', null, { timeout: 8000 });
  ok(true, 'converted model loads into the stage');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '05-done.png') });

  // 7. Archive + edit mode through the logo menu
  await page.click('a[data-route="archive"]');
  ok(await page.locator('#archiveList li[data-kind="task"]').count() === 1, 'archive lists the conversion');
  ok(/מוכן/.test(await page.locator('#archiveList li[data-kind="task"] .meta').innerText()), 'archive shows status');
  await page.screenshot({ path: path.join(OUT, '06-archive.png') });
  await page.evaluate(() => document.querySelector('ai-menu').shadowRoot.querySelector('.logo').click());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '07-menu.png') });
  await page.evaluate(() => [...document.querySelector('ai-menu').shadowRoot.querySelectorAll('.item')].find((b) => b.textContent.includes('מצב עריכה')).click());
  const delShown = await page.waitForFunction(() => document.querySelectorAll('#archiveList button.quiet').length === 3, null, { timeout: 5000 }).then(() => true, () => false);
  ok(delShown, 'edit mode from logo menu reveals delete on every card');
  await page.click('#archiveList li[data-kind="task"] a.btn');
  await page.waitForFunction(() => location.hash === '#/model/task_abc123' && !document.querySelector('[data-view="studio"]').hidden);
  ok(true, 'open from archive returns to studio');
  await page.click('a[data-route="archive"]');
  await page.click('#archiveList li[data-kind="task"] button:has-text("מחיקה")');
  await page.waitForTimeout(300);
  ok(await page.locator('#archiveList li').count() === 2, 'delete removes the item');
  await page.locator('#archiveList li[data-kind="work"] button:has-text("מחיקה")').first().click();
  await page.waitForTimeout(300);
  await page.locator('#archiveList li[data-kind="work"] button:has-text("מחיקה")').first().click();
  await page.waitForTimeout(300);
  ok(await page.locator('#archiveList li').count() === 0, 'saved works can be deleted too');

  // 8. Method
  await page.click('a[data-route="method"]');
  ok(await page.locator('.method li').count() === 11, 'method page renders');
  await page.screenshot({ path: path.join(OUT, '08-method.png') });

  // 9. Local 3D file
  await page.click('a.app-name');
  await page.setInputFiles('#localFile', stlPath);
  const opened = await page.waitForFunction(() => document.querySelector('#factSource').textContent.endsWith('.stl'), null, { timeout: 10000 }).then(() => true, () => false);
  ok(opened, 'local STL opens in the stage' + (opened ? '' : ': ' + await page.locator('#status').innerText() + ' / ' + await page.locator('#factSource').innerText()));

  ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

  // 10. Mobile: no horizontal scroll
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  if (AI_MENU) await mp.route('**/ai-menu.js', (r) => r.fulfill({ path: AI_MENU, contentType: 'text/javascript' }));
  for (const h of ['#/', '#/draw', '#/archive', '#/method']) {
    await mp.goto(BASE + '/' + h);
    await mp.waitForTimeout(1200);
    const over = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 0, `mobile ${h}: no horizontal scroll (${over}px)`);
    await mp.screenshot({ path: path.join(OUT, `09-mobile-${h.replace(/\W/g, '') || 'home'}.png`), fullPage: true });
  }

  // 11. Installability
  const cdp = await ctx.newCDPSession(page);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  ok(installabilityErrors.length === 0, 'installable in Chrome' + (installabilityErrors.length ? ': ' + JSON.stringify(installabilityErrors) : ''));

  await browser.close();
  console.log(`\nscreenshots: ${OUT}`);
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
