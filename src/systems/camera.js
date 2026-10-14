import { clearanceElevation } from '../camera-clearance.js';
import { loadCameraView, restoreCameraView, saveCameraView } from '../camera-store.js';
import { CameraTarget, HeightField, Render, Time, Transform, Vehicle } from '../ecs/traits.js';
import { createBackdrop } from '../render/backdrop.js';
import { SUN_DISTANCE, VIEW_HEIGHT } from '../render/scene.js';

// Isometric by default: the camera looks down at 35.3° (the isometric elevation), following behind
// the car (follow mode, C toggles it; off, it looks down the (-1, -1, -1) diagonal, azimuth 45°). ?az=<degrees> starts the view turned around the car. Dragging with the mouse
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
  // Follow mode is on at first, from behind the car.
  { azimuth: ISO_AZIMUTH, elevation: ISO_ELEVATION, zoom: defaultZoom, follow: true, followRelative: Math.PI },
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
// The elevation the camera actually flies at: the chosen one, or higher while a ridge or mesa
// between the camera and the car would hide the car (see followCamera).
let clearance = 0;
function updateOffset() {
  const elevation = Math.max(view.elevation, clearance);
  const h = DISTANCE * Math.cos(elevation);
  offset.x = h * Math.cos(view.azimuth);
  offset.y = DISTANCE * Math.sin(elevation);
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
  // Double-click: back to the default view, following from behind at the isometric elevation.
  target.addEventListener('dblclick', () => {
    follow.on = true;
    follow.relative = Math.PI;
    follow.heading = carAzimuth;
    view.azimuth = carAzimuth + Math.PI;
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
  }
  // Climb over terrain that would block the view of the car: quickly up, slowly back down, so the
  // camera does not bob over every crest. The ground counts out to where the camera is (the
  // perspective camera sits closer than the orthographic one).
  const heightAt = world.get(HeightField)?.heightAt;
  if (heightAt) {
    const low = view.elevation < PERSPECTIVE_BELOW;
    const reach = low ? VIEW_HEIGHT / state.zoom / 2 / Math.tan((world.get(Render).perspective.fov * Math.PI) / 360) : DISTANCE;
    const need = Math.min(MAX_ELEVATION, clearanceElevation(heightAt, position.x, position.y, position.z, view.azimuth, reach * Math.cos(view.elevation)));
    clearance += (need - clearance) * (1 - Math.exp(-delta / (need > clearance ? 0.15 : 1.2)));
  }
  updateOffset();
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
  // The haze and background colours come from the time of day (render/daylight.js).
  const { daylight } = render;
  if (low) {
    const persp = render.perspective;
    const d = VIEW_HEIGHT / state.zoom / 2 / Math.tan((persp.fov * Math.PI) / 360);
    const inv = 1 / DISTANCE;
    let px = state.x + offset.x * inv * d;
    let py = state.y + offset.y * inv * d;
    let pz = state.z + offset.z * inv * d;
    if (heightAt) py = Math.max(py, heightAt(px, pz) + 1.5);
    persp.position.set(px, py, pz);
    persp.lookAt(state.x, state.y + 0.6, state.z);
    render.activeCamera = persp;
    // The camera looks straight at the point it follows, so that is the distance to focus at.
    render.focusDistance = Math.hypot(px - state.x, py - state.y - 0.6, pz - state.z);
  } else {
    render.activeCamera = camera;
    render.focusDistance = DISTANCE;
  }
  if (daylight) {
    const haze = low ? daylight.horizon : daylight.background;
    render.scene.fog.color.copy(haze);
    [render.scene.fog.near, render.scene.fog.far] = low ? daylight.perspectiveFog : daylight.orthoFog;
    render.scene.background = haze;
  }
  backdrop.update(render.activeCamera, state, low);

  // The sun (or moon) and its shadow box travel with the car, moved in whole shadow-map texels
  // (across the light direction). A box that slides smoothly resamples every shadow edge at a new
  // sub-texel offset each frame, and the edges shimmer; snapped, they stay put as the car moves.
  const [dir, right, up] = lightBasis(daylight?.lightDirection ?? DEFAULT_LIGHT);
  const box = sun.shadow.camera;
  const texel = (box.right - box.left) / sun.shadow.mapSize.x;
  const a = Math.round((state.x * right[0] + state.y * right[1] + state.z * right[2]) / texel) * texel;
  const b = Math.round((state.x * up[0] + state.y * up[1] + state.z * up[2]) / texel) * texel;
  const c = state.x * dir[0] + state.y * dir[1] + state.z * dir[2];
  const tx = right[0] * a + up[0] * b + dir[0] * c;
  const ty = right[1] * a + up[1] * b + dir[1] * c;
  const tz = right[2] * a + up[2] * b + dir[2] * c;
  sun.target.position.set(tx, ty, tz);
  sun.position.set(tx + dir[0] * SUN_DISTANCE, ty + dir[1] * SUN_DISTANCE, tz + dir[2] * SUN_DISTANCE);
  sun.target.updateMatrixWorld();
}

// Toward the light, and two directions across it that span the shadow map's plane.
const DEFAULT_LIGHT = { x: -0.5, y: 0.7, z: -0.4 };
function lightBasis({ x, y, z }) {
  const l = Math.hypot(x, y, z);
  const dir = [x / l, y / l, z / l];
  const h = Math.hypot(dir[0], dir[2]) || 1;
  const right = [-dir[2] / h, 0, dir[0] / h];
  const up = [
    right[1] * dir[2] - right[2] * dir[1],
    right[2] * dir[0] - right[0] * dir[2],
    right[0] * dir[1] - right[1] * dir[0],
  ];
  return [dir, right, up];
}
