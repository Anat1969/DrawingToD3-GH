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
  await page.click('#thirdsBtn');
  ok(await page.locator('#thirds').isVisible(), 'rule of thirds grid shows');
  await page.click('#spinBtn');
  ok(await page.getAttribute('#spinBtn', 'aria-pressed') === 'false', 'spin toggles off');
  await page.locator('#lightAngle').fill('90');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '03-tools.png') });
  await page.click('#thirdsBtn');

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
  ok(loops >= 30, `wrap winds the thread around the volume (${loops} loops)`);
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
  await page.click('label:has(input[value="0"])');
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
  const delShown = await page.waitForFunction(() => document.querySelectorAll('#archiveList button.quiet').length === 2, null, { timeout: 5000 }).then(() => true, () => false);
  ok(delShown, 'edit mode from logo menu reveals delete on every card');
  await page.click('#archiveList li[data-kind="task"] a.btn');
  await page.waitForFunction(() => location.hash === '#/model/task_abc123' && !document.querySelector('[data-view="studio"]').hidden);
  ok(true, 'open from archive returns to studio');
  await page.click('a[data-route="archive"]');
  await page.click('#archiveList li[data-kind="task"] button:has-text("מחיקה")');
  await page.waitForTimeout(300);
  ok(await page.locator('#archiveList li').count() === 1, 'delete removes the item');
  await page.click('#archiveList li[data-kind="work"] button:has-text("מחיקה")');
  await page.waitForTimeout(300);
  ok(await page.locator('#archiveList li').count() === 0, 'saved work can be deleted too');

  // 8. Method
  await page.click('a[data-route="method"]');
  ok(await page.locator('.method li').count() === 9, 'method page renders');
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
  for (const h of ['#/', '#/archive', '#/method']) {
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
