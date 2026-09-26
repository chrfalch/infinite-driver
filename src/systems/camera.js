import { CameraTarget, Render, Time, Transform, Vehicle } from '../ecs/traits.js';

// True isometric: the camera looks down the (-1, -1, -1) diagonal.
const ISO_OFFSET = { x: 60, y: 60, z: 60 };
const state = { x: 0, y: 0, z: 0, zoom: 1, ready: false };

export function followCamera(world) {
  const target = world.queryFirst(CameraTarget, Transform);
  if (!target) return;
  const { camera, sun } = world.get(Render);
  const { delta } = world.get(Time);
  const { position } = target.get(Transform);
  const speed = Math.abs(target.get(Vehicle)?.speed ?? 0);

  if (!state.ready) {
    Object.assign(state, { x: position.x, y: position.y, z: position.z, ready: true });
  }
  // Critically damped-ish follow keeps the motion soft.
  const k = 1 - Math.exp(-delta * 3.5);
  state.x += (position.x - state.x) * k;
  state.y += (position.y - state.y) * k;
  state.z += (position.z - state.z) * k;

  // Pull back slightly as speed builds.
  const targetZoom = 1 / (1 + speed * 0.012);
  state.zoom += (targetZoom - state.zoom) * (1 - Math.exp(-delta * 1.2));
  if (Math.abs(camera.zoom - state.zoom) > 1e-4) {
    camera.zoom = state.zoom;
    camera.updateProjectionMatrix();
  }

  camera.position.set(state.x + ISO_OFFSET.x, state.y + ISO_OFFSET.y, state.z + ISO_OFFSET.z);
  camera.lookAt(state.x, state.y, state.z);

  // The sun and its shadow box travel with the car.
  sun.target.position.set(state.x, state.y, state.z);
  sun.position.set(state.x - 45, state.y + 28, state.z - 30);
  sun.target.updateMatrixWorld();
}
