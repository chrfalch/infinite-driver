import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { Physics, RigidBody, Time, Transform, Vehicle } from '../ecs/traits.js';
import { sample } from '../perf.js';
import { histories } from './physics.js';
import { advanceDisplayTime, samplePose } from './interpolation.js';

// ?nointerp draws the newest physics pose instead of the interpolated one (to compare).
const NO_INTERP = new URLSearchParams(globalThis.location?.search ?? '').has('nointerp');

// Sets each body's drawn transform: interpolated at a display time that advances smoothly behind
// the newest physics step. A vehicle also gets `drawOffset`, the rigid move from its physics pose
// to its drawn pose, for parts drawn in world space from other bodies (the GPU tyre meshes).
export function syncBodies(world) {
  const physics = world.get(Physics);
  physics.displayTime = advanceDisplayTime(physics.displayTime, physics.simTime, world.get(Time).delta, physics.step);
  world.query(RigidBody, Transform).updateEach(([rb, transform], entity) => {
    const history = histories.get(rb.body);
    if (NO_INTERP || !history || !samplePose(history, physics.displayTime, transform)) {
      const p = rb.body.translation();
      const q = rb.body.rotation();
      Object.assign(transform.position, { x: p.x, y: p.y, z: p.z });
      Object.assign(transform.quaternion, { x: q.x, y: q.y, z: q.z, w: q.w });
    }
    const vehicle = entity.has(Vehicle) ? entity.get(Vehicle) : null;
    if (vehicle) {
      const p = rb.body.translation();
      const q = rb.body.rotation();
      const drawn = drawnPose.compose(tmpV.set(transform.position.x, transform.position.y, transform.position.z), tmpQ.copy(transform.quaternion), ONE);
      const actual = actualPose.compose(tmpV.set(p.x, p.y, p.z), tmpQ.set(q.x, q.y, q.z, q.w), ONE);
      vehicle.drawOffset ??= new Matrix4();
      vehicle.drawOffset.multiplyMatrices(drawn, actual.invert());
      // Profiling: how far the drawn car's move this frame is from speed x frame time.
      const v = rb.body.linvel();
      const speed = Math.hypot(v.x, v.z);
      const last = (vehicle.lastDrawn ??= { x: transform.position.x, z: transform.position.z });
      const moved = Math.hypot(transform.position.x - last.x, transform.position.z - last.z);
      if (speed > 2) sample('car.motionErrCm', Math.abs(moved - speed * world.get(Time).delta) * 100);
      last.x = transform.position.x;
      last.z = transform.position.z;
    }
  });
}
const drawnPose = new Matrix4();
const actualPose = new Matrix4();
const tmpV = new Vector3();
const tmpQ = new Quaternion();
const ONE = new Vector3(1, 1, 1);
