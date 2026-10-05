import { loadCameraView, restoreCameraView, saveCameraView } from '../camera-store.js';
import { CameraTarget, HeightField, Render, Time, Transform, Vehicle } from '../ecs/traits.js';
import { createBackdrop } from '../render/backdrop.js';
import { VIEW_HEIGHT } from '../render/scene.js';

// True isometric by default: the camera looks down the (-1, -1, -1) diagonal (azimuth 45°,
// elevation 35.3°). ?az=<degrees> starts the view turned around the car. Dragging with the mouse
// (or twisting two fingers) orbits; double-click resets. The last view (angle, tilt, zoom, follow
// mode) is saved and restored on the next visit; ?az and ?zoom override it.
const params = new URLSearchParams(globalThis.location?.search ?? '');
const DISTANCE = 60 * Math.sqrt(3);
const ISO_AZIMUTH = ((Number(params.get('az')) || 45) * Math.PI) / 180;
const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);
const MIN_ELEVATION = (12 * Math.PI) / 180;
const MAX_ELEVATION = (88 * Math.PI) / 180;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;
// Short (phone) screens start closer so the car is not tiny.
const defaultZoom = globalThis.innerHeight < 500 ? 1.7 : 1;
const saved = restoreCameraView(
  loadCameraView(),
  { azimuth: ISO_AZIMUTH, elevation: ISO_ELEVATION, zoom: defaultZoom, follow: false, followRelative: 0 },
  { minElevation: MIN_ELEVATION, maxElevation: MAX_ELEVATION, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM },
);
// ?az asks for a fixed angle, so it also starts with follow mode off.
if (params.has('az')) Object.assign(saved, { azimuth: ISO_AZIMUTH, follow: false });
if (Number(params.get('zoom'))) saved.zoom = Number(params.get('zoom'));
const view = { azimuth: saved.azimuth, elevation: saved.elevation };
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
// ?look=<dx>,<dz> shifts the view target (world metres), for close-up screenshots.
const LOOK = (params.get('look') ?? '0,0').split(',').map(Number);
const state = { x: 0, y: 0, z: 0, zoom: 1, userZoom: saved.zoom, ready: false };

// Follow ("helicopter") mode, toggled with C: the camera keeps the angle it had to the car when the
// mode was switched on and swings round behind the car's turns with a little lag, like a chase
// helicopter. Dragging still changes the angle (and the new angle is kept).
const follow = { on: saved.follow, relative: saved.followRelative, heading: null };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
let carAzimuth = 0; // the car's forward direction in the camera's azimuth convention
export function toggleFollowCamera() {
  follow.on = !follow.on;
  follow.relative = wrap(view.azimuth - carAzimuth);
  follow.heading = carAzimuth;
  rememberView();
  return follow.on;
}
export function isFollowCamera() {
  return follow.on;
}

// Saves the view a moment after it stops changing (drags and key orbits change it every frame).
let saveTimer = null;
function storeView() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saveCameraView({ azimuth: view.azimuth, elevation: view.elevation, zoom: state.userZoom, follow: follow.on, followRelative: follow.relative });
}
function rememberView() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(storeView, 300);
}

// Arrow keys with C held (see systems/input.js): x turns the view around the car, y raises or
// lowers it. In follow mode the new angle to the car is kept, as with a mouse drag.
const ORBIT_RATE = Math.PI / 2; // rad/s
const TILT_RATE = Math.PI / 4;
export function orbitCamera({ x, y }, dt) {
  if (!x && !y) return;
  view.azimuth += x * ORBIT_RATE * dt;
  follow.relative += x * ORBIT_RATE * dt;
  view.elevation = Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, view.elevation + y * TILT_RATE * dt));
  updateOffset();
  rememberView();
}

// Mouse wheel or trackpad pinch zooms in and out.
export function attachZoom(target = window) {
  target.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      state.userZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.userZoom * Math.exp(-e.deltaY * 0.0015)));
      rememberView();
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
      state.userZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.zoom * (spread(e.touches) / pinch.distance)));
      view.azimuth = pinch.azimuth + (twist(e.touches) - pinch.angle);
      updateOffset();
      rememberView();
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
    follow.relative += (e.clientX - drag.x) * 0.006;
    view.elevation = Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, view.elevation + (e.clientY - drag.y) * 0.005));
    drag = { x: e.clientX, y: e.clientY };
    updateOffset();
    rememberView();
  });
  const endDrag = (e) => {
    drag = null;
    target.releasePointerCapture?.(e.pointerId);
  };
  target.addEventListener('pointerup', endDrag);
  target.addEventListener('pointercancel', endDrag);
  target.addEventListener('contextmenu', (e) => e.preventDefault());
  target.addEventListener('dblclick', () => {
    follow.on = false;
    view.azimuth = ISO_AZIMUTH;
    view.elevation = ISO_ELEVATION;
    updateOffset();
    rememberView();
  });
  // Closing or reloading the page inside the save delay still keeps the last change.
  globalThis.addEventListener?.('pagehide', () => saveTimer && storeView());
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
  // The car's heading (forward axis flattened) as a camera azimuth: offset (cos az, sin az) points
  // from the car to the camera, so the forward direction (cos yaw, -sin yaw) is az = -yaw.
  const q = target.get(Transform).quaternion;
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  if (Math.hypot(fx, fz) > 0.2) carAzimuth = Math.atan2(fz, fx);
  if (follow.on) {
    follow.heading ??= carAzimuth; // follow mode restored from the saved view
    // The heading the camera tracks lags the car (about 0.6 s), so turns swing the view smoothly.
    follow.heading += wrap(carAzimuth - follow.heading) * (1 - Math.exp(-delta / 0.6));
    view.azimuth = follow.heading + follow.relative;
    updateOffset();
  }
  // Look ahead in the direction of travel so the car does not drift toward the screen edge.
  const v = target.get(Vehicle)?.body.linvel() ?? { x: 0, y: 0, z: 0 };
  const lead = 0.45;
  const k = 1 - Math.exp(-delta * 3.5);
  state.x += (position.x + LOOK[0] + v.x * lead - state.x) * k;
  state.y += (position.y - state.y) * k;
  state.z += (position.z + (LOOK[1] || 0) + v.z * lead - state.z) * k;

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
  backdrop ??= createBackdrop(render.scene, world.get(HeightField)?.heightAt?.world);
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
    render.scene.fog.color.copy(backdrop.horizon);
    render.scene.fog.near = 80;
    render.scene.fog.far = 210;
    render.scene.background = backdrop.horizon;
  } else {
    render.activeCamera = camera;
    render.scene.fog.color.copy(orthoFog.color);
    render.scene.fog.near = orthoFog.near;
    render.scene.fog.far = orthoFog.far;
    render.scene.background = orthoFog.background;
  }
  backdrop.update(render.activeCamera, state, low);

  // The sun and its shadow box travel with the car, moved in whole shadow-map texels (across the
  // light direction). A box that slides smoothly resamples every shadow edge at a new sub-texel
  // offset each frame, and the edges shimmer; snapped, they stay put as the car moves.
  const box = sun.shadow.camera;
  const texel = (box.right - box.left) / sun.shadow.mapSize.x;
  const a = Math.round((state.x * SUN_RIGHT[0] + state.y * SUN_RIGHT[1] + state.z * SUN_RIGHT[2]) / texel) * texel;
  const b = Math.round((state.x * SUN_UP[0] + state.y * SUN_UP[1] + state.z * SUN_UP[2]) / texel) * texel;
  const c = state.x * SUN_DIR[0] + state.y * SUN_DIR[1] + state.z * SUN_DIR[2];
  const tx = SUN_RIGHT[0] * a + SUN_UP[0] * b + SUN_DIR[0] * c;
  const ty = SUN_RIGHT[1] * a + SUN_UP[1] * b + SUN_DIR[1] * c;
  const tz = SUN_RIGHT[2] * a + SUN_UP[2] * b + SUN_DIR[2] * c;
  sun.target.position.set(tx, ty, tz);
  sun.position.set(tx - SUN_OFFSET[0], ty - SUN_OFFSET[1], tz - SUN_OFFSET[2]);
  sun.target.updateMatrixWorld();
}

// The sun shines along SUN_OFFSET (from the sun to the car); SUN_RIGHT and SUN_UP span the shadow
// map's plane.
const SUN_OFFSET = [35, -45, 25];
const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const SUN_DIR = norm(SUN_OFFSET);
const SUN_RIGHT = norm([-SUN_DIR[2], 0, SUN_DIR[0]]); // SUN_DIR × world up
const SUN_UP = [
  SUN_RIGHT[1] * SUN_DIR[2] - SUN_RIGHT[2] * SUN_DIR[1],
  SUN_RIGHT[2] * SUN_DIR[0] - SUN_RIGHT[0] * SUN_DIR[2],
  SUN_RIGHT[0] * SUN_DIR[1] - SUN_RIGHT[1] * SUN_DIR[0],
];
