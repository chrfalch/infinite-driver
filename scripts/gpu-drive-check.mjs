import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:8731/?zoom=1.6&tires=gpu'); await page.waitForTimeout(5000);
const st = () => page.evaluate(() => { const g = window.__game; const v = g.car.get(g.traits.Vehicle); const p = v.body.translation(); const r = v.body.rotation(); const s = v.controller.gpu.solver; let nan = 0; for (const x of s.positions) if (!Number.isFinite(x)) nan++; return `pos ${p.x.toFixed(0)},${p.y.toFixed(2)},${p.z.toFixed(0)} ${(v.controller.currentVehicleSpeed() * 3.6).toFixed(0)} km/h up ${(1 - 2 * (r.x * r.x + r.z * r.z)).toFixed(2)} rocks ${s.rockCount} nan ${nan} ms ${g.world.get(g.traits.Physics).stepMs.toFixed(2)}`; });
const keys = [['ArrowUp', 'ArrowRight'], ['ArrowUp'], ['ArrowUp', 'ArrowLeft'], ['ArrowUp'], ['ArrowDown'], ['ArrowUp', 'ArrowRight'], ['ArrowUp']];
for (let k = 0; k < 14; k++) {
  const ks = keys[k % keys.length];
  for (const key of ks) await page.keyboard.down(key);
  await page.waitForTimeout(1200);
  for (const key of ks) await page.keyboard.up(key);
  console.log(ks.join('+').padEnd(20), await st());
}
await page.screenshot({ path: 'scratch/gpu-long.png' });
await browser.close();
