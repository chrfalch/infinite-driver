import { Color } from 'three/webgpu';
import { Deformation, HeightField, IsPlayer, Soil, Time, Tracks, Vehicle } from '../ecs/traits.js';
import { terrainColorAt } from '../render/terrain-mesh.js';
import { GROUND, currentSnow } from '../tire/config.js';
import { CAR } from '../vehicle/config.js';

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
  // Bare rock (dry river) and bare asphalt (snowfield) throw nothing, and nothing piles up on them.
  const hardAt = heightAt.rockAt ?? heightAt.bareAt;
  const deformation = world.get(Deformation)?.map;
  const cellArea = deformation ? deformation.cell * deformation.cell : 1;
  const soilPerClump = 0.35; // share of a clump's volume that is moved in the height map

  // Soil landing on bare rock (the dry river's rock sheet) does not pile up.
  const land = (x, z, size) => {
    if (deformation && !hardAt?.(x, z)) deformation.add(x, z, (size * size * size * 2 * soilPerClump) / cellArea);
  };
  particles.update(delta, surfaceAt, land);

  // Snow throws more, finer and whiter spray than soil: powder, not clumps of dirt.
  const snow = currentSnow();
  const softness = snow ? 0.8 : GROUND.softness;
  const grain = snow ? 0.55 : 1; // clump size scale
  // A spinning tyre on snow mostly throws the loose powder and polishes the rut; it digs less
  // than in soil, and not below the snow.
  const digShare = snow ? 0.15 : 1;
  // On snow, not below the snow where the tyre is (deeper in a plough bank).
  const maxDig = (x, z) => (heightAt.snowAt ? heightAt.snowAt(x, z).depth : MAX_DIG);
  const spray = (c) => (snow ? { r: tmp.r * (0.94 + c * 0.08), g: tmp.g * (0.94 + c * 0.08), b: tmp.b * (0.95 + c * 0.06) } : { r: tmp.r * (0.62 + c * 0.2), g: tmp.g * (0.62 + c * 0.2) * 0.97, b: tmp.b * (0.62 + c * 0.2) * 0.92 });
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
    if (!contact || hardAt?.(contact.x, contact.z)) {
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
        const size = (0.02 + Math.random() * 0.04) * grain;
        const along = (Math.random() - 0.5) * 0.4;
        const x = contact.x + ax * out * 0.18 + fx * along;
        const z = contact.z + az * out * 0.18 + fz * along;
        const throwSpeed = Math.min(6, slide * 0.7 + Math.random() * 1.2);
        const color = spray(Math.random());
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
        if (emitted && deformation && deformation.at(contact.x, contact.z) > -maxDig(contact.x, contact.z)) {
          deformation.add(contact.x, contact.z, -(size * size * size * 2 * soilPerClump * digShare) / cellArea);
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
      const size = (0.025 + Math.random() * 0.045) * grain;
      const along = back * (0.15 + Math.random() * 0.25);
      const side = (Math.random() - 0.5) * 0.3;
      const x = contact.x + fx * along - fz * side;
      const z = contact.z + fz * along + fx * side;
      const throwSpeed = Math.min(10, Math.abs(slip) * 0.5 + Math.random() * 2);
      const lift = 1.2 + Math.random() * 2.5 + Math.abs(slip) * 0.2;
      const spread = (Math.random() - 0.5) * 2.4;
      const color = spray(Math.random()); // disturbed soil is darker than the surface (snow is not)
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
      // Dig at the tyre what the clump carries away (down to a limit).
      if (emitted && deformation && deformation.at(contact.x, contact.z) > -maxDig(contact.x, contact.z)) {
        deformation.add(contact.x, contact.z, -(size * size * size * 2 * soilPerClump * digShare) / cellArea);
      }
    }
  }
}
