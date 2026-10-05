import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { GROUP, groups } from '../src/tire/soft-tire.js';
import { DEFAULT_CAR } from '../src/vehicle/config.js';
import { Drivetrain, DEFAULT_DRIVETRAIN } from '../src/vehicle/drivetrain.js';
import { applyDriverInput } from '../src/vehicle/physics.js';
import { createSoftCarBody, softCarRideHeight } from '../src/vehicle/soft-vehicle.js';

const DT = 1 / 120;
const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false };

beforeAll(async () => {
  await RAPIER.init();
});

// A jointed car (Rapier soft tyres) on flat ground, with crash damage on.
function setup({ y = softCarRideHeight(), linvel, car: extra = {} } = {}) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(groups(GROUP.WORLD, 0xffff)),
  );
  const car = { ...JSON.parse(JSON.stringify(DEFAULT_CAR)), gpuTires: false, damage: true, ...extra };
  const { body, controller } = createSoftCarBody(RAPIER, world, { x: 0, y, z: 0 }, car, undefined, { linvel });
  const state = { body, controller, steer: 0, drivetrain: new Drivetrain({ ...DEFAULT_DRIVETRAIN }) };
  const run = (seconds, input = idle) => {
    for (let t = 0; t < seconds; t += DT) {
      applyDriverInput(state, input, DT, car);
      controller.updateVehicle(DT);
      world.step();
    }
  };
  return { world, state, controller, body, run, car };
}

// Camber of wheel i's upright (rad, top out positive), from its spin axis in the chassis frame.
function camber(controller, i) {
  const { steer: q } = controller.wheelHubPose(i);
  // The axle (local z) turned by the upright; its height is the tilt.
  const ay = 2 * (q.y * q.z + q.w * q.x);
  const side = Math.sign(controller.wheels[i].mount.z);
  return Math.asin(Math.max(-1, Math.min(1, ay))) * -side;
}

describe('crash damage', () => {
  it('leaves the car whole after a normal landing', () => {
    const { controller, run } = setup({ y: softCarRideHeight() + 1 });
    run(3);
    for (let i = 0; i < 4; i++) {
      expect(controller.wheelDetached(i)).toBe(false);
      expect(controller.wheels[i].bend).toBeUndefined();
      expect(controller.jointDrift(i)).toBeLessThan(0.02);
    }
  }, 30000);

  it('a bent upright keeps its new camber', () => {
    const { controller, run } = setup();
    run(2);
    const before = camber(controller, 0);
    // A full-strength blow pushing the hub in toward the car.
    controller.bendCorner(controller.wheels[0], 1, { x: 0, y: 0, z: 0.2 });
    run(2);
    const after = camber(controller, 0);
    console.log('camber before', ((before * 180) / Math.PI).toFixed(1), '° after', ((after * 180) / Math.PI).toFixed(1), '°');
    expect(Math.abs(after - before)).toBeGreaterThan((4 * Math.PI) / 180);
    // The other corners are untouched, and the joints hold the new shape.
    expect(Math.abs(camber(controller, 1) - camber(controller, 0))).toBeGreaterThan((4 * Math.PI) / 180);
    for (let i = 0; i < 4; i++) expect(controller.jointDrift(i)).toBeLessThan(0.02);
  }, 30000);

  it('a lost wheel rolls away and the car drives on three', () => {
    const { controller, body, run } = setup();
    run(2);
    controller.detachWheel(1);
    expect(controller.wheelDetached(1)).toBe(true);
    // Its axle joint is gone; the rest of the corner stays together.
    expect(controller.wheels[1].joints).not.toContain(controller.wheels[1].axleJoint);
    run(2, { ...idle, throttle: 1 });
    const hub = controller.wheels[1].hub.translation();
    const p = body.translation();
    console.log('after 2 s on three wheels: car at', p.x.toFixed(1), 'm, lost wheel at', hub.x.toFixed(1), 'm');
    for (const v of [p.x, p.y, p.z, hub.x, hub.y, hub.z]) expect(Number.isFinite(v)).toBe(true);
    expect(p.x).toBeGreaterThan(3);
    // The car has left its wheel behind, and the drivetrain reads the other front wheel's spin.
    expect(p.x - hub.x).toBeGreaterThan(1.5);
    expect(controller.wheelSpin(1)).toBe(controller.wheelSpin(0));
    expect(controller.wheelIsInContact(1)).toBe(false);
  }, 30000);

  it('solid axles lose wheels too', () => {
    const { controller, body, run } = setup({ car: { solidAxles: true } });
    run(2);
    controller.detachWheel(0);
    controller.detachWheel(3);
    run(2, { ...idle, throttle: 1 });
    const p = body.translation();
    for (const v of [p.x, p.y, p.z]) expect(Number.isFinite(v)).toBe(true);
    expect(controller.wheelDetached(0) && controller.wheelDetached(3)).toBe(true);
    expect(controller.wheelSpin(3)).toBe(controller.wheelSpin(2));
    // Drawing: a lost wheel's shaft ends at the beam end, which stays on the car.
    const seat = controller.wheelSeat(3);
    expect(Math.abs(seat.z - controller.wheels[3].mount.z)).toBeLessThan(0.3);
  }, 30000);

  // Rapier's soft tyres (used here; the game's GPU tyres need a browser) cushion their rims more
  // than the GPU tyres, so this hit stretches the joints about 10 cm: it bends the default car,
  // and only weak parts break.
  it('a hard hit at speed bends the suspension, and takes a wheel off weak parts', () => {
    const crash = (car) => {
      const s = setup({ car, linvel: { x: 25, y: 0, z: 0 } });
      // A low concrete block across the left side, about a rim's height.
      s.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.5, 0.35, 0.6).setTranslation(8, 0.35, -1.2).setCollisionGroups(groups(GROUP.WORLD, 0xffff)),
      );
      // Coasting with no driver input, so only the hit slows the car.
      for (let t = 0; t < 1.5; t += DT) {
        s.controller.updateVehicle(DT);
        s.world.step();
      }
      return {
        lost: [0, 1, 2, 3].filter((i) => s.controller.wheelDetached(i)).length,
        bent: s.controller.wheels.filter((w) => w.bend).length,
      };
    };
    const normal = crash({});
    const weak = crash({ partStrength: 0.3 });
    const off = crash({ damage: false });
    console.log('lost/bent: default', normal, '| weak parts', weak, '| damage off', off);
    expect(normal.lost).toBe(0);
    expect(normal.bent).toBeGreaterThan(0);
    expect(weak.lost).toBeGreaterThan(0);
    expect(off).toEqual({ lost: 0, bent: 0 });
  }, 60000);
});
