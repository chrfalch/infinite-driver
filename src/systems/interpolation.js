// Render interpolation. Physics runs at 120 Hz in batches that finish at uneven moments, so each
// animation frame would otherwise show the car 0, 1, 2 or 3 steps further on, and at speed the
// uneven jumps read as blur. Instead every step's pose is kept with its simulation time, and the
// car is drawn at a display time that advances smoothly a little behind the newest step.

const SIZE = 8; // poses kept per body (more than a batch's worth of steps)
const TELEPORT = 5; // metres between two steps that count as a respawn, not motion

export function createPoseHistory() {
  return {
    poses: Array.from({ length: SIZE }, () => ({ t: 0, x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 })),
    head: -1, // index of the newest pose
    count: 0,
  };
}

// Records the pose of a body at simulation time t.
export function pushPose(history, t, p, q) {
  const newest = history.count ? history.poses[history.head] : null;
  // A teleport restarts the history, so the car never slides from its old place.
  if (newest && Math.hypot(p.x - newest.x, p.y - newest.y, p.z - newest.z) > TELEPORT) history.count = 0;
  history.head = (history.head + 1) % SIZE;
  history.count = Math.min(history.count + 1, SIZE);
  const s = history.poses[history.head];
  s.t = t;
  s.x = p.x;
  s.y = p.y;
  s.z = p.z;
  s.qx = q.x;
  s.qy = q.y;
  s.qz = q.z;
  s.qw = q.w;
}

// Pose at time t, interpolated between the recorded poses around it (clamped to the oldest and
// newest). Writes into out = { position: {x,y,z}, quaternion: {x,y,z,w} }; false if empty.
export function samplePose(history, t, out) {
  if (!history.count) return false;
  let b = history.poses[history.head];
  let a = b;
  for (let k = 1; k < history.count && a.t > t; k++) {
    b = a;
    a = history.poses[(history.head - k + SIZE) % SIZE];
  }
  const span = b.t - a.t;
  const f = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 1;
  out.position.x = a.x + (b.x - a.x) * f;
  out.position.y = a.y + (b.y - a.y) * f;
  out.position.z = a.z + (b.z - a.z) * f;
  // Normalised lerp along the shorter arc: steps are 8 ms apart, so this is as good as slerp.
  const sign = a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw < 0 ? -1 : 1;
  const qx = a.qx + (b.qx * sign - a.qx) * f;
  const qy = a.qy + (b.qy * sign - a.qy) * f;
  const qz = a.qz + (b.qz * sign - a.qz) * f;
  const qw = a.qw + (b.qw * sign - a.qw) * f;
  const len = Math.hypot(qx, qy, qz, qw) || 1;
  out.quaternion.x = qx / len;
  out.quaternion.y = qy / len;
  out.quaternion.z = qz / len;
  out.quaternion.w = qw / len;
  return true;
}

// Advances the display time by the frame's delta and steers it gently toward `lag` behind the
// newest simulated time, so it runs at the average physics rate (also when physics falls behind)
// without copying the physics' batch-to-batch unevenness. Hard limits keep it inside the history.
export function advanceDisplayTime(display, latest, delta, step, lag = 1.5 * step) {
  let t = display + delta;
  const error = latest - lag - t;
  // Far off (start, respawn, a long stall): jump; otherwise correct over about 0.2 s.
  if (Math.abs(error) > 6 * step) t = latest - lag;
  else t += error * Math.min(1, delta * 5);
  return Math.min(latest, Math.max(latest - 4 * step, t));
}
