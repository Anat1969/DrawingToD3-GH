// Render public/icons/icon.svg to PNG sizes Chrome needs for install.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '../public/icons/icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [size, pad, name] of [[192, 0, 'icon-192.png'], [512, 0, 'icon-512.png'], [512, 0.12, 'icon-512-maskable.png']]) {
    await page.setViewportSize({ width: size, height: size });
    const inner = Math.round(size * (1 - pad * 2));
    await page.setContent(`<body style="margin:0;background:#0c0b09;display:grid;place-items:center;height:${size}px"><div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body>`);
    await page.screenshot({ path: path.join(__dirname, '../public/icons', name) });
  }
  await browser.close();
})();
