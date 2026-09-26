import { CAR } from './config.js';
import { wheelMount } from './physics.js';

// Shared chassis-local geometry (x forward, y up, z right) for the ladder frame, the roll cage,
// and every suspension mounting point. The cage builder, the suspension visuals, and the axle
// links all read from here, so they stay attached when the car's dimensions change.
export function frameGeometry(car = CAR) {
  const { x: hx, y: hy } = car.halfExtents;
  const railY = -hy + 0.02; // frame rail centre
  const railTop = railY + 0.06;
  const railZ = 0.45; // rail centre lines, ±z
  return {
    railY,
    railTop,
    railZ,
    railHalfHeight: 0.06,
    frontEnd: hx * 1.02,
    rearEnd: -hx * 1.02,
    footZ: 0.64, // cage feet sit on outriggers outside the rails
    frontHoopX: 0.62,
    mainHoopX: -0.62,
    pillarTopX: 0.12,
    roofY: railTop + 1.2,
    dashY: railTop + 0.58,
    shockZ: 0.72, // coil-over tops, ±z
  };
}

// Mounting points for one corner (wheel index 0 FL, 1 FR, 2 RL, 3 RR).
export function suspensionMounts(i, car = CAR) {
  const m = wheelMount(i, car);
  const g = frameGeometry(car);
  const side = Math.sign(m.z);
  const toward = m.x > 0 ? -1 : 1; // toward the middle of the car
  const shockX = m.x + toward * 0.12;
  return {
    mount: m,
    side,
    toward,
    // Coil-over top on the shock hoop.
    shockTop: { x: shockX, y: m.y + 0.46, z: side * g.shockZ },
    // Solid axle, 4-link: lower links from frame-rail brackets well inboard, upper links shorter
    // and closer to the centre line, both running lengthwise to the axle.
    lowerLinkFrame: { x: m.x + toward * 0.95, y: g.railY - 0.09, z: side * g.railZ },
    upperLinkFrame: { x: m.x + toward * 0.65, y: g.railY + 0.1, z: side * (g.railZ - 0.2) },
    // Independent: A-arm pivots on brackets on the rail beside the wheel.
    upperArmFrame: { x: m.x, y: g.railY + 0.14, z: side * g.railZ },
    lowerArmFrame: { x: m.x, y: g.railY - 0.14, z: side * g.railZ },
  };
}
