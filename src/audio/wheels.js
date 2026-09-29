// What the tyres are doing, for the ground sounds: per wheel, how hard it presses on the ground,
// how fast it rolls and slides, and on what. Written into the audio feed every physics step
// (see feed.js); the ground synth (ground-synth.js) plays it.

// The last four count up: each hit adds its strength, so the audio hears every hit however the
// physics steps and the audio blocks line up (it plays the rise between two blocks).
//   impact  the tyre's load jumping (a rock edge), in static loads
//   bump    the suspension reaching its bump stop, in m/s of closing speed
//   topOut  the suspension reaching full droop, in m/s
//   rim     the rim striking (the tyre squashed flat), in static loads
export const WHEEL_FIELDS = ['contact', 'ground', 'roll', 'slipLong', 'slipLat', 'load', 'rock', 'gravel', 'impact', 'bump', 'topOut', 'rim'];
// The chassis and the driveline:
//   chassisForce  contact force now, in the car's weights (scrapes); chassisHits counting up
//   steer         the front wheels' angle over the full lock (-1..1)
//   low, locks    low range (0/1), and how many differentials are locked (0-3)
//   shaft         torque out of the gearbox, kN·m (signed); clunks counting up (backlash taken up)
//   heave, twist  how hard the chassis is shaken: vertical and rotational acceleration (m/s², rad/s²)
export const BODY_FIELDS = ['chassisForce', 'chassisHits', 'steer', 'low', 'locks', 'shaft', 'clunks', 'heave', 'twist'];
export const WHEELS = 4;
const STATIC_LOAD = (1800 * 9.81) / 4; // N per wheel at rest
const WEIGHT = 1800 * 9.81;
// A load rise per step above this (static loads) is a hit, at most one per wheel in IMPACT_GAP s.
// (0.35 and no gap counted about 50 a second on the dry river's rock: soft tyres ring.)
const IMPACT_JUMP = 0.7;
const IMPACT_GAP = 0.06;
const HIT_JUMP = 0.1; // the same for the chassis (car weights)
// kN·m: a smaller swing through zero makes no clunk; and at most one per CLUNK_GAP s (the shaft
// torque rings through zero a few times as the clutch takes up; 0.12 and no gap clunked constantly).
const CLUNK_SWING = 0.4;
const CLUNK_GAP = 0.35;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The ground under a point as weights: { rock, gravel } (the rest is soil or sand).
//   dry river: the rock sheet, else a sandy bed with pebbles;
//   canyon: the gravel road, bare rock where the rock formations rise, else soil with gravel;
//   snowfield: soft and quiet, no stones (a sound of its own for snow, asphalt and ice is still to do);
//   test worlds: soil with some gravel.
export function surfaceAt(heightAt, x, z, out = { rock: 0, gravel: 0 }) {
  if (heightAt?.snowAt) {
    out.rock = 0;
    out.gravel = 0;
  } else if (heightAt?.rockAt) {
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

// The chassis fields into out (from `offset`), in BODY_FIELDS order.
export function writeBody(vehicle, out, offset, state) {
  const f = (vehicle.contacts?.chassis ?? 0) / WEIGHT;
  const jump = f - (state.chassis ?? 0);
  // A hit is a sharp rise, not the wobble of a lasting scrape.
  if (jump > HIT_JUMP && f > 1.5 * (state.chassis ?? 0)) state.chassisHits = (state.chassisHits ?? 0) + jump;
  state.chassis = f;
  out[offset] = f;
  out[offset + 1] = state.chassisHits ?? 0;

  const d = vehicle.drivetrain;
  const p = d?.params;
  out[offset + 2] = (vehicle.steer ?? 0) / (vehicle.controller?.car?.maxSteer ?? 0.62);
  out[offset + 3] = p?.low ? 1 : 0;
  out[offset + 4] = p ? (p.centerLock ? 1 : 0) + (p.frontLock ? 1 : 0) + (p.rearLock ? 1 : 0) : 0;
  // The driveline's backlash: torque swapping sides (on and off the throttle) knocks the gears.
  const shaft = (d?.shaftTorque ?? 0) / 1000;
  state.sinceClunk = (state.sinceClunk ?? 1) + 1 / 120;
  // Measured from the torque before the swing began, so a quick swing over a few steps counts.
  if (Math.sign(shaft) !== Math.sign(state.before ?? shaft) && Math.abs(shaft - state.before) > CLUNK_SWING && state.sinceClunk > CLUNK_GAP) {
    state.clunks = (state.clunks ?? 0) + Math.abs(shaft - state.before);
    state.sinceClunk = 0;
  }
  if (Math.abs(shaft) > 0.06) state.before = shaft;
  out[offset + 5] = shaft;
  out[offset + 6] = state.clunks ?? 0;

  // Shaking: the chassis' acceleration, smoothed over about 30 ms.
  const body = vehicle.body;
  if (body?.linvel) {
    const v = body.linvel();
    const w = body.angvel();
    const dt = 1 / 120;
    const heave = state.vy === undefined ? 0 : Math.abs(v.y - state.vy) / dt;
    const twist = state.w === undefined ? 0 : Math.hypot(w.x - state.w.x, w.z - state.w.z) / dt;
    state.vy = v.y;
    state.w = { x: w.x, z: w.z };
    const k = 0.25;
    state.heave = (state.heave ?? 0) + (heave - (state.heave ?? 0)) * k;
    state.twist = (state.twist ?? 0) + (twist - (state.twist ?? 0)) * k;
  }
  // The engine lab shakes a car that has no body.
  out[offset + 7] = vehicle.shake?.heave ?? state.heave ?? 0;
  out[offset + 8] = vehicle.shake?.twist ?? state.twist ?? 0;
}

// The wheel fields for every wheel into out (from `offset`), in WHEEL_FIELDS order.
// `surfaces` keeps each wheel's ground between the (less frequent) lookups, and its hit counts.
export function writeWheels(vehicle, out, offset, heightAt, surfaces, lookSurface) {
  const c = vehicle.controller;
  const wheels = c?.wheels;
  const car = c?.car;
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

    // Hits, counting up.
    const l = Math.max(0, load) / STATIC_LOAD;
    const jump = l - (s.lastLoad ?? l);
    s.lastLoad = l;
    s.sinceImpact = (s.sinceImpact ?? 1) + 1 / 120;
    if (jump > IMPACT_JUMP && s.sinceImpact > IMPACT_GAP) {
      s.impact = (s.impact ?? 0) + jump - IMPACT_JUMP;
      s.sinceImpact = 0;
    }
    if (car && w.suspensionLength !== undefined) {
      const length = w.suspensionLength;
      const speed = w.travelSpeed ?? 0;
      const bump = car.suspensionRestLength - car.maxSuspensionTravel;
      const droop = car.suspensionRestLength + 0.08; // the slider's limit (soft-vehicle.js)
      if (!s.inBump && length < bump + 0.015 && speed < -0.3) s.bump = (s.bump ?? 0) + -speed;
      s.inBump = length < bump + 0.03 ? s.inBump || length < bump + 0.015 : false;
      if (!s.inDroop && length > droop - 0.015 && speed > 0.3) s.topOut = (s.topOut ?? 0) + speed;
      s.inDroop = length > droop - 0.03 ? s.inDroop || length > droop - 0.015 : false;
    }
    const rim = (vehicle.contacts?.rims[i] ?? 0) / STATIC_LOAD;
    const rimJump = rim - (s.lastRim ?? 0);
    s.lastRim = rim;
    // Only a new strike: a rim rubbing along a rock keeps changing its force, and counting every
    // rise of that made the rims ring on and on (hundreds a minute on the dry river).
    if (rimJump > 0.5 && (s.rimFree ?? 1) > 0.05) s.rim = (s.rim ?? 0) + rimJump;
    s.rimFree = rim < 0.1 ? (s.rimFree ?? 1) + 1 / 120 : 0; // s since the rim last touched
    out[o + 8] = s.impact ?? 0;
    out[o + 9] = s.bump ?? 0;
    out[o + 10] = s.topOut ?? 0;
    out[o + 11] = s.rim ?? 0;
  }
}
