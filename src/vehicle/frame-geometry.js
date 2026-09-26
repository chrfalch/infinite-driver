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
