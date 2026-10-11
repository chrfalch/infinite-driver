// Full-throttle pulls from a standstill on a few grounds; prints each wheel's slip so tyre-grip and
// drivetrain changes can be compared. Usage: node scripts/traction-check.mjs [port] ["<extra query>"]
// RUNS=0,2 picks runs by index; LOCKS=centre,rear,front locks those differentials first;
// HOLD=400 opens the throttle for 400 ms, then locks it there with Shift and lets the pedal go.
import { webkit } from 'playwright-core';
const port = process.argv[2] ?? '8731';
const extra = process.argv[3] ?? '';
const runs = [
  ['flat, high range', 'terrain=flat', false, 4000],
  ['flat, low range', 'terrain=flat', true, 4000],
  ['ramp 30°, low range', 'terrain=ramp&slope=30', true, 6000],
  ['canyon, low range', '', true, 6000],
  ['ramp 20°, low range', 'terrain=ramp&slope=20', true, 6000],
  ['ramp 25°, low range', 'terrain=ramp&slope=25', true, 6000],
];
const pick = process.env.RUNS?.split(',').map(Number);
const locks = process.env.LOCKS?.split(',') ?? [];
const b = await webkit.launch({ headless: true });
for (const [name, query, low, ms] of runs.filter((_, i) => !pick || pick.includes(i))) {
  const p = await b.newPage({ viewport: { width: 640, height: 400 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/?tires=gpu&physics=main&sound=0&${query}${extra}`);
  await p.waitForFunction(() => window.__game?.car, null, { timeout: 60000 });
  await p.waitForTimeout(3000);
  await p.evaluate((locks) => {
    const g = window.__game;
    const d = g.car.get(g.traits.Vehicle).drivetrain.params;
    d.centerLock = locks.includes('centre');
    d.rearLock = locks.includes('rear');
    d.frontLock = locks.includes('front');
  }, locks);
  if (low) {
    await p.keyboard.press('KeyL');
    await p.waitForTimeout(300);
  }
  const read = () =>
    p.evaluate(() => {
      const g = window.__game;
      const v = g.car.get(g.traits.Vehicle);
      const c = v.controller;
      const r = c.rollingRadius ? c.rollingRadius() : 0.43;
      const t = v.body.translation();
      return { speed: c.currentVehicleSpeed(), ground: [0, 1, 2, 3].map((i) => c.wheelSpin(i) * r), x: t.x, gear: v.drivetrain?.label };
    });
  const start = await read();
  await p.keyboard.down('ArrowUp');
  const hold = Number(process.env.HOLD ?? 0);
  if (hold) {
    await p.waitForTimeout(hold);
    await p.keyboard.press('ShiftLeft');
    await p.keyboard.up('ArrowUp');
  }
  const samples = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    samples.push(await read());
    await p.waitForTimeout(50);
  }
  await p.keyboard.up('ArrowUp');
  // Slip per wheel: tread speed past the ground speed (m/s), and the share of samples a wheel
  // spun more than 1 m/s past it.
  const slip = [0, 1, 2, 3].map((w) => samples.map((s) => s.ground[w] - s.speed));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const fmt = (a) => a.map((x) => x.toFixed(2).padStart(5)).join(' ');
  const last = samples[samples.length - 1];
  console.log(
    `${name.padEnd(22)} ${(last.speed * 3.6).toFixed(1).padStart(5)} km/h  moved ${(last.x - start.x).toFixed(1).padStart(5)} m  gear ${last.gear}` +
      `\n   mean slip m/s [FL FR RL RR] ${fmt(slip.map(mean))}   max ${fmt(slip.map((a) => Math.max(...a)))}` +
      `   spinning ${fmt(slip.map((a) => a.filter((x) => x > 1).length / a.length))}`,
  );
  if (errs.length) console.log('   errors', errs.slice(0, 3));
  await p.close();
}
await b.close();
