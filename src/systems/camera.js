import { CameraTarget, Render, Time, Transform, Vehicle } from '../ecs/traits.js';

// True isometric: the camera looks down the (-1, -1, -1) diagonal.
const ISO_OFFSET = { x: 60, y: 60, z: 60 };
const params = new URLSearchParams(location.search);
const state = { x: 0, y: 0, z: 0, zoom: 1, userZoom: Number(params.get('zoom')) || 1, ready: false };

// Mouse wheel or trackpad pinch zooms in and out.
export function attachZoom(target = window) {
  target.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      state.userZoom = Math.min(4, Math.max(0.4, state.userZoom * Math.exp(-e.deltaY * 0.0015)));
    },
    { passive: false },
  );
}

export function followCamera(world) {
  const target = world.queryFirst(CameraTarget, Transform);
  if (!target) return;
  const { camera, sun } = world.get(Render);
  const { delta } = world.get(Time);
  const { position } = target.get(Transform);
  const speed = Math.abs(target.get(Vehicle)?.speed ?? 0);

  if (!state.ready) {
    Object.assign(state, { x: position.x, y: position.y, z: position.z, zoom: state.userZoom, ready: true });
  }
  // Look ahead in the direction of travel so the car does not drift toward the screen edge.
  const v = target.get(Vehicle)?.body.linvel() ?? { x: 0, y: 0, z: 0 };
  const lead = 0.45;
  const k = 1 - Math.exp(-delta * 3.5);
  state.x += (position.x + v.x * lead - state.x) * k;
  state.y += (position.y - state.y) * k;
  state.z += (position.z + v.z * lead - state.z) * k;

  // Pull back slightly as speed builds.
  const targetZoom = state.userZoom / (1 + speed * 0.012);
  state.zoom += (targetZoom - state.zoom) * (1 - Math.exp(-delta * 2));
  if (Math.abs(camera.zoom - state.zoom) > 1e-4) {
    camera.zoom = state.zoom;
    camera.updateProjectionMatrix();
  }

  camera.position.set(state.x + ISO_OFFSET.x, state.y + ISO_OFFSET.y, state.z + ISO_OFFSET.z);
  camera.lookAt(state.x, state.y, state.z);

  // The sun and its shadow box travel with the car.
  sun.target.position.set(state.x, state.y, state.z);
  sun.position.set(state.x - 35, state.y + 45, state.z - 25);
  sun.target.updateMatrixWorld();
}
