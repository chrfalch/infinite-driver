import { Color } from 'three/webgpu';
import { Deformation, HeightField, IsPlayer, Soil, Time, Vehicle } from '../ecs/traits.js';
import { terrainColorAt } from '../render/terrain-mesh.js';
import { GROUND, TIRE, currentSnow } from '../tire/config.js';
import { digPatch } from '../terrain/deformation.js';
import { CAR } from '../vehicle/config.js';
import { surfaceAt as groundAt } from '../audio/wheels.js';
import { createHeightCache } from '../terrain/height-cache.js';

const landGround = { rock: 0, gravel: 0 };
const fineGround = { rock: 0, gravel: 0 };
const fineColor = { r: 0, g: 0, b: 0 };
const MAX_FINES_PER_FRAME = 200; // per wheel, so a hitch does not dump a burst
const MAX_SOUND_EVENTS = 64;
// Stones thrown and landing, for the sound (audio/ground-synth.js); the audio takes them every frame.
function soundEvent(soil, e) {
  if (!soil) return;
  soil.sounds ??= [];
  if (soil.sounds.length < MAX_SOUND_EVENTS) soil.sounds.push(e);
}

const tmp = new Color();
const MAX_DIG = 0.4; // m, deepest hole spinning tyres can dig
const PATCH_HALF_LENGTH = 0.16; // m, half the length of ground a spinning tyre digs out
// m³ of soil a slipping tyre churns out per metre of tread slip and metre of tread width, at
// softness 1: in default soil (0.4) a tyre spinning 2 m/s faster than the ground sinks about 3 cm/s.
const DIG_PER_SLIP = 0.008;

// Share of the ground that is fine soil or sand (dust and grains) rather than gravel or rock.
function fineShare(heightAt, x, z) {
  groundAt(heightAt, x, z, fineGround);
  return (1 - fineGround.rock) * (1 - 0.7 * fineGround.gravel);
}

function cachedSurface(heightAt, deformation) {
  const groundHeight = createHeightCache(heightAt);
  return deformation ? (x, z) => groundHeight(x, z) + deformation.at(x, z) : groundHeight;
}

// Throws `n` fine grains from (x, z): `dir` is the throw direction on the ground (unit), `speed`
// its speed, `lift` the upward speed, `v` the car's velocity they partly keep, `rise` how far up
// the tyre they leave the tread (at speed the tread carries them up before they fly off).
function throwFines(fines, n, x, z, dirX, dirZ, speed, lift, v, surfaceAt, tmpColor, rise = 0) {
  for (let k = 0; k < Math.min(n, MAX_FINES_PER_FRAME); k++) {
    const jx = (Math.random() - 0.5) * 0.3;
    const jz = (Math.random() - 0.5) * 0.3;
    const s = speed * (0.4 + Math.random() * 0.9);
    // A wide fan: grains scatter far more than clumps.
    const spread = (Math.random() - 0.5) * (1.5 + speed * 0.6);
    const c = Math.random() < 0.5 ? 0.6 + Math.random() * 0.2 : 1.1 + Math.random() * 0.3; // damp grains darker, dry dust lighter
    fineColor.r = Math.min(1, tmpColor.r * c);
    fineColor.g = Math.min(1, tmpColor.g * c);
    fineColor.b = Math.min(1, tmpColor.b * c * 0.97);
    const px = x + jx;
    const pz = z + jz;
    const ok = fines.emit(
      px,
      surfaceAt(px, pz) + 0.04 + Math.random() * rise,
      pz,
      v.x * 0.5 + dirX * s - dirZ * spread,
      lift * (0.3 + Math.random() * 1.1),
      v.z * 0.5 + dirZ * s + dirX * spread,
      0.008 + Math.random() * Math.random() * 0.03,
      fineColor,
    );
    if (!ok) return;
  }
}

// Throws soil from tyres on soft ground: many clumps when a wheel spins faster (or slower) than
// the ground passes under it, a few when rolling fast. Soil taken at the tyre is put back where
// the clumps land, so a spinning wheel digs in and builds a little heap behind it.
export function updateSoil(world) {
  const soil = world.get(Soil);
  const particles = soil?.particles;
  if (!particles) return;
  const { delta } = world.get(Time);
  const { heightAt } = world.get(HeightField);
  // Bare rock (dry river) and bare asphalt (snowfield) throw nothing, and nothing piles up on them.
  const hardAt = heightAt.rockAt ?? heightAt.bareAt;
  const deformation = world.get(Deformation)?.map;
  // Every grain in flight looks for the ground every frame: from a cache of the terrain's heights
  // (terrain/height-cache.js), with the ruts and heaps on top as they are now.
  soil.surfaceAt ??= cachedSurface(heightAt, deformation);
  const { surfaceAt } = soil;
  const cellArea = deformation ? deformation.cell * deformation.cell : 1;
  const soilPerClump = 0.35; // share of a clump's volume that is moved in the height map

  // Soil landing on bare rock (the dry river's rock sheet) does not pile up.
  const land = (x, z, size) => {
    if (deformation && !hardAt?.(x, z)) deformation.add(x, z, (size * size * size * 2 * soilPerClump) / cellArea);
    // Hard ground clicks: bare rock, less so gravel.
    groundAt(heightAt, x, z, landGround);
    const hard = landGround.rock + 0.4 * landGround.gravel;
    if (hard > 0.2) soundEvent(soil, { kind: 'land', size, rock: hard });
  };
  particles.update(delta, surfaceAt, land);
  // Fine grains are too small to move the ground or be heard.
  const fines = soil.fines;
  fines?.update(delta, surfaceAt, null);

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
  if (softness <= 0) return;
  // Every car throws soil; only the player's is heard.
  world.query(Vehicle).forEach((car) => {
    const vehicle = car.get(Vehicle);
    const { controller, body } = vehicle;
    if (!controller.wheelSpin) return; // rigid raycast wheels do not report spin
    const contacts = vehicle.groundContacts;
    if (!contacts) return;
    const player = car.has(IsPlayer);
    // Each car's wheels keep their own spin and the soil they are about to throw.
    const state = player ? soil : (vehicle.soil ??= { carry: [0, 0, 0, 0] });
    const sounds = player ? soil : null;
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
      // Bare rock throws no state.
      if (!contact || hardAt?.(contact.x, contact.z)) {
        state.carry[i] = 0;
        continue;
      }
      let dug = 0; // m³ this wheel digs out this frame
      // Sand and dust go up even from firm ground; gravel and rock have little of it.
      const fine = fines ? fineShare(heightAt, contact.x, contact.z) * (0.4 + softness) : 0;
      state.carryFine ??= [0, 0, 0, 0];
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
        state.lateral ??= [0, 0, 0, 0];
        state.lateral[i] += (lateral - state.lateral[i]) * Math.min(1, delta / 0.1);
        const slide = Math.abs(state.lateral[i]);
        state.carryLat ??= [0, 0, 0, 0];
        state.carryLat[i] += softness * Math.max(0, slide - 0.8) * 60 * delta;
        const out = Math.sign(state.lateral[i]);
        state.carryFine[i] += fine * Math.max(0, slide - 0.6) * 300 * delta;
        if (state.carryLat[i] >= 1 || state.carryFine[i] >= 1) terrainColorAt(heightAt, contact.x, contact.z, tmp);
        if (state.carryFine[i] >= 1) {
          const n = Math.floor(state.carryFine[i]);
          state.carryFine[i] -= n;
          throwFines(fines, n, contact.x + ax * out * 0.15, contact.z + az * out * 0.15, ax * out, az * out, Math.min(8, slide * 0.9 + 1), 1.2 + slide * 0.25, v, surfaceAt, tmp);
        }
        while (state.carryLat[i] >= 1) {
          state.carryLat[i] -= 1;
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
          if (emitted) soundEvent(sounds, { kind: 'throw', size, speed: throwSpeed });
          if (emitted) dug += size * size * size * 2 * soilPerClump * digShare;
        }
      }

      // Use a smoothed spin: soft tyres make the raw spin jitter a little even when parked.
      state.spin ??= [0, 0, 0, 0];
      state.spin[i] += (controller.wheelSpin(i) - state.spin[i]) * Math.min(1, delta / 0.15);
      const tread = state.spin[i] * radius; // tread speed, m/s
      const slip = tread - ground;
      // A tyre turning faster (or slower) than the ground passes under it churns the soil out of its
      // patch, as much as the tread sweeps past, also when it spins too slowly to throw clumps (a
      // bogged-down car crawling its tyres round). The patch keeps deepening down to a limit.
      if (deformation) {
        dug += DIG_PER_SLIP * softness * digShare * Math.max(0, Math.abs(slip) - 0.3) * TIRE.width * delta;
        digPatch(deformation, contact.x, contact.z, fx, fz, PATCH_HALF_LENGTH, TIRE.width * 0.45, dug, maxDig, hardAt);
      }
      // Only a wheel that is actually turning throws state.
      if (Math.abs(tread) < 1.2) {
        state.carry[i] = 0;
        state.carryFine[i] = 0;
        continue;
      }
      const rate = softness * (Math.max(0, Math.abs(slip) - 1.0) * 45 + Math.max(0, Math.abs(ground) - 3) * 1.2);
      state.carry[i] += rate * delta;
      // Soil leaves opposite to the way the wheel rolls: behind the car going forward, in front of
      // it when reversing.
      const back = tread > 0 ? -1 : 1;
      terrainColorAt(heightAt, contact.x, contact.z, tmp);
      // Many more fine grains than clumps when the tyre spins, and a light dust trail when rolling fast.
      // Even the slight slip of a driven wheel at speed sends up grains: the faster the tread sweeps
      // the ground, the more it scuffs loose.
      const slipFine = Math.max(0, Math.abs(slip) - 0.25);
      state.carryFine[i] += fine * (slipFine * (400 + Math.abs(ground) * 80) + Math.max(0, Math.abs(ground) - 3) * 20) * delta;
      if (state.carryFine[i] >= 1) {
        const n = Math.floor(state.carryFine[i]);
        state.carryFine[i] -= n;
        throwFines(fines, n, contact.x + fx * back * 0.2, contact.z + fz * back * 0.2, fx * back, fz * back, Math.min(14, Math.abs(slip) * 0.7 + 1.5), 1.5 + Math.abs(slip) * 0.3 + Math.abs(ground) * 0.2, v, surfaceAt, tmp, Math.min(0.45, Math.abs(ground) * 0.04));
      }
      while (state.carry[i] >= 1) {
        state.carry[i] -= 1;
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
        if (emitted) soundEvent(sounds, { kind: 'throw', size, speed: throwSpeed });
      }
    }
  });
}
