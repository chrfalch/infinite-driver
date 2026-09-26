import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const url = process.argv[2] ?? 'http://127.0.0.1:8731/';
const out = process.argv[3] ?? 'screenshot.png';
const drive = process.argv[4] ?? '';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('[console]', m.type(), m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(6000);
for (const step of drive.split(',').filter(Boolean)) {
  const [key, ms] = step.split(':');
  await page.keyboard.down(key); await page.waitForTimeout(Number(ms)); await page.keyboard.up(key);
}
const info = await page.evaluate(() => {
  const g = window.__game; if (!g) return 'no game';
  const b = g.car.get(g.traits.Vehicle).body; const p = b.translation(); const v = b.linvel();
  return { pos: [p.x, p.y, p.z].map((n) => n.toFixed(1)), speedKmh: (Math.hypot(v.x, v.z) * 3.6).toFixed(1) };
});
console.log(JSON.stringify(info));
await page.screenshot({ path: out });
await browser.close();
