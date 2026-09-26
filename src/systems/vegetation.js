import { HeightField, IsPlayer, RockField, Soil, Time, Vehicle } from '../ecs/traits.js';
import { createCrushedBush, deformBush } from '../render/vegetation-mesh.js';

// Bushes are crushed only where the car touches them, and stay crushed like the tyre tracks:
// - a wheel rolling through a bush presses a tyre-wide strip of it flat onto the ground (up to two
//   strips per bush, e.g. the front and rear wheel on different lines);
// - the belly pushes the top of a tall bush down to its height.
// A few leaves fly off on the first hit. A touched bush becomes its own mesh, deformed on the CPU in
// its own unscaled frame (render/vegetation-mesh.js).
const PRESS = 0.12; // s for a strip to go fully flat under a wheel
const TYRE_HALF_WIDTH = 0.2; // m
const BELLY_BELOW_ORIGIN = 0.45; // m from the chassis origin down to the underside of the floor tubes
const REACH = 16; // m around the car to check
const leaf = { r: 0.36, g: 0.5, b: 0.2 };

// World offset (dx, dz) into a bush's unscaled frame (instances are turned by p.turn about +y).
function toLocal(p, dx, dz, scale = p.size) {
  const c = Math.cos(p.turn);
  const s = Math.sin(p.turn);
  return [(dx * c - dz * s) / scale, (dx * s + dz * c) / scale];
}

export function updateBushes(world) {
  const car = world.queryFirst(IsPlayer, Vehicle);
  if (!car) return;
  const { body, controller } = car.get(Vehicle);
  const dt = world.get(Time).delta;
  const heightAt = world.get(HeightField)?.heightAt;
  const c = body.translation();
  const v = body.linvel();
  const q = body.rotation();
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  const fl = Math.hypot(fx, fz) || 1;
  const speed = Math.hypot(v.x, v.z);
  // Wheel paths run along the car's travel (or its nose when slow).
  const tx = speed > 0.3 ? v.x / speed : fx / fl;
  const tz = speed > 0.3 ? v.z / speed : fz / fl;
  const wheels = controller.wheels?.map((w) => w.hub.translation()) ?? [];
  const belly = c.y - BELLY_BELOW_ORIGIN;
  const particles = world.get(Soil)?.particles;

  world.query(RockField).forEach((entity) => {
    const field = entity.get(RockField);
    const bushes = field.bushes;
    if (!bushes) return;
    if (Math.abs(field.cx * 64 + 32 - c.x) > 32 + REACH || Math.abs(field.cz * 64 + 32 - c.z) > 32 + REACH) return;
    const { plants, crushed, mesh } = bushes;
    for (let i = 0; i < plants.length; i++) {
      const p = plants[i];
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      if (dx * dx + dz * dz > 12) continue;
      const sy = p.size * (0.8 + p.shade * 0.4);
      let state = crushed.get(i);
      const touch = () => {
        if (!state) {
          state = { bush: createCrushedBush(mesh, i), strips: [], belly: 99, floor: groundPlane(p, sy, heightAt) };
          crushed.set(i, state);
        }
        state.dirty = true;
      };
      // Belly over the bush: tops pressed down to the floor's height.
      const along = (dx * fx + dz * fz) / fl;
      const across = (-dx * fz + dz * fx) / fl;
      if (Math.abs(along) < 2.5 && Math.abs(across) < 1.0 + p.size * 0.4) {
        const clamp = (belly - (p.y - 0.08)) / sy;
        if (clamp < (state?.belly ?? 99) && clamp < 1) {
          touch();
          state.belly = clamp;
        }
      }
      // Wheels rolling through the bush: press a tyre-wide strip flat along the path.
      for (const w of wheels) {
        if (Math.hypot(p.x - w.x, p.z - w.z) > p.size * 0.85 + TYRE_HALF_WIDTH) continue;
        touch();
        const [x, z] = toLocal(p, w.x - p.x, w.z - p.z);
        const [ux, uz] = toLocal(p, tx, tz, 1);
        const ul = Math.hypot(ux, uz) || 1;
        const width = TYRE_HALF_WIDTH / p.size;
        let strip = state.strips.find((s) => Math.abs((x - s.x) * s.dz - (z - s.z) * s.dx) < width);
        if (!strip) {
          strip = { x, z, dx: ux / ul, dz: uz / ul, amount: 0, width };
          state.strips.push(strip);
          if (state.strips.length > 4) state.strips.shift();
        }
        strip.amount = Math.min(1, strip.amount + dt / PRESS);
        if (!p.hit && particles && speed > 2) {
          p.hit = true;
          for (let k = 0; k < 4; k++) {
            const shade = 0.8 + Math.random() * 0.4;
            particles.emit(w.x, p.y + p.size * 0.5, w.z, v.x * 0.5 + (Math.random() - 0.5) * 2, 1.5 + Math.random() * 2, v.z * 0.5 + (Math.random() - 0.5) * 2, 0.02 + Math.random() * 0.03, { r: leaf.r * shade, g: leaf.g * shade, b: leaf.b * shade });
          }
        }
      }
      if (state?.dirty) {
        deformBush(state.bush, state.strips, state.belly, state.floor);
        state.dirty = false;
      }
    }
  });
}

// The ground under a bush as a function of its local (x, z), in its local height units.
function groundPlane(p, sy, heightAt) {
  if (!heightAt) return () => 0.08 / sy;
  const e = 0.5;
  const gx = (heightAt(p.x + e, p.z) - heightAt(p.x - e, p.z)) / (2 * e);
  const gz = (heightAt(p.x, p.z + e) - heightAt(p.x, p.z - e)) / (2 * e);
  const c = Math.cos(p.turn);
  const s = Math.sin(p.turn);
  // Local (x, z) -> world offset: x_w = (x cos + z sin) * size, z_w = (-x sin + z cos) * size.
  const ax = (p.size * (gx * c - gz * s)) / sy;
  const az = (p.size * (gx * s + gz * c)) / sy;
  const base = (heightAt(p.x, p.z) - (p.y - 0.08)) / sy;
  return (x, z) => base + ax * x + az * z;
}
