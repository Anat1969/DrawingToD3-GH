// בדיקת דף הכתבות מול vite preview: npm run build && (npm run preview &) && node tests/creations.cjs
// הרכיב המשותף נטען מעותק מקומי (CREATIONS_JS, או AppOfApp-GH שליד הריפו), כי הסביבה לא תמיד מגיעה ל-github.io.
// SHOTS=<תיקייה> שומר צילום של כל כתבה ושל הדף ב-1440 וב-390.
const fs = require('fs');
const path = require('path');
let pw; try { pw = require('playwright'); } catch { pw = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright'); }
const BASE = process.env.BASE || 'http://localhost:4173/';
const PAGE = process.env.PAGE || '#/creations';
const LAYOUT = process.env.LAYOUT || 'blueprint';
const CREATIONS_JS = process.env.CREATIONS_JS || path.join(__dirname, '../../appofapp-gh/public/creations.js');
const SHOTS = process.env.SHOTS;
const CR = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/creations.json'), 'utf8'));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

(async () => {
  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    // דפדפן חדש לכל רוחב: הבמה התלת-ממדית של הסטודיו לא משאירה עומס לבדיקה הבאה
    const b = await pw.chromium.launch();
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: SHOTS || vp.width < 800 ? 2 : 1 });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    if (fs.existsSync(CREATIONS_JS)) await p.route('**/creations.js', (r) => r.fulfill({ path: CREATIONS_JS, contentType: 'application/javascript' }));
    await p.route('**/ai-menu.js', (r) => r.fulfill({ body: 'customElements.define("ai-menu", class extends HTMLElement {})', contentType: 'application/javascript' }));
    await p.goto(BASE + PAGE, { waitUntil: 'load' });
    await p.locator('app-creations .ar-sheet').first().waitFor({ timeout: 15000 });
    await p.waitForFunction(() => [...document.querySelectorAll('.ar-grid .ar-sheet')].every((s) => s.dataset.fit), null, { timeout: 30000 });
    const sheets = await p.evaluate(() => [...document.querySelectorAll('.ar-grid .ar-sheet')].map((s) => ({ id: s.dataset.ar, fit: s.dataset.fit, layout: s.dataset.layout, dropped: s.dataset.dropped || '' })));
    ok(sheets.length === CR.topics.length, `${vp.width}: ${sheets.length} כתבות, אחת לכל נושא`);
    ok(sheets.every((s) => s.layout === LAYOUT), `${vp.width}: פורמט ${LAYOUT}`);
    ok(sheets.every((s) => s.fit !== 'over'), `${vp.width}: בלי גלישה (${sheets.map((s) => s.fit + (s.dropped ? '/' + s.dropped : '')).join(' ')})`);
    const widths = await p.locator('.ar-item').first().locator('.ar-acts > *').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    ok(widths.length === 3 && new Set(widths).size === 1, `${vp.width}: שלושה כפתורים באותו רוחב (${widths})`);
    const up = await p.locator('.ar-item').first().locator('.ar-acts a').getAttribute('href');
    ok(up.startsWith('https://taarucha.vercel.app/studio/import?article=1&src=') && up.endsWith('&topic=' + CR.topics[0].id), `${vp.width}: העלאה לחדר במוזיאון`);
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `${vp.width}: בלי גלילה אופקית`);
    ok(await p.evaluate(() => document.documentElement.scrollHeight > window.innerHeight * 2), `${vp.width}: הדף נגלל רגיל`);
    // יצירת כתבה ממקור במאגר
    await p.click('[data-ar-new]');
    ok(await p.locator('.ar-comp').isVisible(), `${vp.width}: יצירת כתבה נפתחת בתוך הדף`);
    await p.locator('.ar-src').nth(3).click();
    await p.waitForFunction(() => document.querySelector('.ar-comp-art .ar-sheet')?.dataset.fit, null, { timeout: 15000 });
    ok((await p.locator('.ar-comp-art .ar-sheet').getAttribute('data-fit')) !== 'over', `${vp.width}: הכתבה החדשה בלי גלישה`);
    ok((await p.locator('.ar-comp-art .ar-acts a').getAttribute('href')).includes('&pool='), `${vp.width}: העלאה למוזיאון עם pool`);
    if (SHOTS && vp.width === 1440) {
      fs.mkdirSync(SHOTS, { recursive: true });
      // כל מקורות המאגר: בודקים שאף כתבה לא גולשת
      const n = await p.locator('.ar-src').count(), over = [];
      for (let i = 0; i < n; i++) {
        await p.locator('.ar-src').nth(i).click();
        await p.waitForTimeout(250);
        await p.waitForFunction(() => document.querySelector('.ar-comp-art .ar-sheet')?.dataset.fit, null, { timeout: 15000 });
        const f = await p.locator('.ar-comp-art .ar-sheet').evaluate((s) => s.dataset.fit + (s.dataset.dropped ? '/' + s.dataset.dropped : ''));
        if (f.startsWith('over') || f.includes('/')) over.push(`${i}:${f}`);
      }
      console.log(`     מאגר: ${n} מקורות, חריגים: ${over.join(' ') || 'אין'}`);
      await p.keyboard.press('Escape');
    }
    ok(errs.length === 0, `${vp.width}: בלי שגיאות JS ${errs.join(' | ')}`);
    if (SHOTS) {
      await p.goto(BASE + PAGE, { waitUntil: 'load' });
      await p.waitForFunction(() => [...document.querySelectorAll('.ar-grid .ar-sheet')].every((s) => s.dataset.fit), null, { timeout: 30000 });
      await p.waitForTimeout(800);
      await p.screenshot({ path: `${SHOTS}/page-${vp.width}.png`, fullPage: true });
      if (vp.width === 1440) {
        const els = p.locator('.ar-grid .ar-sheet');
        for (let i = 0; i < (await els.count()); i++) await els.nth(i).screenshot({ path: `${SHOTS}/article-${String(i + 1).padStart(2, '0')}.png` });
      }
    }
    await ctx.close();
    await b.close();
  }
  console.log(fails ? `${fails} נכשלו` : 'הכול עבר');
  process.exit(fails ? 1 : 0);
})();
