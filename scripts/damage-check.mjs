// Crash scenarios with GPU tyres (drops at speed, rocks): which wheels come off or bend, then drive
// on and respawn. Usage: node scripts/damage-check.mjs "&physics=main" main
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const port = process.env.PORT ?? 8731;
const extra = process.argv[2] ?? '&physics=main';
const tag = process.argv[3] ?? 'main';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('403')) console.log('[console]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/?tires=gpu&sound=0&az=200&zoom=1.6${extra}`);
await page.waitForFunction(() => window.__game?.car, null, { timeout: 30000 });
await page.waitForTimeout(3000);
const read = () => page.evaluate(() => {
  const g = window.__game; const v = g.car.get(g.traits.Vehicle); const c = v.controller; const r = v.body.rotation();
  const lost = [0, 1, 2, 3].map((i) => (c.wheelDetached(i) ? 'X' : '-')).join('');
  const bend = c.wheels.map((w) => (w.bend ? `${(w.bend.camber * 100).toFixed(1)}/${(w.bend.toe * 100).toFixed(1)}` : '0')).join(' ');
  let nan = 0; for (const x of c.gpu.solver.positions) if (!Number.isFinite(x)) nan++;
  return `lost ${lost} bend(cm camber/toe) ${bend} kmh ${(c.currentVehicleSpeed() * 3.6).toFixed(0)} up ${(1 - 2 * (r.x * r.x + r.z * r.z)).toFixed(2)} nan ${nan}`;
});
const start = await page.evaluate(() => { const p = window.__game.car.get(window.__game.traits.Vehicle).body.translation(); return { x: p.x, z: p.z }; });
const big = await page.evaluate(({ x, z }) => {
  const g = window.__game; const out = [];
  g.world.query(g.traits.RockField).forEach((e) => { for (const r of e.get(g.traits.RockField).rocks) if (r.size > 0.9) out.push(r); });
  out.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
  return out.slice(0, 2).map((r) => ({ x: r.x, z: r.z, size: r.size }));
}, start);
const at = (x, z, yaw, o) => page.evaluate(([x, z, yaw, o]) => window.__game.respawnAt(x, z, yaw, o), [x, z, yaw, o]);
async function scenario(name, fn, ms, shot) {
  await fn();
  await page.waitForTimeout(ms);
  console.log(name.padEnd(26), await read());
  if (shot) await page.screenshot({ path: `scratch/damage-${tag}-${shot}.png` });
}
await scenario('settle', () => at(start.x, start.z, 0, {}), 2000);
await scenario('drop 2 m', () => at(start.x, start.z, 0, { lift: 2 }), 2500);
await scenario('drop 3 m at 15 m/s', () => at(start.x, start.z, 0, { lift: 3, speed: 15 }), 2500, 'drop15');
await scenario('drop 3 m at 25 m/s', () => at(start.x, start.z, 0, { lift: 3, speed: 25 }), 2500, 'drop25');
for (const r of big) await scenario(`rock ${r.size.toFixed(1)} m at 22 m/s`, () => at(r.x - 12, r.z + 0.8, 0, { speed: 22 }), 2500, `rock${r.size.toFixed(1)}`);
// Drive on with whatever is left.
await page.keyboard.down('ArrowUp'); await page.waitForTimeout(3000); await page.keyboard.up('ArrowUp');
console.log('drive on 3 s'.padEnd(26), await read());
await page.screenshot({ path: `scratch/damage-${tag}-driveon.png` });
await page.keyboard.press('KeyR'); await page.waitForTimeout(2000);
console.log('respawn (R)'.padEnd(26), await read());
await browser.close();
