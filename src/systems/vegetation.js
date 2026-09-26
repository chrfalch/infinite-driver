import { IsPlayer, RockField, Soil, Time, Vehicle } from '../ecs/traits.js';

// Bushes the car drives over bend away and go flat, and a few leaves fly off. Like the tyre
// tracks, a run-over bush stays flattened: it only springs back part of the way (to CRUSHED of the
// flattening), so a trail of flattened scrub marks where the car went. Checks the wheels and the car's belly against the bushes of nearby chunks.
const PRESS = 0.08; // s to flatten
const RECOVER = 2.5; // s to spring back part of the way
const CRUSHED = 0.7; // share of the flattening that stays
const REACH = 16; // m around the car to check
const leaf = { r: 0.36, g: 0.5, b: 0.2 };

export function updateBushes(world) {
  const car = world.queryFirst(IsPlayer, Vehicle);
  if (!car) return;
  const { body, controller } = car.get(Vehicle);
  const dt = world.get(Time).delta;
  const c = body.translation();
  const v = body.linvel();
  const q = body.rotation();
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  const fl = Math.hypot(fx, fz) || 1;
  const speed = Math.hypot(v.x, v.z);
  // Push direction: along the car's travel (or its nose when slow).
  const px = speed > 0.3 ? v.x / speed : fx / fl;
  const pz = speed > 0.3 ? v.z / speed : fz / fl;
  const wheels = controller.wheels?.map((w) => w.hub.translation()) ?? [];
  const particles = world.get(Soil)?.particles;

  world.query(RockField).forEach((entity) => {
    const field = entity.get(RockField);
    const bushes = field.bushes;
    if (!bushes) return;
    const { plants, amount, bend, active } = bushes;
    bushes.crushed ??= new Float32Array(plants.length);
    const crushed = bushes.crushed;
    let dirty = false;
    // Only chunks near the car are tested for new contacts; bent bushes anywhere keep recovering.
    const near = Math.abs(field.cx * 64 + 32 - c.x) < 64 + REACH && Math.abs(field.cz * 64 + 32 - c.z) < 64 + REACH;
    if (near) {
      for (let i = 0; i < plants.length; i++) {
        const p = plants[i];
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        if (dx * dx + dz * dz > 9) continue;
        // Inside the car's footprint (length ±2.5 m, width ±1.25 m), or under a wheel.
        const along = (dx * fx + dz * fz) / fl;
        const across = (-dx * fz + dz * fx) / fl;
        let hit = Math.abs(along) < 2.5 && Math.abs(across) < 1.25 + p.size * 0.4;
        for (const w of wheels) if (Math.hypot(p.x - w.x, p.z - w.z) < 0.4 + p.size * 0.5) hit = true;
        if (!hit) continue;
        const was = amount[i];
        amount[i] = Math.min(1, amount[i] + dt / PRESS);
        crushed[i] = Math.max(crushed[i], amount[i] * CRUSHED);
        // Direction in the bush's own frame (instances are turned by p.turn about +y).
        const cs = Math.cos(p.turn);
        const sn = Math.sin(p.turn);
        bend.array[i * 3] = px * cs - pz * sn;
        bend.array[i * 3 + 1] = px * sn + pz * cs;
        active.add(i);
        dirty = true;
        // A few leaves on first contact at speed.
        if (was < 0.2 && particles && speed > 2) {
          for (let k = 0; k < 4; k++) {
            const shade = 0.8 + Math.random() * 0.4;
            particles.emit(p.x, p.y + p.size * 0.6, p.z, v.x * 0.5 + (Math.random() - 0.5) * 2, 1.5 + Math.random() * 2, v.z * 0.5 + (Math.random() - 0.5) * 2, 0.02 + Math.random() * 0.03, { r: leaf.r * shade, g: leaf.g * shade, b: leaf.b * shade });
          }
        }
      }
    }
    for (const i of active) {
      const p = plants[i];
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      // Recover when the car has moved off.
      const rate = dx * dx + dz * dz > 9 || !near ? 1 : 0.25;
      amount[i] = Math.max(crushed[i], amount[i] - (dt / RECOVER) * rate);
      bend.array[i * 3 + 2] = amount[i];
      if (amount[i] <= crushed[i]) active.delete(i);
      dirty = true;
    }
    if (dirty) bend.needsUpdate = true;
  });
}
