// Checks worker physics features: gear keys, ruts shared with the worker, live settings,
// rebuild (keeps motion), respawn, and no errors.
import { webkit } from 'playwright-core';
const b = await webkit.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 300)));
await p.goto('http://127.0.0.1:8731/?tires=gpu&terrain=hills&rocks=0' + (process.argv[2] ?? ''));
await p.waitForFunction(() => window.__game?.car, null, { timeout: 30000 });
await p.waitForTimeout(2000);
const st = () => p.evaluate(() => { const g = window.__game; const v = g.car.get(g.traits.Vehicle); const t = v.body.translation(); const d = g.world.get(g.traits.Deformation).map;
  return { x: +t.x.toFixed(2), z: +t.z.toFixed(2), kmh: +(v.speed * 3.6).toFixed(1), gear: v.drivetrain.gear, rpm: Math.round(v.drivetrain.rpm), auto: v.drivetrain.params.automatic, tiles: d.tiles.size, version: d.version, remote: !!g.world.get(g.traits.Physics).remote }; });
const log = (label, s) => console.log(label.padEnd(26), JSON.stringify(s));
log('start', await st());
await p.keyboard.down('ArrowUp'); await p.waitForTimeout(4000);
log('after 4 s throttle', await st());
await p.keyboard.press('KeyQ'); await p.waitForTimeout(600);
log('after Q (shift down)', await st());
// Live setting: tyre pressure (GPU param) and brake force; saved like the panel does.
await p.evaluate(async () => { const m = await import('/src/tire/config.js'); m.GPU_TIRE.pressureKpa = 120; m.saveGpuTire(); });
await p.waitForTimeout(500);
// Rebuild keeps the motion.
const before = await st();
await p.evaluate(async () => { const m = await import('/src/vehicle/spawn.js'); m.requestRebuild(window.__game.world); });
await p.waitForTimeout(800);
log('before rebuild', before);
log('after rebuild', await st());
await p.keyboard.up('ArrowUp');
await p.evaluate(async () => { const m = await import('/src/tire/config.js'); m.resetGpuTire(); const c = await import('/src/vehicle/config.js'); c.DRIVETRAIN.automatic = true; c.saveDrivetrain(); });
// Respawn somewhere else.
await p.evaluate(() => window.__game.respawnAt(200, 150, 1));
await p.waitForTimeout(2500);
log('after respawnAt(200,150)', await st());
console.log('errors', errs.length ? errs : 'none');
await b.close();
