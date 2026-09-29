// Checks the engine sound in the game: it starts on the first click, reads the physics steps from
// the shared audio feed, makes sound, and gets louder under throttle. M mutes it.
//   node scripts/audio-check.mjs [webkit|chromium] [base url] [extra query]
import { chromium, webkit } from 'playwright-core';
const engine = process.argv[2] ?? 'webkit';
const base = process.argv[3] ?? 'http://127.0.0.1:8731';
const b = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: engine === 'chromium' ? ['--enable-unsafe-webgpu', '--autoplay-policy=user-gesture-required'] : [] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(`${m.type()}: ${m.text().slice(0, 300)}`));
await p.goto(`${base}/?terrain=flat${process.argv[4] ?? ''}`);
await p.waitForFunction(() => window.__game?.car, null, { timeout: 60000 });
const before = await p.evaluate(() => ({ isolated: crossOriginIsolated, shared: window.__game.audioFeed.shared, state: window.__game.audio?.state }));
console.log('before gesture', JSON.stringify(before));
await p.mouse.click(640, 400);
await p.waitForFunction(() => window.__game.audio.state === 'running' || window.__game.audio.state === 'failed', null, { timeout: 10000 });

// Measure the output level through an analyser on the engine node.
await p.evaluate(() => {
  const a = window.__game.audio;
  const analyser = a.ctx.createAnalyser();
  analyser.fftSize = 8192;
  a.node.connect(analyser);
  window.__level = () => {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let s = 0;
    for (const x of buf) s += x * x;
    return Math.sqrt(s / buf.length);
  };
});
const st = () =>
  p.evaluate(() => {
    const g = window.__game;
    const d = g.car.get(g.traits.Vehicle).drivetrain;
    return { ctx: g.audio.ctx.state, manual: g.audio.manual, feed: g.audioFeed.written(), rpm: Math.round(d.rpm), fuel: +(d.fuel ?? 0).toFixed(2), rms: +window.__level().toFixed(3) };
  });
const statuses = [];
await p.evaluate(() => window.__game.audio.node.port.addEventListener('message', (e) => (window.__status = e.data)));
await p.waitForTimeout(2500);
const idle = await st();
console.log('idle', JSON.stringify(idle), 'worklet status', JSON.stringify(await p.evaluate(() => window.__status)));
await p.keyboard.down('ArrowUp');
await p.waitForTimeout(3000);
const pulling = await st();
console.log('throttle', JSON.stringify(pulling), 'worklet status', JSON.stringify(await p.evaluate(() => window.__status)));
await p.keyboard.up('ArrowUp');
await p.waitForTimeout(1500);
console.log('lift off', JSON.stringify(await st()));
await p.keyboard.press('KeyM');
await p.waitForTimeout(1200);
console.log('after M', JSON.stringify(await st()), 'enabled', await p.evaluate(async () => (await import('/src/audio/config.js')).AUDIO.enabled));
await p.keyboard.press('KeyM');
await p.waitForTimeout(800);
console.log('after M again', JSON.stringify(await st()));
console.log('errors', errs.length ? errs : 'none');
await b.close();
