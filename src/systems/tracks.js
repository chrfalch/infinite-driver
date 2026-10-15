import { Deformation, HeightField, IsPlayer, Time, Tracks, Vehicle } from '../ecs/traits.js';
import { compactSoil } from '../terrain/deformation.js';
import { GPU_TIRE, GROUND, TIRE, currentSnow } from '../tire/config.js';
import { gpuGroundHeight, gpuGroundKind } from '../tire/gpu-tires.js';
import { CAR } from '../vehicle/config.js';
import { count, sample } from '../perf.js';
let lastC0 = null;

const CONTACT = 0.035; // tread within this of the ground surface counts as touching

// Contact centre and depth from tyre particles (vec stride 3 or 4), or null when airborne.
// With `pressed`, every particle below the surface is also collected for soil compaction.
// Each particle counts by how far it is inside the CONTACT band, so a row that joins or leaves
// the patch fades in and out. A plain average jumps by up to a row (about 7 cm) when the patch is
// short, as on a hard tyre, and the tracks zig-zag.
export function particleContact(positions, stride, start, count, heightAt, radius, pressed = null) {
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
    if (pressed && depth > 0) pressed.push({ x, z, depth });
    if (depth > -CONTACT) {
      const w = depth + CONTACT;
      sx += x * w;
      sz += z * w;
      n += w;
      deepest = Math.max(deepest, depth);
    }
  }
  return n ? { x: sx / n, z: sz / n, depth: deepest } : null;
}

// Every car's tyre contacts (its Vehicle's `groundContacts`; the player's also in Tracks), tracks
// (wheel 4 * slot + i of the shared track mesh, for the cars that have a slot in it) and ruts.
export function updateTracks(world) {
  const trackState = world.get(Tracks);
  const tracks = trackState.renderer;
  if (!tracks) return;
  trackState.contacts.fill(null);
  tracks.mesh.visible = GROUND.tracks;
  world.query(Vehicle).forEach((car) => {
    const player = car.has(IsPlayer);
    const contacts = carTracks(world, car.get(Vehicle), tracks, player);
    if (player) contacts.forEach((c, i) => (trackState.contacts[i] = c));
  });
  tracks.update(world.get(Time).delta);
}

function carTracks(world, vehicle, tracks, player) {
  const contacts = (vehicle.groundContacts ??= [null, null, null, null]);
  contacts.fill(null);
  // The car's wheels in the shared track mesh, if it has room for them.
  const base = 4 * vehicle.slot;
  const drawn = base + 4 <= tracks.wheels;
  // On snow the ruts themselves are the snow surface's (render/snow-surface.js); the track over
  // them is the packed snow with the tread print.
  const snow = currentSnow();
  const { heightAt, surfaceAt } = world.get(HeightField);
  // Bare rock (dry river) and bare asphalt (snowfield) take no tracks and cannot be compacted.
  const hardAt = heightAt.rockAt ?? heightAt.bareAt;
  const deformation = world.get(Deformation)?.map;
  const pressed = [];
  const { controller, body } = vehicle;
  // Axle direction (chassis +z) flattened onto the ground.
  const q = body.rotation();
  let rx = 2 * (q.x * q.z + q.w * q.y);
  let rz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const len = Math.hypot(rx, rz) || 1;
  const right = { x: rx / len, z: rz / len };
  const softness = GROUND.softness;
  const { delta } = world.get(Time);
  // A normal frame never moves a contact further than this; a longer jump means a respawn.
  const maxGap = Math.max(1.2, Math.abs(vehicle.speed) * delta * 2);
  // GPU tyres: the solver's ground grid is much cheaper to sample than the terrain function.
  const solver = controller.gpu?.solver;
  const groundAt = solver ? (x, z) => gpuGroundHeight(solver, x, z) ?? surfaceAt(x, z) : surfaceAt;

  for (let i = 0; i < 4; i++) {
    let contact = null;
    let width = TIRE.width * 0.85;
    if (solver) {
      // Depth is measured from the rutted surface, and pressed particles compact the soil.
      const first = pressed.length;
      contact = particleContact(solver.positions, 4, i * solver.perTire, solver.perTire, groundAt, 0.02, pressed);
      // The particles were read back at the end of the last physics batch, which can be several
      // steps old. Carry the contact along with the hub's travel since then (translation only: the
      // patch stays at the bottom of the tyre while the wheel spins), so it moves every frame
      // instead of jumping once per batch.
      const from = solver.readbackHubs?.[i];
      if (contact && from) {
        const now = controller.wheels[i].hub.translation();
        const dx = now.x - from.p.x;
        const dz = now.z - from.p.z;
        contact.x += dx;
        contact.z += dz;
        for (let k = first; k < pressed.length; k++) {
          pressed[k].x += dx;
          pressed[k].z += dz;
        }
      }
    } else if (controller.wheels) {
      const soft = controller.wheels[i].soft;
      const p = soft.particlePositions();
      contact = particleContact(p, 3, 0, p.length / 3, heightAt, soft.particleRadius());
    } else if (controller.wheelIsInContact(i)) {
      const p = controller.wheelContactPoint(i);
      contact = p && { x: p.x, z: p.z, depth: 0 };
      width = CAR.wheelWidth * 0.9;
    }
    // Bare rock takes no tracks and cannot be compacted.
    const onRock = contact && hardAt?.(contact.x, contact.z);
    contacts[i] = contact;
    if (!drawn) continue;
    if (player && i === 0) {
      if (contact && lastC0) sample('tracks.segM', Math.hypot(contact.x - lastC0.x, contact.z - lastC0.z));
      lastC0 = contact;
    }
    if (onRock) {
      tracks.lift(base + i);
      continue;
    }
    if (!contact) {
      if (player && tracks.state[base + i].last) count('tracks.breakNoContact');
      tracks.lift(base + i);
      continue;
    }
    // Deeper sinking and softer soil leave darker tracks.
    const strength = Math.min(1, 0.25 + contact.depth * 5 + softness * 0.5);
    if (GROUND.tracks) tracks.add(base + i, heightAt, contact, right, width, strength, maxGap);
  }
  // The canyon's graded roads and sandstone are compacted hard: tracks, but no ruts.
  const ground = { road: 0, rock: 0 };
  const firmAt = heightAt.groundAt
    ? (x, z) => {
        if (!(solver && gpuGroundKind(solver, x, z, ground))) heightAt.groundAt(x, z, ground);
        return ground.road > 0.5 || ground.rock > 0.5;
      }
    : hardAt;
  const soilPressed = firmAt ? pressed.filter((p) => !firmAt(p.x, p.z)) : pressed;
  if (deformation && soilPressed.length) {
    compactSoil(deformation, soilPressed, {
      softness,
      dt: delta,
      right,
      bermOffset: TIRE.width * 0.5 + 0.1,
      snow,
      snowAt: heightAt.snowAt,
      pressureKpa: solver ? GPU_TIRE.pressureKpa : 100,
      hardAt,
      // The dry river's soil pockets rut a little deeper (about 5 cm at the default softness).
      ...(heightAt.soilAt ? { maxRut: 0.13 } : {}),
    });
  }
  return contacts;
}
