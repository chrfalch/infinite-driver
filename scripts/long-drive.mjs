// Long canyon drive with steering and respawns; reports frame errors and long frames.
import { webkit } from 'playwright-core';
const b = await webkit.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 300)));
await p.goto('http://127.0.0.1:8731/?perf&tires=gpu' + (process.argv[2] ?? ''));
await p.waitForFunction(() => window.__game?.car && window.__perf, null, { timeout: 30000 });
await p.waitForTimeout(3000);
await p.evaluate(() => window.__perf.reset());
const seq = [['ArrowUp'], ['ArrowUp', 'ArrowLeft'], ['ArrowUp'], ['ArrowUp', 'ArrowRight'], ['ArrowDown'], ['ArrowUp']];
for (let k = 0; k < 24; k++) {
  const keys = seq[k % seq.length];
  for (const key of keys) await p.keyboard.down(key);
  await p.waitForTimeout(1500);
  for (const key of keys) await p.keyboard.up(key);
  if (k % 6 === 5) await p.keyboard.press('KeyR'); // respawn now and then
}
const r = await p.evaluate(() => window.__perf.summary());
const f = r.series['frame.interval'];
console.log(`frames ${f.n}  interval avg ${f.avg.toFixed(1)} p95 ${f.p95.toFixed(1)} max ${f.max.toFixed(1)}  long ${r.counters.longFrames ?? 0}  frameErrors ${r.counters.frameErrors ?? 0}  draw max ${r.series.draw.max.toFixed(1)}`);
console.log('errors', errs.length ? errs.slice(0, 5) : 'none');
await b.close();
