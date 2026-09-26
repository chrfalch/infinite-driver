import { CameraTarget, HeightField, Render, Time, Transform, Vehicle } from '../ecs/traits.js';
import { HORIZON, createBackdrop } from '../render/backdrop.js';
import { VIEW_HEIGHT } from '../render/scene.js';

// True isometric by default: the camera looks down the (-1, -1, -1) diagonal (azimuth 45°,
// elevation 35.3°). ?az=<degrees> starts the view turned around the car. Dragging with the mouse
// (or twisting two fingers) orbits; double-click resets.
const DISTANCE = 60 * Math.sqrt(3);
const ISO_AZIMUTH = ((Number(new URLSearchParams(globalThis.location?.search ?? '').get('az')) || 45) * Math.PI) / 180;
const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);
const MIN_ELEVATION = (12 * Math.PI) / 180;
const MAX_ELEVATION = (88 * Math.PI) / 180;
const view = { azimuth: ISO_AZIMUTH, elevation: ISO_ELEVATION };
const offset = { x: 0, y: 0, z: 0 };
// Below this elevation the view switches to perspective, with a horizon, sky and backdrop.
const PERSPECTIVE_BELOW = (30 * Math.PI) / 180;
let backdrop = null;
let orthoFog = null;
function updateOffset() {
  const h = DISTANCE * Math.cos(view.elevation);
  offset.x = h * Math.cos(view.azimuth);
  offset.y = DISTANCE * Math.sin(view.elevation);
  offset.z = h * Math.sin(view.azimuth);
}
updateOffset();
const params = new URLSearchParams(location.search);
// Short (phone) screens start closer so the car is not tiny.
const defaultZoom = globalThis.innerHeight < 500 ? 1.7 : 1;
const state = { x: 0, y: 0, z: 0, zoom: 1, userZoom: Number(params.get('zoom')) || defaultZoom, ready: false };

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
  // Two-finger pinch zooms on touch screens; twisting the fingers turns the view.
  let pinch = null;
  const spread = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  const twist = (touches) => Math.atan2(touches[1].clientY - touches[0].clientY, touches[1].clientX - touches[0].clientX);
  target.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) pinch = { distance: spread(e.touches), zoom: state.userZoom, angle: twist(e.touches), azimuth: view.azimuth };
    },
    { passive: true },
  );
  target.addEventListener(
    'touchmove',
    (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      state.userZoom = Math.min(4, Math.max(0.4, pinch.zoom * (spread(e.touches) / pinch.distance)));
      view.azimuth = pinch.azimuth + (twist(e.touches) - pinch.angle);
      updateOffset();
    },
    { passive: false },
  );
  // Mouse: drag (any button) to orbit around the car, double-click to reset.
  let drag = null;
  target.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    drag = { x: e.clientX, y: e.clientY };
    target.setPointerCapture?.(e.pointerId);
  });
  target.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view.azimuth += (e.clientX - drag.x) * 0.006;
    view.elevation = Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, view.elevation + (e.clientY - drag.y) * 0.005));
    drag = { x: e.clientX, y: e.clientY };
    updateOffset();
  });
  const endDrag = (e) => {
    drag = null;
    target.releasePointerCapture?.(e.pointerId);
  };
  target.addEventListener('pointerup', endDrag);
  target.addEventListener('pointercancel', endDrag);
  target.addEventListener('contextmenu', (e) => e.preventDefault());
  target.addEventListener('dblclick', () => {
    view.azimuth = ISO_AZIMUTH;
    view.elevation = ISO_ELEVATION;
    updateOffset();
  });
  target.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinch = null;
  });
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

  camera.position.set(state.x + offset.x, state.y + offset.y, state.z + offset.z);
  camera.lookAt(state.x, state.y, state.z);

  // Low views: a perspective camera framing the same area around the car (same visible height at
  // the car), kept above the ground, with haze and the backdrop on the horizon.
  const render = world.get(Render);
  const low = view.elevation < PERSPECTIVE_BELOW;
  backdrop ??= createBackdrop(render.scene);
  orthoFog ??= { color: render.scene.fog.color.clone(), near: render.scene.fog.near, far: render.scene.fog.far, background: render.scene.background };
  if (low) {
    const persp = render.perspective;
    const d = VIEW_HEIGHT / state.zoom / 2 / Math.tan((persp.fov * Math.PI) / 360);
    const inv = 1 / DISTANCE;
    let px = state.x + offset.x * inv * d;
    let py = state.y + offset.y * inv * d;
    let pz = state.z + offset.z * inv * d;
    const heightAt = world.get(HeightField)?.heightAt;
    if (heightAt) py = Math.max(py, heightAt(px, pz) + 1.5);
    persp.position.set(px, py, pz);
    persp.lookAt(state.x, state.y + 0.6, state.z);
    render.activeCamera = persp;
    render.scene.fog.color.copy(HORIZON);
    render.scene.fog.near = 80;
    render.scene.fog.far = 210;
    render.scene.background = HORIZON;
  } else {
    render.activeCamera = camera;
    render.scene.fog.color.copy(orthoFog.color);
    render.scene.fog.near = orthoFog.near;
    render.scene.fog.far = orthoFog.far;
    render.scene.background = orthoFog.background;
  }
  backdrop.update(render.activeCamera, state, low);

  // The sun and its shadow box travel with the car.
  sun.target.position.set(state.x, state.y, state.z);
  sun.position.set(state.x - 35, state.y + 45, state.z - 25);
  sun.target.updateMatrixWorld();
}
