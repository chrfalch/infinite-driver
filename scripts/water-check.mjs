// Drives the car into the water and takes pictures of the waves and spray.
// Usage: node scripts/water-check.mjs [terrain=daytown|stadium] [outPrefix] [port]
import { chromium } from 'playwright-core';
const terrain = process.argv[2] ?? 'daytown';
const out = process.argv[3] ?? `/tmp/water-${terrain}`;
const port = process.argv[4] ?? 8731;
const extra = process.argv[5] ?? '';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/?perf&terrain=${terrain}&time=13${extra}`);
await page.waitForFunction(() => window.__game?.car && window.__perf, null, { timeout: 60000 });
await page.waitForTimeout(2000);
// Shallow water (0.3-0.5 m), facing along a run of wadeable water, the car a few metres back on
// the dry bank where there is one.
const spot = await page.evaluate((run) => {
  const g = window.__game;
  const { heightAt } = g;
  const level = heightAt.waterLevel;
  const depth = (x, z) => level - heightAt(x, z);
  const p = g.car.get(g.traits.Vehicle).body.translation();
  for (let r = 4; r < 500; r += 2) {
    for (let a = 0; a < Math.PI * 2; a += 0.04) {
      const x = p.x + Math.cos(a) * r;
      const z = p.z + Math.sin(a) * r;
      const d = depth(x, z);
      if (d < 0.15 || d > 0.6) continue;
      for (let b = 0; b < Math.PI * 2; b += 0.2) {
        const ux = Math.cos(b), uz = Math.sin(b);
        let ok = true;
        for (let s = 1; s <= run && ok; s++) { const e = depth(x + ux * s, z + uz * s); ok = e > 0.1 && e < 1.0; }
        if (!ok) continue;
        // Back up onto the bank (at most 8 m) if the ground behind rises gently.
        let sx = x, sz = z;
        for (let s = 1; s <= 14; s++) {
          const h0 = heightAt(x - ux * (s - 1), z - uz * (s - 1)), h1 = heightAt(x - ux * s, z - uz * s);
          if (Math.abs(h1 - h0) > 0.35) break;
          sx = x - ux * s; sz = z - uz * s;
        }
        return { start: { x: sx, z: sz }, yaw: Math.atan2(-uz, ux), depth: d };
      }
    }
  }
  return null;
}, terrain === 'stadium' ? 4 : 18);
console.log('spot', JSON.stringify(spot));
await page.evaluate(({ start, yaw }) => window.__game.respawnAt(start.x, start.z, yaw), spot);
await page.waitForTimeout(2500);
await page.evaluate(() => window.__perf.reset());
await page.keyboard.down('KeyW');
for (let k = 0; k < 6; k++) {
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => {
    const g = window.__game;
    const b = g.car.get(g.traits.Vehicle).body; const p = b.translation(); const v = b.linvel();
    return { pos: [p.x, p.y, p.z].map((n) => +n.toFixed(1)), kmh: +(Math.hypot(v.x, v.z) * 3.6).toFixed(1), drops: g.waterSpray?.drops.count, mist: g.waterSpray?.mist.count, active: g.water?.waves?.active, sub: g.car.get(g.traits.Vehicle).water?.sub?.map((s) => +s.toFixed(2)) };
  });
  console.log(k, JSON.stringify(info));
  await page.screenshot({ path: `${out}-${k}.png` });
}
await page.keyboard.up('KeyW');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}-after.png` });
const s = await page.evaluate(() => window.__perf.summary());
console.log('sys.water', JSON.stringify(s['sys.water'] ?? s), 'frame', JSON.stringify(s['frame.js']));
await browser.close();
