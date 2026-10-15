// Cars in the water (the town's river and ponds, the stadium's water holes): every wheel and the
// body push the water where they move (render/water-waves.js), and throw it up (render/
// water-spray.js):
// - off the tread: a wheel in the water carries it round and flings it off, up and back from the
//   rear of the tyre; a spinning wheel throws a rooster tail.
// - bow spray: a wheel or the body ploughing through the water sheets it out to the side.
// - a splash: a wheel or the body dropping into the water (landing a jump) throws a crown of drops
//   and a ring of waves.
// - mist off it all at speed.
// Drops falling back strike the water and leave their own rings.
import { HeightField, IsPlayer, Time, Vehicle } from '../ecs/traits.js';
import { CAR } from '../vehicle/config.js';

const TAU = Math.PI * 2;
const NEAR = 70; // m from the player's car: further cars push the water but throw nothing
const BODY_BOTTOM = 0.3; // m below the chassis origin
const BODY_POINTS = [-1.4, 0, 1.4]; // m along the chassis, where it pushes the water
const MAX_IMPACTS = 120; // drops striking the water per frame that make rings
const MAX_PER_FRAME = 400; // drops one wheel may throw in a frame, so a hitch does not dump a burst

const rnd = (a, b) => a + Math.random() * (b - a);

export function updateWater(world, water, spray, camera, dark = 0) {
  const { delta: dt } = world.get(Time);
  if (!dt) return;
  const { surfaceAt } = world.get(HeightField);
  const { level, waves } = water;
  const { drops, mist } = spray;
  const player = world.queryFirst(IsPlayer, Vehicle)?.get(Vehicle).body.translation();
  // Water at (x, z): the ground there is below the water.
  const wet = (x, z) => surfaceAt(x, z) < level - 0.02;

  const emitDrop = (x, y, z, vx, vy, vz, size = rnd(0.012, 0.04)) => drops.emit(x, Math.max(y, level + 0.02), z, vx, vy, vz, size, rnd(1.6, 2.6), rnd(0.55, 0.9));
  const emitMist = (x, y, z, vx, vy, vz, size, opacity) => mist.emit(x, Math.max(y, level + 0.1), z, vx, vy, vz, size, rnd(1, 2), opacity);

  // A crown of drops and a ring of waves where something drops into the water at `fall` m/s.
  const splash = (x, z, fall, radius, vx, vz) => {
    const n = Math.min(500, Math.round(radius * fall * fall * 10));
    for (let k = 0; k < n; k++) {
      const a = Math.random() * TAU;
      const out = fall * rnd(0.2, 0.75);
      const r = radius * rnd(0.6, 1.1);
      emitDrop(x + Math.cos(a) * r, level + 0.05, z + Math.sin(a) * r, vx * 0.4 + Math.cos(a) * out, fall * rnd(0.5, 1.4), vz * 0.4 + Math.sin(a) * out, rnd(0.015, 0.06));
    }
    for (let k = 0; k < Math.min(30, n / 12); k++) {
      const a = Math.random() * TAU;
      emitMist(x + Math.cos(a) * radius, level + rnd(0.2, 0.8), z + Math.sin(a) * radius, Math.cos(a) * fall * 0.3 + vx * 0.3, fall * 0.25, Math.sin(a) * fall * 0.3 + vz * 0.3, radius * rnd(0.6, 1.2), 0.35);
    }
    waves?.impulse(x, z, radius * 1.2, -Math.min(4, fall) * 0.6);
    waves?.foam(x, z, radius * 2, 1.2);
  };

  world.query(Vehicle).forEach((car) => {
    const vehicle = car.get(Vehicle);
    const { controller, body } = vehicle;
    if (!controller?.wheels) return;
    const bp = body.translation();
    // Quick out: the whole car is well above the water.
    if (bp.y - level > 2.5) {
      vehicle.water = null;
      return;
    }
    const state = (vehicle.water ??= { sub: [0, 0, 0, 0], tail: [0, 0, 0, 0], bow: [0, 0, 0, 0], mist: [0, 0, 0, 0], body: 0, bodyBow: 0 });
    const near = !player || Math.hypot(bp.x - player.x, bp.z - player.z) < NEAR;
    const radius = controller.rollingRadius ? controller.rollingRadius() : CAR.wheelRadius;
    const q = body.rotation();
    // Forward (+x) and axle (+z, right) directions of the chassis, flattened.
    let fx = 1 - 2 * (q.y * q.y + q.z * q.z);
    let fz = 2 * (q.x * q.z - q.w * q.y);
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const rx = -fz;
    const rz = fx;
    const v = body.linvel();
    const ground = v.x * fx + v.z * fz;

    for (let i = 0; i < 4; i++) {
      const hub = controller.wheels[i]?.hub;
      if (!hub) continue;
      const p = hub.translation();
      const sub = wet(p.x, p.z) ? Math.min(2 * radius, Math.max(0, level - (p.y - radius))) : 0;
      const was = state.sub[i];
      state.sub[i] = sub;
      if (sub <= 0) {
        state.tail[i] = state.bow[i] = state.mist[i] = 0;
        continue;
      }
      const hv = hub.linvel();
      const speed = Math.hypot(hv.x, hv.z);
      const tread = (controller.wheelSpin ? controller.wheelSpin(i) : ground / radius) * radius;
      const slip = Math.abs(tread - ground);
      // The tyre in the water: its chord at the water line, and half its width.
      const reach = Math.sqrt(Math.max(0, sub * (2 * radius - sub))) + CAR.wheelWidth * 0.5;
      waves?.push(p.x, p.z, Math.max(0.25, reach), sub * 0.7);
      waves?.foam(p.x, p.z, reach * 1.4, (0.2 + speed * 0.12 + slip * 0.2) * Math.min(1, sub / radius) * dt);
      if (!near) continue;

      // Into the water from above: a splash.
      if (was <= 0 && hv.y < -1.5) splash(p.x, p.z, -hv.y, 0.5, hv.x, hv.z);

      const side = (p.x - bp.x) * rx + (p.z - bp.z) * rz > 0 ? 1 : -1;
      const wetTread = Math.min(1, sub / (0.6 * radius)) * (sub < 1.8 * radius ? 1 : 0.15);
      // Off the tread, from the rear half of the tyre, the way it turns.
      const turn = Math.abs(tread);
      state.tail[i] += wetTread * (Math.max(0, turn - 1.5) * 22 + Math.max(0, slip - 1) * 60) * dt;
      const dir = tread >= 0 ? 1 : -1;
      const ux = fx * dir;
      const uz = fz * dir;
      let n = 0;
      while (state.tail[i] >= 1 && n++ < MAX_PER_FRAME) {
        state.tail[i] -= 1;
        // Angle up from the back of the tyre: the tread there moves up, at the bottom back.
        const a = rnd(-1.0, 0.6);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const across = rnd(-0.5, 0.5) * CAR.wheelWidth;
        // Most of the water slides off the tread early; a little leaves at its full speed.
        const fling = turn * rnd(0.25, 0.6);
        const spread = rnd(-0.5, 0.5) * turn * 0.15 + side * rnd(0, 0.1) * turn;
        emitDrop(
          p.x - ux * radius * ca + rx * across,
          p.y + radius * sa,
          p.z - uz * radius * ca + rz * across,
          hv.x + ux * sa * fling + rx * spread,
          hv.y + ca * fling,
          hv.z + uz * sa * fling + rz * spread,
        );
      }
      if (state.tail[i] >= 1) state.tail[i] = 0;

      // Ploughing: a sheet of spray off the front and outer side of the tyre.
      const plough = Math.min(1, sub / radius);
      state.bow[i] += plough * Math.max(0, speed - 1) ** 1.5 * 11 * dt;
      n = 0;
      if (speed > 0.1) {
        const vx = hv.x / speed;
        const vz = hv.z / speed;
        while (state.bow[i] >= 1 && n++ < MAX_PER_FRAME) {
          state.bow[i] -= 1;
          const out = side * rnd(0.3, 1);
          emitDrop(
            p.x + vx * radius * 0.8 + rx * out * CAR.wheelWidth,
            level + 0.03,
            p.z + vz * radius * 0.8 + rz * out * CAR.wheelWidth,
            hv.x * rnd(0.55, 0.95) + rx * out * speed * rnd(0.15, 0.45),
            speed * rnd(0.2, 0.5) * plough,
            hv.z * rnd(0.55, 0.95) + rz * out * speed * rnd(0.15, 0.45),
          );
        }
      }
      if (state.bow[i] >= 1) state.bow[i] = 0;

      // Mist at speed, and off a fast-turning tyre.
      state.mist[i] += plough * (Math.max(0, speed - 4) * 2.5 + Math.max(0, turn - 7) * 1.5) * dt;
      while (state.mist[i] >= 1) {
        state.mist[i] -= 1;
        emitMist(p.x - ux * radius, p.y + radius * 0.5, p.z - uz * radius, hv.x * 0.6 + rx * side * 0.6, rnd(0.3, 1), hv.z * 0.6 + rz * side * 0.6, rnd(0.25, 0.55), 0.22);
      }
    }

    // The body in the water.
    const bottom = bp.y - BODY_BOTTOM;
    const bodySub = wet(bp.x, bp.z) ? Math.max(0, level - bottom) : 0;
    const bodyWas = state.body;
    state.body = bodySub;
    if (bodySub <= 0) {
      state.bodyBow = 0;
      return;
    }
    const speed = Math.hypot(v.x, v.z);
    for (const along of BODY_POINTS) waves?.push(bp.x + fx * along, bp.z + fz * along, 1.0, Math.min(1, bodySub) * 0.6);
    waves?.foam(bp.x, bp.z, 2, (0.1 + speed * 0.1) * Math.min(1, bodySub) * dt);
    if (!near) return;
    if (bodyWas <= 0 && v.y < -2) splash(bp.x, bp.z, -v.y, 1.4, v.x, v.z);
    // The bow wave off the front corners.
    state.bodyBow += Math.min(1, bodySub * 2) * Math.max(0, Math.abs(ground) - 1.5) ** 1.5 * 12 * dt;
    const front = ground >= 0 ? 1 : -1;
    let n = 0;
    while (state.bodyBow >= 1 && n++ < MAX_PER_FRAME) {
      state.bodyBow -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = bp.x + fx * front * 1.8 + rx * side * 0.9;
      const z = bp.z + fz * front * 1.8 + rz * side * 0.9;
      const out = speed * rnd(0.2, 0.55);
      emitDrop(x, level + 0.05, z, v.x * rnd(0.6, 1) + rx * side * out, speed * rnd(0.2, 0.55), v.z * rnd(0.6, 1) + rz * side * out, rnd(0.015, 0.05));
      if (Math.random() < 0.05 * Math.min(1, speed / 6)) emitMist(x, level + 0.3, z, v.x * 0.5 + rx * side * 1.5, 0.6, v.z * 0.5 + rz * side * 1.5, rnd(0.4, 0.8), 0.25);
    }
    if (state.bodyBow >= 1) state.bodyBow = 0;
  });

  // Drops falling back into the water leave rings.
  let impacts = 0;
  const onWater = (x, z, size, fall) => {
    if (!waves || impacts++ >= MAX_IMPACTS) return;
    waves.impulse(x, z, 0.2, -Math.min(6, fall) * size * 4);
  };
  const groundAt = water.groundAt ?? surfaceAt;
  drops.update(dt, camera, water.surfaceAt, groundAt, onWater);
  mist.update(dt, camera, water.surfaceAt, groundAt, null);
  const glow = 1 - 0.9 * dark;
  drops.setGlow(glow);
  mist.setGlow(glow);
}
