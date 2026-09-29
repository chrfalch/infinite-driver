// What the tyres are doing, for the ground sounds: per wheel, how hard it presses on the ground,
// how fast it rolls and slides, and on what. Written into the audio feed every physics step
// (see feed.js); the ground synth (ground-synth.js) plays it.

export const WHEEL_FIELDS = ['contact', 'ground', 'roll', 'slipLong', 'slipLat', 'load', 'rock', 'gravel'];
export const WHEELS = 4;
const STATIC_LOAD = (1800 * 9.81) / 4; // N per wheel at rest

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The ground under a point as weights: { rock, gravel } (the rest is soil or sand).
//   dry river: the rock sheet, else a sandy bed with pebbles;
//   canyon: the gravel road, bare rock where the rock formations rise, else soil with gravel;
//   test worlds: soil with some gravel.
export function surfaceAt(heightAt, x, z, out = { rock: 0, gravel: 0 }) {
  if (heightAt?.rockAt) {
    const rock = heightAt.rockAt(x, z) ? 1 : 0;
    out.rock = rock;
    out.gravel = (1 - rock) * 0.5;
  } else if (heightAt?.world === 'canyon' && heightAt.sample) {
    const s = heightAt.sample(x, z);
    out.rock = smoothstep(0.3, 1.5, s.rock ?? 0) * (1 - s.road);
    out.gravel = Math.max(s.road, 0.35 * (1 - out.rock));
  } else {
    out.rock = 0;
    out.gravel = 0.35;
  }
  return out;
}

// The wheel fields for every wheel into out (from `offset`), in WHEEL_FIELDS order.
// `surfaces` keeps each wheel's ground between the (less frequent) lookups.
export function writeWheels(vehicle, out, offset, heightAt, surfaces, lookSurface) {
  const c = vehicle.controller;
  const wheels = c?.wheels;
  for (let i = 0; i < WHEELS; i++) {
    const o = offset + i * WHEEL_FIELDS.length;
    const w = wheels?.[i];
    if (!w?.hub) {
      out.fill(0, o, o + WHEEL_FIELDS.length);
      continue;
    }
    const hv = w.hub.linvel();
    const q = w.hub.rotation();
    // The hub's axle (+z) flattened onto the ground, and forward across it.
    let ax = 2 * (q.x * q.z + q.w * q.y);
    let az = 1 - 2 * (q.x * q.x + q.y * q.y);
    const al = Math.hypot(ax, az) || 1;
    ax /= al;
    az /= al;
    const fx = az;
    const fz = -ax;
    const forward = hv.x * fx + hv.z * fz;
    const lateral = hv.x * ax + hv.z * az;
    const radius = c.rollingRadius ? c.rollingRadius() : 0.43;
    const roll = (c.wheelSpin ? c.wheelSpin(i) : 0) * radius;
    const load = w.tyreLoad ?? (c.wheelIsInContact?.(i) ? STATIC_LOAD : 0);
    const s = surfaces[i];
    if (lookSurface) {
      const p = w.hub.translation();
      surfaceAt(heightAt, p.x, p.z, s);
    }
    out[o] = smoothstep(150, 900, load);
    out[o + 1] = Math.hypot(forward, lateral);
    out[o + 2] = roll;
    out[o + 3] = roll - forward;
    out[o + 4] = lateral;
    out[o + 5] = Math.max(0, load) / STATIC_LOAD;
    out[o + 6] = s.rock;
    out[o + 7] = s.gravel;
  }
}
