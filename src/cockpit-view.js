import { Euler, Quaternion, Vector3 } from 'three/webgpu';
import { frameGeometry } from './vehicle/frame-geometry.js';

// The driver's view from inside the car (V toggles it, see systems/camera.js).

const g = frameGeometry();
// Chassis-local (+x forward, +y up, +z right): the driver's eyes in the left bucket seat, about
// 0.87 m over the cushion (sitting up, to see the road over the dash bar), the head a little back from the seat's centre against the leaning seat
// back. The steering wheel is 0.5 m ahead and 0.37 m below.
export const DRIVER_EYE = new Vector3(g.seatX - 0.08, g.floorTop + 0.12 + 0.87, -0.3);
// Eyes tipped this far down (radians) from the nose's line, toward the road ahead.
const DOWN = (6 * Math.PI) / 180;

const pose = { position: new Vector3(), quaternion: new Quaternion() };
const head = new Quaternion();
const euler = new Euler(0, 0, 0, 'YXZ');
// A camera looks down its -z; turned -90° about y, it looks down the car's +x.
const FACE_FORWARD = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);

// The camera pose for a car drawn at `position`/`quaternion` (world), with the head turned `yaw`
// (radians, + = left) and `pitch` (+ = up). Returns a shared object, overwritten by the next call.
export function cockpitPose(position, quaternion, { yaw = 0, pitch = 0 } = {}) {
  pose.position.copy(DRIVER_EYE).applyQuaternion(quaternion).add(position);
  euler.set(pitch - DOWN, yaw, 0);
  head.setFromEuler(euler);
  pose.quaternion.copy(quaternion).multiply(FACE_FORWARD).multiply(head);
  return pose;
}
