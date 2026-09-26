import { HeightField, IsPlayer, Time, Tracks, Vehicle } from '../ecs/traits.js';
import { GROUND, TIRE } from '../tire/config.js';
import { CAR } from '../vehicle/config.js';

const CONTACT = 0.035; // tread within this of the ground surface counts as touching

// Contact centre and depth from tyre particles (vec stride 3 or 4), or null when airborne.
function particleContact(positions, stride, start, count, heightAt, radius) {
  let sx = 0;
  let sz = 0;
  let n = 0;
  let deepest = 0;
  for (let k = 0; k < count; k++) {
    const o = (start + k) * stride;
    const x = positions[o];
    const y = positions[o + 1];
    const z = positions[o + 2];
    const depth = heightAt(x, z) + radius - y;
    if (depth > -CONTACT) {
      sx += x;
      sz += z;
      n++;
      deepest = Math.max(deepest, depth);
    }
  }
  return n ? { x: sx / n, z: sz / n, depth: deepest } : null;
}

export function updateTracks(world) {
  const tracks = world.get(Tracks).renderer;
  if (!tracks) return;
  tracks.mesh.visible = GROUND.tracks;
  if (!GROUND.tracks) return;
  const car = world.queryFirst(IsPlayer, Vehicle);
  if (!car) return;
  const { heightAt } = world.get(HeightField);
  const { controller, body } = car.get(Vehicle);
  // Axle direction (chassis +z) flattened onto the ground.
  const q = body.rotation();
  let rx = 2 * (q.x * q.z + q.w * q.y);
  let rz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const len = Math.hypot(rx, rz) || 1;
  const right = { x: rx / len, z: rz / len };
  const softness = GROUND.softness;

  for (let i = 0; i < 4; i++) {
    let contact = null;
    let width = TIRE.width * 0.85;
    if (controller.gpu) {
      const s = controller.gpu.solver;
      contact = particleContact(s.positions, 4, i * s.perTire, s.perTire, heightAt, 0.02);
    } else if (controller.wheels) {
      const soft = controller.wheels[i].soft;
      const p = soft.particlePositions();
      contact = particleContact(p, 3, 0, p.length / 3, heightAt, soft.particleRadius());
    } else if (controller.wheelIsInContact(i)) {
      const p = controller.wheelContactPoint(i);
      contact = p && { x: p.x, z: p.z, depth: 0 };
      width = CAR.wheelWidth * 0.9;
    }
    if (!contact) {
      tracks.lift(i);
      continue;
    }
    // Deeper sinking and softer soil leave darker tracks.
    const strength = Math.min(1, 0.25 + contact.depth * 5 + softness * 0.5);
    tracks.add(i, heightAt, contact, right, width, strength);
  }
  tracks.update(world.get(Time).delta);
}
