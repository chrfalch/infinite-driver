// AI drivers on the stadium: the player's car stands on the grid while the others race round.
// Prints each driver's laps, its distance along the course, how far it strayed across the lane,
// how often it backed off or was put back, and its best lap.
// [RIVALS=rigid,gpu,rigid] [SECONDS=60] node scripts/ai-check.mjs [port] [extra query]
import { webkit } from 'playwright-core';
const port = process.argv[2] ?? '8731';
const seconds = Number(process.env.SECONDS ?? 60);
const b = await webkit.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 300)));
const rivals = process.env.RIVALS ?? 'rigid,gpu,rigid';
await p.goto(`http://127.0.0.1:${port}/?terrain=stadium&sound=0&rivals=${rivals}${process.argv[3] ?? ''}`);
await p.waitForFunction((n) => window.__game?.cars?.length === n, rivals.split(',').length + 1, { timeout: 40000 });
// Watch every driver: its worst offset across the lane, its modes, its lap times.
await p.evaluate(() => {
  const g = window.__game;
  window.__ai = [];
  const t0 = performance.now();
  for (const car of g.cars) {
    const v = car.get(g.traits.Vehicle);
    if (!v.driver) continue;
    const w = { tires: v.tires, worst: 0, reverses: 0, respawns: 0, laps: [], lastLap: null, driver: v.driver };
    window.__ai.push(w);
    const update = v.driver.update.bind(v.driver);
    let mode = 'drive';
    let lap = 0;
    v.driver.update = (state, others, dt) => {
      const input = update(state, others, dt);
      const d = v.driver;
      w.worst = Math.max(w.worst, Math.abs(d.d));
      if (d.mode === 'reverse' && mode !== 'reverse') {
        w.reverses++;
        (w.where ??= []).push(`rev@${Math.round(d.s)}`);
      }
      if (d.respawn) {
        w.respawns++;
        (w.where ??= []).push(`resp@${Math.round(d.s)}`);
      }
      mode = d.mode;
      if (d.lap > lap) {
        const now = (performance.now() - t0) / 1000;
        if (w.lastLap !== null) w.laps.push(+(now - w.lastLap).toFixed(1));
        w.lastLap = now;
        lap = d.lap;
      }
      return input;
    };
  }
});
for (let t = 0; t < seconds; t += 15) {
  await p.waitForTimeout(Math.min(15, seconds - t) * 1000);
  const rows = await p.evaluate(() =>
    window.__ai.map((w) => ({ tires: w.tires, lap: w.driver.lap, m: Math.round(w.driver.progress), worstD: +w.worst.toFixed(1), rev: w.reverses, resp: w.respawns, laps: w.laps.join(' '), where: (w.where ?? []).join(' ') })),
  );
  console.log(`t=${Math.min(seconds, t + 15)}s`, JSON.stringify(rows));
}
console.log('errors', errs.length ? errs : 'none');
await b.close();
