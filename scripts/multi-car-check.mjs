// Checks several cars at once, each on its own tyre model: the player's on GPU tyres with a rigid-
// wheeled and a GPU-tyred car behind it (?rivals=rigid,gpu). The others drive from their Vehicle's
// `input`; rebuilds and respawns keep every car; no errors.
// [CARS=rigid,gpu,soft] node scripts/multi-car-check.mjs [port] [extra query, e.g. &physics=main]
import { webkit } from 'playwright-core';
const port = process.argv[2] ?? '8731';
const b = await webkit.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 300) + ' @ ' + (m.location()?.url ?? '')));
// CARS: the player's tyre model and the others' (default gpu, with rigid and gpu behind).
const [player, ...others] = (process.env.CARS ?? 'gpu,rigid,gpu').split(',');
await p.goto(`http://127.0.0.1:${port}/?tires=${player}&terrain=hills&rocks=0&rivals=${others.join(',')}${process.argv[3] ?? ''}`);
await p.waitForFunction((n) => window.__game?.cars?.length === n, others.length + 1, { timeout: 30000 });
await p.waitForTimeout(2500);
const st = () =>
  p.evaluate(() => {
    const g = window.__game;
    const { Vehicle, Physics } = g.traits;
    return {
      remote: !!g.world.get(Physics).remote,
      cars: g.cars.map((car) => {
        const v = car.get(Vehicle);
        const t = v.body.translation();
        return { id: v.id, tires: v.tires, slot: v.slot, player: car === g.car, x: +t.x.toFixed(2), y: +t.y.toFixed(2), z: +t.z.toFixed(2), kmh: +(v.speed * 3.6).toFixed(1), gear: v.drivetrain.gear, solver: !!v.controller.gpu, contacts: (v.groundContacts ?? []).filter(Boolean).length };
      }),
    };
  });
const log = (label, s) => console.log(label.padEnd(24), JSON.stringify(s));
log('start', await st());
// Drive the two others straight on at half throttle; the player at full.
await p.evaluate(() => {
  const g = window.__game;
  for (const car of g.cars) if (car !== g.car) car.get(g.traits.Vehicle).input = { throttle: 0.5, brake: 0, steer: 0, handbrake: false };
});
await p.keyboard.down('ArrowUp');
await p.waitForTimeout(4000);
log('after 4 s driving', await st());
// Rebuild keeps every car and its motion.
const rebuiltIn = await p.evaluate(async () => {
  const g = window.__game;
  // (Entity ids come round again on the main thread: compare the bodies.)
  const before = g.cars.map((c) => c.get(g.traits.Vehicle).body);
  g.rebuild();
  // How long until every rebuilt car has its first state from the physics.
  const t0 = performance.now();
  while (performance.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 20));
    const cars = g.cars.map((c) => c.get(g.traits.Vehicle));
    if (cars.every((v) => !before.includes(v.body) && (v.controller.state || !g.world.get(g.traits.Physics).remote))) return Math.round(performance.now() - t0);
  }
  return null;
});
log('rebuilt, first state (ms)', rebuiltIn);
log('after rebuild', await st());
await p.keyboard.up('ArrowUp');
// Respawn the rigid car somewhere else; the player stays.
await p.evaluate(() => {
  const g = window.__game;
  const rigid = g.cars.find((c) => c.get(g.traits.Vehicle).tires === 'rigid');
  g.respawnAt(40, 30, 0, { car: rigid });
});
await p.waitForTimeout(1500);
log('after rigid respawn', await st());
// A car added later, then taken out again.
const added = await p.evaluate(async () => {
  const g = window.__game;
  const car = g.addCar({ x: 20, z: 8, tires: 'rigid', livery: 'white' });
  await new Promise((r) => setTimeout(r, 1500));
  const t = car.get(g.traits.Vehicle).body.translation();
  const n = g.cars.length;
  g.removeCar(car);
  await new Promise((r) => setTimeout(r, 300));
  return { n, y: +t.y.toFixed(2), ground: +g.heightAt(t.x, t.z).toFixed(2), after: g.cars.length };
});
log('added + removed', added);
await p.waitForTimeout(800);
log('end', await st());
console.log('errors', errs.length ? errs : 'none');
await b.close();
