import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CAR } from '../src/vehicle/config.js';
import { ifsCorner } from '../src/vehicle/frame-geometry.js';
import { createSoftCarBody } from '../src/vehicle/soft-vehicle.js';

// Wheel alignment with independent suspension: camber and toe are set by the spindle (the upright
// is built turned by them), caster by the front upper ball joint's fore/aft position.
beforeAll(async () => {
  await RAPIER.init();
});

const rot = (q, v) => {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) };
};
const deg = (r) => (r * 180) / Math.PI;

describe('wheel alignment', () => {
  it('sets caster by the front kingpin axis and leaves the rear upright', () => {
    for (const caster of [0, 5.7, 10]) {
      const car = { ...DEFAULT_CAR, caster };
      const G = ifsCorner(1, car);
      // Upper ball behind the lower one (toward -x at the front) is positive caster.
      const angle = deg(Math.atan2(G.lowerBall.x - G.upperBall.x, G.upperBall.y - G.lowerBall.y));
      expect(angle).toBeCloseTo(caster, 3);
      const R = ifsCorner(3, car);
      expect(R.upperBall.x).toBeCloseTo(R.lowerBall.x, 6);
    }
  });

  it('keeps today\'s caster by default', () => {
    const G = ifsCorner(1, DEFAULT_CAR);
    expect(G.upperBall.x).toBeCloseTo(1.333, 3);
  });

  it('builds each spindle at the set camber and toe', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const car = { ...DEFAULT_CAR, camber: -1.5, toeFront: 0.4, toeRear: 0.2 };
    const { controller } = createSoftCarBody(RAPIER, world, { x: 0, y: 1, z: 0 }, car);
    for (const i of [0, 1, 2, 3]) {
      const side = i % 2 === 0 ? -1 : 1; // right is +z
      const q = controller.wheels[i].hub.rotation();
      const axle = rot(q, { x: 0, y: 0, z: 1 });
      const forward = rot(q, { x: 1, y: 0, z: 0 });
      // Camber: top of the wheel out is positive; the axle's outer end then points down.
      expect(deg(Math.asin(-axle.y * side))).toBeCloseTo(-1.5, 2);
      // Toe-in: the front of the wheel points toward the middle of the car.
      expect(deg(Math.asin(-forward.z * side))).toBeCloseTo(i < 2 ? 0.4 : 0.2, 2);
    }
  });

  it('builds upright spindles by default', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const { controller } = createSoftCarBody(RAPIER, world, { x: 0, y: 1, z: 0 }, DEFAULT_CAR);
    for (const i of [0, 1, 2, 3]) {
      const axle = rot(controller.wheels[i].hub.rotation(), { x: 0, y: 0, z: 1 });
      expect(Math.abs(axle.y)).toBeLessThan(1e-6);
      expect(Math.abs(axle.x)).toBeLessThan(1e-6);
    }
  });
});
