// The camera view the player last left (angle around the car, tilt, zoom, follow mode), restored on
// the next visit. This is state, not a setting: it is saved whole, often, and the physics worker
// does not need it, so it bypasses settings-store's save listeners.
const STORAGE_KEY = 'drift.camera.v1';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// The saved view merged over `defaults`, with values that are missing, of the wrong type or out of
// range dropped or clamped. Angles are radians.
export function restoreCameraView(saved, defaults, { minElevation, maxElevation, minZoom, maxZoom }) {
  const view = { ...defaults };
  if (!saved || typeof saved !== 'object') return view;
  if (finite(saved.azimuth)) view.azimuth = Math.atan2(Math.sin(saved.azimuth), Math.cos(saved.azimuth));
  if (finite(saved.elevation)) view.elevation = Math.min(maxElevation, Math.max(minElevation, saved.elevation));
  if (finite(saved.zoom)) view.zoom = Math.min(maxZoom, Math.max(minZoom, saved.zoom));
  if (typeof saved.follow === 'boolean') view.follow = saved.follow;
  if (finite(saved.followRelative)) view.followRelative = saved.followRelative;
  return view;
}

export function loadCameraView() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function saveCameraView(view) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage can be unavailable (private mode); the view still works for this session.
  }
}
