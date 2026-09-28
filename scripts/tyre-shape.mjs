// Tyre shape check: how far the GPU tyres grow past their set radius, how many particles touch the
// ground, and how much the hub shakes, at rest and driving. Usage: node scripts/tyre-shape.mjs x27<localStorage json>x27
// e.g. x27{"drift.tire.v2":{"outerRadius":0.55,"width":0.6},"drift.gputire.v2":{"pressureKpa":165}}x27
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const store = JSON.parse(process.argv[2] ?? '{}');
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.addInitScript((s) => { localStorage.clear(); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); }, store);
await page.goto(`http://127.0.0.1:${process.env.PORT ?? 8731}/?terrain=flat`);
await page.waitForFunction(() => window.__game?.car, null, { timeout: 30000 });
await page.waitForTimeout(4000);
const probe = () => page.evaluate(async () => {
  const g = window.__game; const { TIRE } = await import('/src/tire/config.js');
  const out = [];
  for (let f = 0; f < 30; f++) {
    await new Promise((r) => requestAnimationFrame(r));
    const c = g.car.get(g.traits.Vehicle).controller; const s = c.gpu.solver; const h = s.readbackHubs[0].p;
    let max = 0, n = 0, low = 0, ymin = 1e9;
    for (let k = 0; k < s.perTire; k++) { const o = k * 4; const d = Math.hypot(s.positions[o] - h.x, s.positions[o+1] - h.y); max = Math.max(max, d); ymin = Math.min(ymin, s.positions[o+1]); }
    for (let k = 0; k < s.perTire; k++) if (s.positions[k*4+1] < ymin + 0.035) low++;
    out.push([max / TIRE.outerRadius, low, h.y - ymin]);
  }
  const m = (i) => out.reduce((a, x) => a + x[i], 0) / out.length;
  const sd = (i) => Math.sqrt(out.reduce((a, x) => a + (x[i] - m(i)) ** 2, 0) / out.length);
  return `maxR/outer ${m(0).toFixed(3)}  patch particles ${m(1).toFixed(1)} ±${sd(1).toFixed(1)}  hub height ${m(2).toFixed(3)} ±${(sd(2)*1000).toFixed(1)}mm`;
});
console.log('rest   ', await probe());
await page.keyboard.down('ArrowUp'); await page.waitForTimeout(3000);
console.log('driving', await probe());
await browser.close();
