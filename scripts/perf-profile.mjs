// Drives the car along a fixed input script and prints the profiler summary.
// Usage: node scripts/perf-profile.mjs [cpuThrottle=1] [label] [extraQuery]
import { chromium, webkit } from 'playwright-core';
const ENGINE = process.env.ENGINE ?? 'chromium';

const throttle = Number(process.argv[2] ?? 1);
const label = process.argv[3] ?? `cpu x${throttle}`;
const extra = process.argv[4] ?? '';
const gpuTire = process.argv[5] ?? '{}';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = ENGINE === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });
await page.addInitScript((v) => localStorage.setItem('drift.gputire.v2', v), gpuTire);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:8731/?perf&tires=gpu${extra}`);
await page.waitForFunction(() => window.__game?.car && window.__perf, null, { timeout: 30000 });
await page.waitForTimeout(3000);
if (throttle > 1 && ENGINE !== 'webkit') (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });

// Bare GPU round trip: empty submit + map of a 16-byte buffer.
const rtt = await page.evaluate(async () => {
  const device = window.__game.render.renderer.backend.device;
  if (!device) return null;
  const buf = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const src = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC });
  const t = [];
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, buf, 0, 16);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    buf.unmap();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return { p50: t[30], p95: t[57] };
});

await page.evaluate(() => window.__perf.reset());
const drive = [
  [['ArrowUp'], 6000],
  [['ArrowUp', 'ArrowRight'], 1500],
  [['ArrowUp'], 2500],
  [['ArrowUp', 'ArrowLeft'], 1500],
  [['ArrowUp'], 2500],
];
const speeds = [];
for (const [keys, ms] of drive) {
  for (const k of keys) await page.keyboard.down(k);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.waitForTimeout(500);
    speeds.push(await page.evaluate(() => window.__game.car.get(window.__game.traits.Vehicle).speed * 3.6));
  }
  for (const k of keys) await page.keyboard.up(k);
}
const res = await page.evaluate(() => ({
  ...window.__perf.summary(),
  backend: window.__game.render.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2',
  pixels: [window.__game.render.renderer.domElement.width, window.__game.render.renderer.domElement.height],
}));
res.frameInfo = await page.evaluate(() => new Promise((resolve) => {
  const info = window.__game.render.renderer.info.render;
  const c0 = info.calls, t0 = info.triangles, f0 = info.frameCalls ?? 0;
  requestAnimationFrame(() => requestAnimationFrame(() => resolve({ calls: info.calls - c0, tris: info.triangles - t0, auto: window.__game.render.renderer.info.autoReset })));
}));
res.calls = res.frameInfo.calls; res.triangles = res.frameInfo.tris;
await browser.close();

console.log(`\n=== [${ENGINE}] ${label}  (${res.backend}, canvas ${res.pixels.join('x')}, ${res.calls} draw calls, ${res.triangles} tris)`);
console.log(`GPU round trip (empty): p50 ${rtt?.p50.toFixed(2)} ms  p95 ${rtt?.p95.toFixed(2)} ms`);
console.log(`speeds ${speeds.map((s) => s.toFixed(0)).join(" ")}`);
const c = res.counters;
console.log(`sim/real ${(c.simSeconds / c.wallSeconds).toFixed(2)}  dropped ${c.droppedSeconds.toFixed(2)} s of ${c.wallSeconds.toFixed(1)} s  steps ${c.steps}`);
console.log('name'.padEnd(22), 'avg'.padStart(7), 'p50'.padStart(7), 'p95'.padStart(7), 'max'.padStart(7));
for (const k of Object.keys(res.series).sort()) {
  const s = res.series[k];
  console.log(k.padEnd(22), ...[s.avg, s.p50, s.p95, s.max].map((v) => v.toFixed(2).padStart(7)));
}
