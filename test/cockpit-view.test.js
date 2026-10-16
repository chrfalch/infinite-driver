import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DRIVER_EYE, cockpitPose } from '../src/cockpit-view.js';
import { steeringGeometry } from '../src/render/car-mesh.js';
import { frameGeometry } from '../src/vehicle/frame-geometry.js';

describe('cockpit view', () => {
  it('puts the eye over the driver seat, behind and above the steering wheel', () => {
    const g = frameGeometry();
    const wheel = steeringGeometry().wheelCenter;
    expect(DRIVER_EYE.z).toBeCloseTo(wheel.z); // the driver sits behind the wheel (left seat)
    expect(Math.abs(DRIVER_EYE.x - g.seatX)).toBeLessThan(0.3);
    expect(DRIVER_EYE.x).toBeLessThan(wheel.x - 0.4);
    expect(DRIVER_EYE.y).toBeGreaterThan(wheel.y + 0.15);
    // Seated head height: about 0.7-0.85 m over the cushion.
    const cushion = g.floorTop + 0.12;
    expect(DRIVER_EYE.y - cushion).toBeGreaterThan(0.65);
    expect(DRIVER_EYE.y - cushion).toBeLessThan(0.9);
  });

  it('follows the car: the eye moves with it and looks along its nose', () => {
    const position = new Vector3(10, 2, -5);
    const yaw = 0.7;
    const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    const pose = cockpitPose(position, quaternion);
    const local = DRIVER_EYE.clone().applyQuaternion(quaternion).add(position);
    expect(pose.position.distanceTo(local)).toBeLessThan(1e-9);
    const view = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    const nose = new Vector3(1, 0, 0).applyQuaternion(quaternion);
    // Along the nose, tipped a little down toward the road.
    expect(view.dot(nose)).toBeGreaterThan(0.98);
    expect(view.y).toBeLessThan(0);
    // Camera up stays the car's up.
    const up = new Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
    expect(up.y).toBeGreaterThan(0.98);
  });

  it('turns the head: positive yaw looks left, positive pitch looks up', () => {
    const q = new Quaternion();
    const left = new Vector3(0, 0, -1).applyQuaternion(cockpitPose(new Vector3(), q, { yaw: Math.PI / 2, pitch: 0 }).quaternion);
    expect(left.z).toBeLessThan(-0.95); // the car's left is -z
    const up = new Vector3(0, 0, -1).applyQuaternion(cockpitPose(new Vector3(), q, { yaw: 0, pitch: 0.5 }).quaternion);
    expect(up.y).toBeGreaterThan(0.3);
  });
});
