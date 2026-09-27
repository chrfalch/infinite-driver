import { chromium, webkit } from 'playwright-core';
const ENGINE = process.env.ENGINE ?? 'webkit';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = ENGINE === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-unsafe-webgpu'] });
const p = await b.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });
await p.goto('http://127.0.0.1:8731/?perf&tires=gpu'); await p.waitForFunction(() => window.__game?.car, null, {timeout: 30000}); await p.waitForTimeout(3000);
const r = await p.evaluate(async () => {
  const g = window.__game; const ctl = g.car.get(g.traits.Vehicle).controller; const solver = ctl.gpu.solver;
  const device = g.render.renderer.backend.device;
  const stat = (t) => { t.sort((a, b) => a - b); return `p50 ${t[t.length >> 1].toFixed(2)}  p95 ${t[Math.floor(t.length * 0.95)].toFixed(2)}`; };
  const bench = async (label, fn, n = 120) => { const t = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(); t.push(performance.now() - t0); } return `${label.padEnd(44)} ${stat(t)}`; };
  const buf = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const src = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC });
  const empty = async () => { const e = device.createCommandEncoder(); e.copyBufferToBuffer(src, 0, buf, 0, 16); device.queue.submit([e.finish()]); await buf.mapAsync(GPUMapMode.READ); buf.unmap(); };
  const done = () => device.queue.onSubmittedWorkDone();
  const hubs = ctl.hubStates();
  const out = [];
  const R = g.render;
  // Render only (no physics), so the solver's staging buffers are ours.
  R.renderer.setAnimationLoop(() => { R.renderer.clear(); R.renderer.render(R.scene, R.activeCamera); R.renderer.clearDepth(); R.renderer.render(R.hudScene, R.hudCamera); });
  await new Promise((r) => setTimeout(r, 500));
  // while the game renders
  out.push(await bench('rendering on: empty copy+map', empty));
  out.push(await bench('rendering on: solver.step', () => solver.step(hubs)));
  g.render.renderer.setAnimationLoop(null);
  await new Promise((r) => setTimeout(r, 300));
  out.push(await bench('rendering off: empty copy+map', empty));
  out.push(await bench('rendering off: onSubmittedWorkDone', done));
  out.push(await bench('rendering off: solver.step', () => solver.step(hubs)));
  out.push(await bench('rendering off: solver.step + positions', () => solver.step(hubs, { readPositions: true })));
  const base = solver.settings;
  for (const [sub, it] of [[4, 8], [1, 1], [8, 8], [4, 16]]) {
    solver.setParams({ ...base, substeps: sub, iterations: it }, solver.dt);
    out.push(await bench(`rendering off: solver.step ${sub} sub x ${it} it`, () => solver.step(hubs)));
  }
  solver.setParams(base, solver.dt);
  return out.join('\n');
});
console.log(`[${ENGINE}]\n` + r);
await b.close();
