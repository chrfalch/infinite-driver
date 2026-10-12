// Stopping distances in the canyon: the car is put down moving at SPEED km/h on the road and on the
// soil beside it, then the brake (and the handbrake) are held until it stops. Also a coast-down
// and a full-throttle pull on both, so road and off-road grip and drag can be compared.
// Usage: node scripts/brake-check.mjs [port] ["<extra query>"]; SPEED=60 RUNS=0,1 pick runs.
// TIRE='{"width":0.45}' and GPUTIRE='{"pressureKpa":100}' change the tyre (saved settings).
import { webkit } from 'playwright-core';
const port = process.argv[2] ?? '8731';
const extra = process.argv[3] ?? '';
const speed = Number(process.env.SPEED ?? 60) / 3.6;
// Where: offset (m) sideways from the road's centre line, on the straightest stretch near the origin.
const places = { road: 0, soil: 6.5 };
// 'flat' is the flat test world: loose soil everywhere, no slopes to slide down.
const runs = [
  ['road, brake + handbrake', 'road', ['ArrowDown', 'Space']],
  ['soil, brake + handbrake', 'soil', ['ArrowDown', 'Space']],
  ['road, brake', 'road', ['ArrowDown']],
  ['soil, brake', 'soil', ['ArrowDown']],
  ['road, coast', 'road', []],
  ['soil, coast', 'soil', []],
  ['flat soil, brake', 'flat', ['ArrowDown']],
  ['flat soil, coast', 'flat', []],
];
const pick = process.env.RUNS?.split(',').map(Number);
const b = await webkit.launch({ headless: true });
for (const [name, place, keys] of runs.filter((_, i) => !pick || pick.includes(i))) {
  const p = await b.newPage({ viewport: { width: 480, height: 300 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(
    ({ tire, gpu }) => {
      if (tire) localStorage.setItem('drift.tire.v2', tire);
      if (gpu) localStorage.setItem('drift.gputire.v2', gpu);
    },
    { tire: process.env.TIRE, gpu: process.env.GPUTIRE },
  );
  const terrain = place === 'flat' ? 'flat' : 'canyon';
  await p.goto(`http://127.0.0.1:${port}/?tires=gpu&physics=main&sound=0&terrain=${terrain}${extra}`);
  await p.waitForFunction(() => window.__game?.car, null, { timeout: 60000 });
  await p.waitForTimeout(2000);
  // Find a straight, level stretch: walk along the road from the origin.
  const start = await p.evaluate(
    ({ side, speed }) => {
      const h = window.__game.heightAt;
      if (!h.roadHeading) {
        window.__game.respawnAt(0, 0, 0, { speed });
        return { x: 0, z: 0, yaw: 0, road: 0 };
      }
      // Walk along the road from the origin to the start of the straightest, flattest 80 m.
      const step = (x, z, d) => {
        const a = h.roadHeading(x, z);
        return [x + Math.cos(a) * d, z - Math.sin(a) * d, a];
      };
      let best = null;
      let px = 0;
      let pz = 0;
      for (let i = 0; i < 150; i++) {
        let [x, z, a0] = step(px, pz, 0);
        let bend = 0;
        let a = a0;
        const h0 = h(x, z);
        let climb = 0;
        for (let k = 0; k < 40; k++) {
          [x, z, a] = step(x, z, 2);
          bend = Math.max(bend, Math.abs(Math.atan2(Math.sin(a - a0), Math.cos(a - a0))));
          climb = Math.max(climb, Math.abs(h(x, z) - h0));
        }
        const score = bend + climb * 0.05;
        if (!best || score < best.score) best = { score, x: px, z: pz, yaw: h.roadHeading(px, pz) };
        [px, pz] = step(px, pz, 10);
      }
      const yaw = best.yaw;
      let x = best.x;
      let z = best.z;
      // Sideways (right of travel): (sin yaw, cos yaw) in x, z for heading (cos yaw, -sin yaw).
      x += Math.sin(yaw) * side;
      z += Math.cos(yaw) * side;
      window.__game.respawnAt(x, z, yaw, { speed });
      return { x, z, yaw, road: h.sample(x, z).road };
    },
    { side: places[place] ?? 0, speed },
  );
  await p.waitForTimeout(400);
  for (const k of keys) await p.keyboard.down(k);
  const read = () =>
    p.evaluate(() => {
      const g = window.__game;
      const v = g.car.get(g.traits.Vehicle);
      const t = v.body.translation();
      const l = v.body.linvel();
      return { x: t.x, z: t.z, v: Math.hypot(l.x, l.z), road: g.heightAt.sample?.(t.x, t.z).road ?? 0, t: performance.now() };
    });
  const first = await read();
  let last = first;
  const t0 = Date.now();
  let minRoad = 1;
  let maxRoad = 0;
  // Coasting is timed over 3 s (it would roll off the straight before it stopped).
  const limit = keys.length ? 15000 : 3000;
  while (Date.now() - t0 < limit) {
    last = await read();
    minRoad = Math.min(minRoad, last.road);
    maxRoad = Math.max(maxRoad, last.road);
    if (last.v < 0.3) break;
    await p.waitForTimeout(30);
  }
  for (const k of keys) await p.keyboard.up(k);
  const dist = Math.hypot(last.x - first.x, last.z - first.z);
  const secs = (last.t - first.t) / 1000;
  const v0 = first.v;
  const mean = dist > 0 ? (v0 * v0 - last.v * last.v) / (2 * dist) / 9.81 : 0;
  console.log(
    `${name.padEnd(26)} from ${(v0 * 3.6).toFixed(0).padStart(3)} km/h to ${(last.v * 3.6).toFixed(0).padStart(3)}: ${dist.toFixed(1).padStart(6)} m in ${secs.toFixed(1).padStart(4)} s` +
      `  (mean ${mean.toFixed(2)} g)  road share ${minRoad.toFixed(2)}..${maxRoad.toFixed(2)}`,
  );
  if (errs.length) console.log('   errors', errs.slice(0, 3));
  await p.close();
}
await b.close();
