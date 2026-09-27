// Scripted drive with braking, steering, handbrake, and standing still; prints summary numbers
// to compare physics settings. Usage: node scripts/stability.mjs "<extra query>"
import { webkit } from 'playwright-core';
const extra = process.argv[2] ?? '';
const b = await webkit.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(`http://127.0.0.1:8731/?tires=gpu${extra}`);
await p.waitForFunction(() => window.__game?.car, null, { timeout: 30000 });
await p.waitForTimeout(3000);
const read = () => p.evaluate(() => {
  const g = window.__game; const v = g.car.get(g.traits.Vehicle); const c = v.controller;
  const l = v.body.linvel(); const w = v.body.angvel(); const t = v.body.translation(); const r = v.body.rotation();
  let nan = 0; for (const x of c.gpu.solver.positions) if (!Number.isFinite(x)) nan++;
  return { speed: Math.hypot(l.x, l.z) * 3.6, vy: l.y, yawRate: w.y, roll: w.x, pitch: w.z, y: t.y, up: 1 - 2 * (r.x * r.x + r.z * r.z),
    spins: [0, 1, 2, 3].map((i) => c.wheelSpin(i)), nan };
});
const phases = [
  ['idle', [], 3000], ['throttle', ['ArrowUp'], 4000], ['brake', ['ArrowDown'], 1500], ['throttle+left', ['ArrowUp', 'ArrowLeft'], 3000],
  ['handbrake+right', ['Space', 'ArrowRight'], 1500], ['coast', [], 2000], ['reverse', ['ArrowDown'], 2500], ['stop', ['Space'], 3000],
];
const out = [];
for (const [name, keys, ms] of phases) {
  for (const k of keys) await p.keyboard.down(k);
  const samples = []; const end = Date.now() + ms;
  while (Date.now() < end) { samples.push(await read()); await p.waitForTimeout(50); }
  for (const k of keys) await p.keyboard.up(k);
  const s = samples.slice(Math.floor(samples.length / 3));
  const mean = (f) => s.reduce((a, x) => a + f(x), 0) / s.length;
  const std = (f) => { const m = mean(f); return Math.sqrt(mean((x) => (f(x) - m) ** 2)); };
  // Spin wobble: mean absolute change of each wheel's spin between samples, minus the trend.
  let wob = 0; for (let i = 1; i < s.length - 1; i++) for (let w = 0; w < 4; w++) wob += Math.abs(s[i + 1].spins[w] - 2 * s[i].spins[w] + s[i - 1].spins[w]);
  wob /= Math.max(1, (s.length - 2) * 4);
  out.push(`${name.padEnd(16)} speed ${mean((x) => x.speed).toFixed(1).padStart(5)} km/h  vy std ${std((x) => x.vy).toFixed(3)}  pitch/roll std ${std((x) => x.pitch).toFixed(3)}/${std((x) => x.roll).toFixed(3)}  spin wobble ${wob.toFixed(2)}  up ${Math.min(...s.map((x) => x.up)).toFixed(2)}  nan ${Math.max(...s.map((x) => x.nan))}`);
}
console.log(`--- ${extra}`); console.log(out.join('\n')); if (errs.length) console.log('errors', errs);
await b.close();
