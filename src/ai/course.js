// A course for the AI drivers: a centre line sampled every STEP m, with the way along it, its
// curvature, the half-width a car may use either side, and how fast it may be driven there.
// Built from a world that has one: the stadium's closed loop (heightAt.track); null elsewhere.
//
// Positions on it are (s, d): s m along the line from the start, d m across it, positive to the
// left going the right way round (as the stadium's own `d`).
import { LANE_HALF } from '../terrain/stadium.js';

export const STEP = 1; // m between samples
const CAR_HALF_WIDTH = 1.25; // m, over the tyres

// The stadium's features the drivers take slower (m/s at most): through the water hole, over the
// whoops and the rumble strip, and onto a pyramid (too fast and the truck flies into the rail).
const FEATURE_SPEED = { puddle: 9, whoops: 11, washboard: 13, tabletop: 10, bump: 13 };
// Features the truck is mostly in the air over, and LANDING m past them: no braking there, so it
// slows before them for what comes after (the top lane's pyramid lands in a corner).
const AIRBORNE = new Set(['tabletop']);
const LANDING = 6;

export function createCourse(heightAt) {
  if (!heightAt?.track) return null;
  const { segments, length } = heightAt.track;
  const n = Math.round(length / STEP);
  const step = length / n;
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  const curvature = new Float64Array(n); // 1/m, positive turning left
  const cap = new Float64Array(n).fill(Infinity); // m/s from the features
  const air = new Uint8Array(n); // 1 where it cannot brake (in the air)
  for (let i = 0; i < n; i++) {
    const p = pointOnTrack(segments, length, i * step);
    x[i] = p.x;
    z[i] = p.z;
    tx[i] = p.tx;
    tz[i] = p.tz;
    curvature[i] = p.curvature;
    const feature = heightAt.sample?.(p.x, p.z).feature;
    if (feature && FEATURE_SPEED[feature]) cap[i] = FEATURE_SPEED[feature];
    if (AIRBORNE.has(feature)) for (let k = 0; k <= LANDING / step; k++) air[(i + k) % n] = 1;
  }
  const course = {
    closed: true,
    length,
    step,
    n,
    x,
    z,
    tx,
    tz,
    curvature,
    cap,
    air,
    // How far a car's centre may go either side of the line and keep clear of the rails.
    halfWidth: LANE_HALF - CAR_HALF_WIDTH - 0.3,
    // s wrapped onto the loop, and the signed way from a to b (the short way round).
    wrap: (s) => ((s % length) + length) % length,
    delta: (a, b) => {
      let d = (b - a) % length;
      if (d > length / 2) d -= length;
      else if (d < -length / 2) d += length;
      return d;
    },
    // Point, way along (unit) and curvature at s, interpolated between samples.
    at(s, out = {}) {
      const u = course.wrap(s) / step;
      const i = Math.floor(u) % n;
      const j = (i + 1) % n;
      const f = u - Math.floor(u);
      out.x = x[i] + (x[j] - x[i]) * f;
      out.z = z[i] + (z[j] - z[i]) * f;
      const ux = tx[i] + (tx[j] - tx[i]) * f;
      const uz = tz[i] + (tz[j] - tz[i]) * f;
      const l = Math.hypot(ux, uz) || 1;
      out.tx = ux / l;
      out.tz = uz / l;
      out.curvature = curvature[i] + (curvature[j] - curvature[i]) * f;
      return out;
    },
    // Where (x, z) is on the course: { s, d }, searched near `hint` (the last s) when given, so a
    // car on one lane is not taken for one on the lane beside it.
    locate(px, pz, hint = null, out = {}) {
      let best = -1;
      let bestDist = Infinity;
      const scan = (i0, count) => {
        for (let k = 0; k < count; k++) {
          const i = (((i0 + k) % n) + n) % n;
          const dd = (px - x[i]) ** 2 + (pz - z[i]) ** 2;
          if (dd < bestDist) {
            bestDist = dd;
            best = i;
          }
        }
      };
      if (hint !== null) scan(Math.round(course.wrap(hint) / step) - 15, 31);
      // Lost (respawned, or the hint was off by more than the window): search the whole loop.
      if (hint === null || bestDist > 8 * 8) {
        bestDist = Infinity;
        scan(0, n);
      }
      // Refine between the nearest sample and its neighbours: project onto the tangent there.
      const along = (px - x[best]) * tx[best] + (pz - z[best]) * tz[best];
      const s = course.wrap(best * step + along);
      const p = course.at(s, tmp);
      out.s = s;
      out.d = (px - p.x) * p.tz - (pz - p.z) * p.tx;
      return out;
    },
  };
  return course;
}
const tmp = {};

// The stadium's centre line at s: point, unit way along, and curvature (1/m, positive left).
function pointOnTrack(segments, length, s) {
  for (const seg of segments) {
    let a = s - seg.s0;
    if (a < 0) a += length;
    if (a > seg.length) continue;
    if (seg.kind === 'line') return { x: seg.x0 + seg.tx * a, z: seg.z0 + seg.tz * a, tx: seg.tx, tz: seg.tz, curvature: 0 };
    const sign = Math.sign(seg.sweep);
    const ang = seg.a0 + (a / seg.r) * sign;
    // (Angles are atan2(z, x): turning toward +angle is turning toward +z, the right, so a positive
    // sweep turns right.)
    return { x: seg.cx + Math.cos(ang) * seg.r, z: seg.cz + Math.sin(ang) * seg.r, tx: -Math.sin(ang) * sign, tz: Math.cos(ang) * sign, curvature: -sign / seg.r };
  }
  throw new Error(`no segment at s = ${s}`);
}

// The fastest each point may be driven (m/s): no faster than `lateral` m/s² of cornering allows,
// nor `vMax`, nor the features' caps, and slow enough before each of those to brake down to it at
// `braking` m/s².
export function speedProfile(course, { lateral = 8, braking = 6, vMax = 22 } = {}) {
  const { n, step, curvature, cap, air } = course;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // The tightest curve within a car length either way (the samples cut corners a little).
    let k = 0;
    for (let j = -2; j <= 2; j++) k = Math.max(k, Math.abs(curvature[(i + j + n) % n]));
    v[i] = Math.min(vMax, cap[i], k > 1e-6 ? Math.sqrt(lateral / k) : Infinity);
  }
  // Braking back from every slow point (twice round, for the closed loop).
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 2 * n - 1; k >= 0; k--) {
      const i = k % n;
      const next = v[(i + 1) % n];
      v[i] = Math.min(v[i], air?.[i] ? next : Math.sqrt(next * next + 2 * braking * step));
    }
  }
  return v;
}

// Grid spot `n` at the start: two abreast, a row every GRID_ROW m back along the course from the
// start line (the player's car in spot 0, front left).
const GRID_ROW = 7.5;
const GRID_SIDE = 2.3;
export function gridSpot(course, n) {
  const p = course.at(-Math.floor(n / 2) * GRID_ROW);
  const d = n % 2 === 0 ? GRID_SIDE : -GRID_SIDE;
  // Left of the way round is (tz, -tx); yaw about +y, 0 facing +x.
  return { x: p.x + p.tz * d, z: p.z - p.tx * d, yaw: Math.atan2(-p.tz, p.tx) };
}
