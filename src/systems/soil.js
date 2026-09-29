import { Color } from 'three/webgpu';
import { Deformation, HeightField, IsPlayer, Soil, Time, Tracks, Vehicle } from '../ecs/traits.js';
import { terrainColorAt } from '../render/terrain-mesh.js';
import { GROUND } from '../tire/config.js';
import { CAR } from '../vehicle/config.js';
import { surfaceAt as groundAt } from '../audio/wheels.js';

const landGround = { rock: 0, gravel: 0 };
const MAX_SOUND_EVENTS = 64;
// Stones thrown and landing, for the sound (audio/ground-synth.js); the audio takes them every frame.
function soundEvent(soil, e) {
  soil.sounds ??= [];
  if (soil.sounds.length < MAX_SOUND_EVENTS) soil.sounds.push(e);
}

const tmp = new Color();
const MAX_DIG = 0.4; // m, deepest hole spinning tyres can dig

// Throws soil from tyres on soft ground: many clumps when a wheel spins faster (or slower) than
// the ground passes under it, a few when rolling fast. Soil taken at the tyre is put back where
// the clumps land, so a spinning wheel digs in and builds a little heap behind it.
export function updateSoil(world) {
  const soil = world.get(Soil);
  const particles = soil?.particles;
  if (!particles) return;
  const { delta } = world.get(Time);
  const { heightAt, surfaceAt } = world.get(HeightField);
  const deformation = world.get(Deformation)?.map;
  const cellArea = deformation ? deformation.cell * deformation.cell : 1;
  const soilPerClump = 0.35; // share of a clump's volume that is moved in the height map

  // Soil landing on bare rock (the dry river's rock sheet) does not pile up.
  const land = (x, z, size) => {
    if (deformation && !heightAt.rockAt?.(x, z)) deformation.add(x, z, (size * size * size * 2 * soilPerClump) / cellArea);
    // Hard ground clicks: bare rock, less so gravel.
    groundAt(heightAt, x, z, landGround);
    const hard = landGround.rock + 0.4 * landGround.gravel;
    if (hard > 0.2) soundEvent(soil, { kind: 'land', size, rock: hard });
  };
  particles.update(delta, surfaceAt, land);

  const softness = GROUND.softness;
  const car = world.queryFirst(IsPlayer, Vehicle);
  if (!car || softness <= 0) return;
  const { controller, body } = car.get(Vehicle);
  if (!controller.wheelSpin) return; // rigid raycast wheels do not report spin
  const contacts = world.get(Tracks).contacts;
  const radius = controller.rollingRadius ? controller.rollingRadius() : CAR.wheelRadius;
  const q = body.rotation();
  // Forward (+x) and axle (+z) directions of the chassis, flattened.
  let fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  let fz = 2 * (q.x * q.z - q.w * q.y);
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  const v = body.linvel();
  const ground = v.x * fx + v.z * fz;

  for (let i = 0; i < 4; i++) {
    const contact = contacts[i];
    // Bare rock throws no soil.
    if (!contact || heightAt.rockAt?.(contact.x, contact.z)) {
      soil.carry[i] = 0;
      continue;
    }
    // Sideways sliding (understeer or oversteer): the tyre bulldozes soil and gravel out toward
    // the way it slides. Slip below about 0.8 m/s (a few degrees of slip angle) throws nothing.
    const hub = controller.wheels?.[i]?.hub;
    if (hub) {
      const hq = hub.rotation();
      // The hub's axle (+z) flattened onto the ground.
      let ax = 2 * (hq.x * hq.z + hq.w * hq.y);
      let az = 1 - 2 * (hq.x * hq.x + hq.y * hq.y);
      const al = Math.hypot(ax, az) || 1;
      ax /= al;
      az /= al;
      const hv = hub.linvel();
      const lateral = hv.x * ax + hv.z * az;
      soil.lateral ??= [0, 0, 0, 0];
      soil.lateral[i] += (lateral - soil.lateral[i]) * Math.min(1, delta / 0.1);
      const slide = Math.abs(soil.lateral[i]);
      soil.carryLat ??= [0, 0, 0, 0];
      soil.carryLat[i] += softness * Math.max(0, slide - 0.8) * 60 * delta;
      const out = Math.sign(soil.lateral[i]);
      if (soil.carryLat[i] >= 1) terrainColorAt(heightAt, contact.x, contact.z, tmp);
      while (soil.carryLat[i] >= 1) {
        soil.carryLat[i] -= 1;
        const size = 0.02 + Math.random() * 0.04;
        const along = (Math.random() - 0.5) * 0.4;
        const x = contact.x + ax * out * 0.18 + fx * along;
        const z = contact.z + az * out * 0.18 + fz * along;
        const throwSpeed = Math.min(6, slide * 0.7 + Math.random() * 1.2);
        const c = 0.62 + Math.random() * 0.2;
        const color = { r: tmp.r * c, g: tmp.g * c * 0.97, b: tmp.b * c * 0.92 };
        const emitted = particles.emit(
          x,
          surfaceAt(x, z) + 0.05,
          z,
          v.x * 0.7 + ax * out * throwSpeed + fx * along * 2,
          0.8 + Math.random() * 1.8 + slide * 0.15,
          v.z * 0.7 + az * out * throwSpeed + fz * along * 2,
          size,
          color,
        );
        if (emitted) soundEvent(soil, { kind: 'throw', size, speed: throwSpeed });
        if (emitted && deformation && deformation.at(contact.x, contact.z) > -MAX_DIG) {
          deformation.add(contact.x, contact.z, -(size * size * size * 2 * soilPerClump) / cellArea);
        }
      }
    }

    // Use a smoothed spin: soft tyres make the raw spin jitter a little even when parked.
    soil.spin ??= [0, 0, 0, 0];
    soil.spin[i] += (controller.wheelSpin(i) - soil.spin[i]) * Math.min(1, delta / 0.15);
    const tread = soil.spin[i] * radius; // tread speed, m/s
    // Only a wheel that is actually turning throws soil.
    if (Math.abs(tread) < 1.2) {
      soil.carry[i] = 0;
      continue;
    }
    const slip = tread - ground;
    const rate = softness * (Math.max(0, Math.abs(slip) - 1.0) * 45 + Math.max(0, Math.abs(ground) - 3) * 1.2);
    soil.carry[i] += rate * delta;
    // Soil leaves opposite to the way the wheel rolls: behind the car going forward, in front of
    // it when reversing.
    const back = tread > 0 ? -1 : 1;
    terrainColorAt(heightAt, contact.x, contact.z, tmp);
    while (soil.carry[i] >= 1) {
      soil.carry[i] -= 1;
      const size = 0.025 + Math.random() * 0.045;
      const along = back * (0.15 + Math.random() * 0.25);
      const side = (Math.random() - 0.5) * 0.3;
      const x = contact.x + fx * along - fz * side;
      const z = contact.z + fz * along + fx * side;
      const throwSpeed = Math.min(10, Math.abs(slip) * 0.5 + Math.random() * 2);
      const lift = 1.2 + Math.random() * 2.5 + Math.abs(slip) * 0.2;
      const spread = (Math.random() - 0.5) * 2.4;
      const c = 0.62 + Math.random() * 0.2; // disturbed soil is darker than the surface
      const color = { r: tmp.r * c, g: tmp.g * c * 0.97, b: tmp.b * c * 0.92 };
      const emitted = particles.emit(
        x,
        surfaceAt(x, z) + 0.06,
        z,
        v.x * 0.6 + fx * back * throwSpeed - fz * spread,
        lift,
        v.z * 0.6 + fz * back * throwSpeed + fx * spread,
        size,
        color,
      );
      if (emitted) soundEvent(soil, { kind: 'throw', size, speed: throwSpeed });
      // Dig at the tyre what the clump carries away (down to a limit).
      if (emitted && deformation && deformation.at(contact.x, contact.z) > -MAX_DIG) {
        deformation.add(contact.x, contact.z, -(size * size * size * 2 * soilPerClump) / cellArea);
      }
    }
  }
}
