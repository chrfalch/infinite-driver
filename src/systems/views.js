import { Transform, Vehicle, View, WheelOf } from '../ecs/traits.js';
import { CAR } from '../vehicle/config.js';
import { wheelMount } from '../vehicle/physics.js';

export function syncViews(world) {
  world.query(Transform, View).updateEach(([transform, view]) => {
    const { position: p, quaternion: q } = transform;
    view.object.position.set(p.x, p.y, p.z);
    view.object.quaternion.set(q.x, q.y, q.z, q.w);
  });
}

// Wheels are children of the car view, placed from the suspension state.
export function syncWheels(world) {
  world.query(WheelOf('*'), View).forEach((entity) => {
    const car = entity.targetFor(WheelOf);
    const { index } = entity.get(WheelOf(car));
    const { controller } = car.get(Vehicle);
    const { object } = entity.get(View);
    const mount = wheelMount(index);
    const suspension = controller.wheelSuspensionLength(index) ?? CAR.suspensionRestLength;
    object.position.set(mount.x, mount.y - suspension, mount.z);
    object.rotation.set(0, controller.wheelSteering(index) ?? 0, 0, 'YXZ');
    // Spin around the axle; the tyre mesh is built around the local z axis.
    object.children[0].rotation.z = -(controller.wheelRotation(index) ?? 0);
  });
}
