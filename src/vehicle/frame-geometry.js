import { CAR } from './config.js';
import { wheelMount } from './physics.js';

// Shared chassis-local geometry (x forward, y up, z right) of the tube chassis (the sand buggy in
// render/tube-chassis.js) and every suspension and steering mounting point. The chassis builder,
// the suspension visuals, and the steering all read from here, so they stay attached.
export function frameGeometry() {
  return {
    floorY: -0.4, // floor tube centre
    floorTop: -0.38, // top of the diamond-plate floor
    rockerZ: 0.66,
    noseZ: 0.52, // nose box sides at its rear
    dash: { x: 0.69, y: 0.46 }, // dash bar between the A-pillars
    seatX: -0.18,
  };
}

// Suspension pick-ups on the tube chassis, right side (z > 0); solid axles with 4 links.
export const PICKUPS = {
  shockTop: (front) => (front ? [1.22, 0.12, 0.51] : [-1.2, 0.2, 0.6]),
  lowerLink: (front) => [front ? 0.4 : -0.4, -0.43, 0.42],
  upperLink: (front) => [front ? 0.7 : -0.7, -0.26, 0.25],
};

// Mounting points for one corner (wheel index 0 FL, 1 FR, 2 RL, 3 RR).
export function suspensionMounts(i, car = CAR) {
  const m = wheelMount(i, car);
  const side = Math.sign(m.z);
  const front = m.x > 0;
  const toward = front ? -1 : 1; // toward the middle of the car
  const P = (p) => ({ x: p[0], y: p[1], z: side * p[2] });
  const g = frameGeometry();
  return {
    mount: m,
    side,
    toward,
    // Coil-over top on the nose box (front) or the rear shock post.
    shockTop: P(PICKUPS.shockTop(front)),
    // Solid axle, 4-link: lower links from the floor, upper links closer to the centre line.
    lowerLinkFrame: P(PICKUPS.lowerLink(front)),
    upperLinkFrame: P(PICKUPS.upperLink(front)),
    // Independent: A-arm pivots on the side of the nose box / rear frame beside the wheel.
    upperArmFrame: { x: m.x, y: g.floorY + 0.28, z: side * 0.5 },
    lowerArmFrame: { x: m.x, y: g.floorY, z: side * 0.5 },
  };
}

// Double A-arm (short-long arm) geometry, right front corner (z > 0), at ride height with the
// wheel centre at y = -0.45. Chassis-local metres. The upper arm is 0.70 of the lower, the arms
// slope a little down toward the wheel so their lines meet about 3 m inboard: the roll centre sits
// about 0.3 m above the ground and the wheel gains negative camber in bump. The ball joints give
// 8° kingpin inclination and 6° caster with about 5 cm scrub radius. The steering arm points out
// toward the rear axle's centre line (Ackermann), and the tie rod's inner end was placed by a
// kinematic search so the toe changes less than 0.2° over ±0.15 m of travel (no bump steer). The
// coil-over sits on the lower arm's rear leg at 65 % of its length (motion ratio about 0.55-0.6).
const IFS_FRONT_RIGHT = {
  wheel: [1.35, -0.45, 1.05],
  lowerInner: [
    [1.6, -0.5, 0.45],
    [1.1, -0.5, 0.45],
  ],
  upperInner: [
    [1.53, -0.24, 0.55],
    [1.13, -0.24, 0.55],
  ],
  lowerBall: [1.365, -0.61, 0.955],
  upperBall: [1.333, -0.29, 0.91],
  tieInner: [1.5, -0.375, 0.585],
  tieOuter: [1.48, -0.45, 1.008],
  shockBottom: [1.272, -0.5715, 0.778],
  shockTop: [1.22, 0.12, 0.51],
};
// The rear is the front mirrored fore and aft, with no caster (both ball joints over the axle)
// and fixed toe links instead of the rack; the coil-over tops on the rear posts.
const IFS_REAR_RIGHT = {
  ...IFS_FRONT_RIGHT,
  upperBall: [1.35, -0.29, 0.91],
  lowerBall: [1.35, -0.61, 0.955],
  shockTop: [1.2, 0.2, 0.6],
};

// Travel limit for the arms (rad either way from ride height), about ±0.18 m at the wheel.
export const IFS_ARM_LIMIT = 0.37;

// Track width: the chassis pivots stay where they are on the tube chassis and the outer points
// (wheel, ball joints, tie-rod end) move out or in, so the arms get longer or shorter. The coil-over
// stays at 65 % along the lower arm. Limited so the arms keep a sensible length.
const DESIGN_HALF_TRACK = 1.05;
export function ifsTrackOffset(car = CAR) {
  return Math.max(-0.2, Math.min(0.45, car.track / 2 - DESIGN_HALF_TRACK));
}
const OUTBOARD = { wheel: 1, lowerBall: 1, upperBall: 1, tieOuter: 1, shockBottom: 0.65 };

// Wheel height with independent suspension. Lowering the wheels (a higher ride, wheelMountY below
// the design value) uses taller uprights, like lift spindles on an off-road truck: the wheel centre
// moves down the upright while the arms, ball joints and coil-overs stay where they are, so the car
// keeps its full suspension travel. Raising the wheels (a lower ride) moves the springs' rest
// position instead, at most 10 cm so the arms stay clear of their bump stops.
export const DESIGN_WHEEL_MOUNT_Y = -0.08;
export const IFS_MAX_LIFT = 0.32;
export function ifsSpindleLift(car = CAR) {
  return Math.max(0, Math.min(IFS_MAX_LIFT, DESIGN_WHEEL_MOUNT_Y - car.wheelMountY));
}
export function ifsSpringOffset(car = CAR) {
  return Math.max(0, Math.min(0.1, car.wheelMountY - DESIGN_WHEEL_MOUNT_Y));
}

// The double A-arm points of one corner (wheel index 0 FL, 1 FR, 2 RL, 3 RR), chassis-local.
export function ifsCorner(i, car = CAR) {
  const front = i < 2;
  const side = i % 2 === 0 ? -1 : 1;
  const base = front ? IFS_FRONT_RIGHT : IFS_REAR_RIGHT;
  const sx = front ? 1 : -1;
  const dz = ifsTrackOffset(car);
  const lift = ifsSpindleLift(car);
  const out = { front, side };
  for (const [key, value] of Object.entries(base)) {
    const P = (p) => ({ x: sx * p[0], y: p[1] - (key === 'wheel' ? lift : 0), z: side * (p[2] + dz * (OUTBOARD[key] ?? 0)) });
    out[key] = Array.isArray(value[0]) ? value.map(P) : P(value);
  }
  return out;
}

// The steering rack (front, independent suspension): its centre and half-length.
export const IFS_RACK = { center: { x: 1.5, y: -0.375, z: 0 }, halfLength: 0.44, travel: 0.11 };

// Double A-arm points for drawing a corner whose wheel centre is at `hub` (chassis-local), when
// no physics links exist (the raycast car): the wheel-side points move with the hub.
export function ifsPoseFromHub(i, hub) {
  const G = ifsCorner(i);
  const d = { x: hub.x - G.wheel.x, y: hub.y - G.wheel.y, z: hub.z - G.wheel.z };
  const move = (p) => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z });
  const lowerBall = move(G.lowerBall);
  const pivot = { x: (G.lowerInner[0].x + G.lowerInner[1].x) / 2, y: G.lowerInner[0].y, z: G.lowerInner[0].z };
  const t = 0.65;
  return {
    lowerInner: G.lowerInner,
    upperInner: G.upperInner,
    lowerBall,
    upperBall: move(G.upperBall),
    tieInner: G.tieInner,
    tieOuter: move(G.tieOuter),
    shockTop: G.shockTop,
    shockBottom: { x: G.shockBottom.x, y: pivot.y + (lowerBall.y - pivot.y) * t, z: pivot.z + (lowerBall.z - pivot.z) * t },
    spindle: hub,
  };
}
