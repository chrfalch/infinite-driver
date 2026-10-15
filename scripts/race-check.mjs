import { webkit } from 'playwright-core';
// Countdown and pause on the stadium: the cars hold through 3-2-1, go on 'GO!', and stand still while paused.
// node scripts/race-check.mjs [port] [extra query]
const port = process.argv[2] ?? '8731';
const b = await webkit.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 300)));
await p.goto(`http://127.0.0.1:${port}/?terrain=stadium&sound=0${process.argv[3] ?? ''}`);
await p.waitForFunction(() => window.__game?.race, null, { timeout: 60000 });
const snap = () => p.evaluate(() => {
  const g = window.__game;
  return { phase: g.race.phase, label: g.race.label(), paused: g.race.paused, sim: +g.world.get(g.traits.Physics).simTime.toFixed(2),
    cars: g.cars.map((c) => { const t = c.get(g.traits.Vehicle).body.translation(); return [+t.x.toFixed(2), +t.z.toFixed(2)]; }) };
});
const log = [];
let s = await snap();
console.log('cars', s.cars.length, 'phase', s.phase);
await p.waitForFunction(() => window.__game.race.phase !== 'waiting', null, { timeout: 60000 });
const t0 = Date.now();
const labels = [];
let start = null;
while (Date.now() - t0 < 5000) {
  s = await snap();
  if (s.label !== labels.at(-1)) labels.push(s.label);
  if (s.label === '3' && !start) start = s;
  if (s.label === '1') log.push(['at 1', s.cars]);
  await p.waitForTimeout(100);
}
console.log('labels', labels.join(' '));
console.log('grid at 3', JSON.stringify(start?.cars));
console.log('grid at 1', JSON.stringify(log.at(-1)?.[1]));
await p.waitForTimeout(3000);
const before = await snap();
console.log('3 s after GO', JSON.stringify(before.cars), 'sim', before.sim);
await p.evaluate(() => window.__game.pause(true));
await p.waitForTimeout(500);
const p1 = await snap();
await p.waitForTimeout(2000);
const p2 = await snap();
console.log('paused sim', p1.sim, '->', p2.sim, 'cars same', JSON.stringify(p1.cars) === JSON.stringify(p2.cars));
await p.keyboard.press('Escape');
await p.waitForTimeout(1500);
const r = await snap();
console.log('resumed paused', r.paused, 'sim', r.sim, 'cars', JSON.stringify(r.cars));
console.log('errors', errs.length ? errs : 'none');
await b.close();
