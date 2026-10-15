// Stadium: a closed dirt circuit after the arcade game Super Off Road (Leland, 1989). One lap of
// switchback lanes on a level arena floor, each lane walled in by low red-and-white barriers, with
// tabletop and double jumps, whoops, a rumble strip and a water hole on the straights, and dirt
// mounds on the dead ground between the lanes. Unlike the other worlds it is not endless: the arena
// is a finite floor ringed by a concrete wall, and outside it the ground stays level.
//
// The track is data, not noise: a closed polyline of corners (LAYOUT), each rounded off with its
// own radius, so a lane is a run of straight lines and circular arcs. heightAt finds the nearest
// point on it (its distance across, `d`, positive to the left going the right way round, and its
// distance along, `s`) and shapes the ground from those: the features by `s` across the lane's
// width, a little banking on the outside of the corners, and level ground beyond. Physics, the GPU
// tyre grid, tracks and the ground mesh all take it from here, as in the other worlds.
//
// The barriers are not ground: they are thin walls (`heightAt.barriers`, pieces about 2 m long)
// that the physics makes fixed colliders of and the renderer draws as striped rails. Ground berms
// would launch the car; walls stop it and let it scrape along.
//
// The layout is shifted so the start, on the bottom straight, is the origin, facing +x.

export const LANE_HALF = 5; // m of track either side of the centre line
export const BARRIER = Object.freeze({ offset: LANE_HALF + 0.35, height: 1.1, thick: 0.3, piece: 2 });
export const ARENA_WALL = Object.freeze({ height: 2.6, thick: 0.6, margin: 14 }); // margin: m beyond the outermost lane's centre
export const WATER_LEVEL = -0.3; // m: the water holes' surface (the floor is at 0)
const PUDDLE_DEPTH = 0.6; // m below the floor, so 0.3 m of water

// Corners of the loop (m), the way round, with the radius each is rounded to. The bottom straight
// runs +x from the first corner; the start is START along it.
const LAYOUT = [
  [-75, 45, 12],
  [75, 45, 12],
  [75, -45, 12],
  [-75, -45, 12],
  [-75, -15, 10],
  [45, -15, 15], // the hairpin: two quarter turns 30 m apart make one sweeping half circle
  [45, 15, 15],
  [-75, 15, 10],
];
const START = { x: -30, z: 45 };

// Features by straight (the straight that leaves corner `leg`), `at` m along it from where the
// straight begins (after the corner's arc).
const FEATURES = [
  { kind: 'washboard', leg: 0, at: 62, length: 16, height: 0.13, pitch: 2 },
  { kind: 'whoops', leg: 0, at: 84, count: 5, height: 0.3, pitch: 6 },
  { kind: 'tabletop', leg: 1, at: 12, up: 7, top: 12, down: 11, height: 1.5 },
  { kind: 'double', leg: 2, at: 22, up: 6, down: 6, gap: 3, height: 1.2 },
  { kind: 'puddle', leg: 2, at: 82, length: 16 },
  { kind: 'tabletop', leg: 4, at: 26, up: 8, top: 2, down: 12, height: 1.6 }, // the pyramid
  { kind: 'puddle', leg: 4, at: 66, length: 12 },
  { kind: 'whoops', leg: 6, at: 16, count: 5, height: 0.3, pitch: 6 },
  { kind: 'washboard', leg: 6, at: 68, length: 14, height: 0.13, pitch: 2 },
];

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function hash2(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// The loop as lines and arcs, each { kind, s0, length, ... }, s0 its distance along from the
// start. A line: from (x0, z0) along the unit (tx, tz). An arc: round (cx, cz) of radius r, from
// angle a0 turning by sweep (radians, signed; angles measured as atan2(z, x)).
export function buildTrack(layout = LAYOUT, start = START) {
  const n = layout.length;
  const pts = layout.map(([x, z, r]) => ({ x: x - start.x, z: z - start.z, r }));
  const unit = (a, b) => {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    return { x: dx / l, z: dz / l };
  };
  // Each corner's arc: in and out directions, tangent points.
  const corners = pts.map((p, i) => {
    const a = unit(pts[(i + n - 1) % n], p);
    const b = unit(p, pts[(i + 1) % n]);
    const turn = Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z);
    const t = p.r * Math.tan(Math.abs(turn) / 2);
    const entry = { x: p.x - a.x * t, z: p.z - a.z * t };
    const exit = { x: p.x + b.x * t, z: p.z + b.z * t };
    // The centre is on the side the track turns to.
    const side = Math.sign(turn);
    const c = { x: entry.x - a.z * side * p.r, z: entry.z + a.x * side * p.r };
    return { entry, exit, c, r: p.r, a0: Math.atan2(entry.z - c.z, entry.x - c.x), sweep: turn };
  });
  const segments = [];
  const legs = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    const from = corners[i].exit;
    const to = corners[(i + 1) % n].entry;
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    legs.push({ s0: s, length });
    // (Two quarter turns may meet with no straight between them.)
    if (length > 1e-6) segments.push({ kind: 'line', s0: s, length, x0: from.x, z0: from.z, tx: (to.x - from.x) / length, tz: (to.z - from.z) / length });
    s += length;
    const c = corners[(i + 1) % n];
    const arc = Math.abs(c.sweep) * c.r;
    segments.push({ kind: 'arc', s0: s, length: arc, cx: c.c.x, cz: c.c.z, r: c.r, a0: c.a0, sweep: c.sweep });
    s += arc;
  }
  // Start the count at the origin (the start), which is on the first straight.
  const s0 = -segments[0].x0 * segments[0].tx - segments[0].z0 * segments[0].tz;
  for (const seg of segments) seg.s0 = (seg.s0 - s0 + s) % s;
  for (const leg of legs) leg.s0 = (leg.s0 - s0 + s) % s;
  return { segments, legs, length: s };
}

// Nearest point on a segment to (x, z): its distance `dist`, signed distance across `d` (left of
// the way round positive), distance along the loop `s`, the direction (tx, tz) there, and on arcs
// the share of the way through the corner `u` (-1 on lines).
function nearestOn(seg, x, z, out) {
  if (seg.kind === 'line') {
    const along = Math.min(seg.length, Math.max(0, (x - seg.x0) * seg.tx + (z - seg.z0) * seg.tz));
    const qx = seg.x0 + seg.tx * along;
    const qz = seg.z0 + seg.tz * along;
    out.dist = Math.hypot(x - qx, z - qz);
    out.d = (x - qx) * seg.tz - (z - qz) * seg.tx;
    out.along = along;
    out.tx = seg.tx;
    out.tz = seg.tz;
    out.u = -1;
    return out;
  }
  const sign = Math.sign(seg.sweep);
  const a = Math.atan2(z - seg.cz, x - seg.cx);
  let k = wrap(a - seg.a0) * sign;
  if (k < -0.5 * (2 * Math.PI - Math.abs(seg.sweep))) k += 2 * Math.PI;
  k = Math.min(Math.abs(seg.sweep), Math.max(0, k));
  const ang = seg.a0 + k * sign;
  const qx = seg.cx + Math.cos(ang) * seg.r;
  const qz = seg.cz + Math.sin(ang) * seg.r;
  // Direction of travel round the arc.
  const tx = -Math.sin(ang) * sign;
  const tz = Math.cos(ang) * sign;
  out.dist = Math.hypot(x - qx, z - qz);
  out.d = (x - qx) * tz - (z - qz) * tx;
  out.along = k * seg.r;
  out.tx = tx;
  out.tz = tz;
  out.u = k / Math.abs(seg.sweep);
  return out;
}

// Lift of one feature at `u` m from its start (null outside it).
function featureLift(f, u) {
  if (f.kind === 'tabletop') {
    if (u < 0 || u > f.up + f.top + f.down) return null;
    // A curved kicker steepening toward the lip, a flat top, a straight landing.
    if (u < f.up) return f.height * (u / f.up) ** 1.5;
    if (u < f.up + f.top) return f.height;
    return f.height * smoothstep(f.up + f.top + f.down, f.up + f.top, u);
  }
  if (f.kind === 'double') {
    const one = f.up + f.down;
    const hump = (v) => (v < 0 || v > one ? 0 : v < f.up ? f.height * (v / f.up) ** 1.4 : f.height * smoothstep(one, f.up, v));
    if (u < 0 || u > 2 * one + f.gap) return null;
    return Math.max(hump(u), hump(u - one - f.gap));
  }
  if (f.kind === 'whoops') {
    const span = f.count * f.pitch;
    if (u < 0 || u > span) return null;
    const c = Math.sin((Math.PI * u) / f.pitch);
    return f.height * c * c;
  }
  if (f.kind === 'washboard') {
    if (u < 0 || u > f.length) return null;
    const c = Math.sin((Math.PI * u) / f.pitch);
    return f.height * c * c * smoothstep(0, 1.5, u) * smoothstep(f.length, f.length - 1.5, u);
  }
  if (f.kind === 'puddle') {
    if (u < -2 || u > f.length + 2) return null;
    return -PUDDLE_DEPTH * smoothstep(-2, 1, u) * smoothstep(f.length + 2, f.length - 1, u);
  }
  return null;
}

// The striped barriers either side of every lane and the arena's concrete wall, as pieces
// { kind: 'rail' | 'wall', x, z, yaw, length, height, thick, stripe, run } (yaw about +y, 0 along
// +x; stripe 0 or 1 alternates the rails' red and white; `run` numbers the straight lines of pieces
// (one side of a straight, one side of the arena) that physics makes one collider of, null on arcs).
function buildBarriers(track, arena) {
  const pieces = [];
  let stripe = 0;
  let runs = 0;
  for (const seg of track.segments) {
    for (const side of [-1, 1]) {
      const run = seg.kind === 'line' ? runs++ : null;
      const off = side * BARRIER.offset;
      if (seg.kind === 'line') {
        const count = Math.max(1, Math.round(seg.length / BARRIER.piece));
        const len = seg.length / count;
        for (let i = 0; i < count; i++) {
          const along = (i + 0.5) * len;
          // Left of the way round is (tz, -tx).
          const x = seg.x0 + seg.tx * along + seg.tz * off;
          const z = seg.z0 + seg.tz * along - seg.tx * off;
          pieces.push({ kind: 'rail', x, z, yaw: Math.atan2(-seg.tz, seg.tx), length: len + 0.04, height: BARRIER.height, thick: BARRIER.thick, stripe: (stripe + i) % 2, run });
        }
      } else {
        const sign = Math.sign(seg.sweep);
        // Left of the way round is toward the centre when turning toward +angle.
        const r = seg.r + (sign > 0 ? off : -off);
        const arc = Math.abs(seg.sweep) * r;
        const count = Math.max(1, Math.round(arc / BARRIER.piece));
        for (let i = 0; i < count; i++) {
          const ang = seg.a0 + ((i + 0.5) / count) * seg.sweep;
          const x = seg.cx + Math.cos(ang) * r;
          const z = seg.cz + Math.sin(ang) * r;
          const tx = -Math.sin(ang) * sign;
          const tz = Math.cos(ang) * sign;
          // A chord a little longer than the arc piece, so the joints close.
          pieces.push({ kind: 'rail', x, z, yaw: Math.atan2(-tz, tx), length: (arc / count) * 1.04 + 0.04, height: BARRIER.height, thick: BARRIER.thick, stripe: (stripe + i) % 2, run });
        }
      }
    }
    stripe = 1 - stripe;
  }
  // The arena wall, all round.
  const { x0, x1, z0, z1 } = arena;
  for (const [ax, az, bx, bz] of [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]]) {
    const length = Math.hypot(bx - ax, bz - az);
    const count = Math.ceil(length / 8);
    const run = runs++;
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      pieces.push({ kind: 'wall', x: ax + (bx - ax) * t, z: az + (bz - az) * t, yaw: Math.atan2(-(bz - az), bx - ax), length: length / count + ARENA_WALL.thick, height: ARENA_WALL.height, thick: ARENA_WALL.thick, stripe: 0, run });
    }
  }
  return pieces;
}

// The barriers as solid boxes { kind, x, z, yaw, length, thick, bottom, top } for the physics and
// the tyres. A straight line of pieces on level ground is one box from end to end: joints between
// boxes would catch a wheel scraping along. Pieces round the corners, and over the ramps where the
// ground under them changes, stay pieces. Each reaches SINK below the ground.
const SINK = 0.3;
const LEVEL = 0.03; // m the ground under a line of pieces may vary
function barrierBoxes(pieces, heightAt) {
  const boxes = [];
  const box = (p, x, z, length, low, high) => boxes.push({ kind: p.kind, x, z, yaw: p.yaw, length, thick: p.thick, bottom: low - SINK, top: high + p.height });
  let run = null;
  const flush = () => {
    if (!run) return;
    const { first, last } = run;
    const ends = Math.hypot(last.x - first.x, last.z - first.z);
    box(first, (first.x + last.x) / 2, (first.z + last.z) / 2, ends + (first.length + last.length) / 2, run.low, run.high);
    run = null;
  };
  for (const p of pieces) {
    const ground = heightAt(p.x, p.z);
    const joins = run && p.run !== null && p.run === run.first.run && Math.max(run.high, ground) - Math.min(run.low, ground) < LEVEL;
    if (!joins) flush();
    if (p.run === null) {
      box(p, p.x, p.z, p.length, ground, ground);
      continue;
    }
    if (!run) run = { first: p, last: p, low: ground, high: ground };
    run.last = p;
    run.low = Math.min(run.low, ground);
    run.high = Math.max(run.high, ground);
  }
  flush();
  return boxes;
}

// A box as a rock for the GPU tyres (tire/gpu-tires.js updateGpuRocks): its eight corners, and its
// distance from a point on the ground, so a long one is picked when the car is beside it.
function boxRock(b) {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const vertices = new Float32Array(24);
  let i = 0;
  for (const u of [-b.length / 2, b.length / 2]) {
    for (const v of [-b.thick / 2, b.thick / 2]) {
      for (const y of [b.bottom, b.top]) {
        // Local x along the box (yaw about +y: x -> (cos, -sin)), local z across.
        vertices.set([b.x + u * c + v * s, y, b.z - u * s + v * c], i);
        i += 3;
      }
    }
  }
  const distanceTo = (x, z) => {
    const dx = x - b.x;
    const dz = z - b.z;
    const u = Math.max(0, Math.abs(dx * c - dz * s) - b.length / 2);
    const v = Math.max(0, Math.abs(dx * s + dz * c) - b.thick / 2);
    return Math.hypot(u, v);
  };
  return { x: b.x, z: b.z, size: b.thick, vertices, distanceTo };
}

export function createStadiumField() {
  const track = buildTrack();
  const { segments, legs } = track;
  const features = FEATURES.map((f) => ({ ...f, s0: (legs[f.leg].s0 + f.at) % track.length }));

  // The arena floor: the lanes' extent plus a margin, walled in.
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const seg of segments) {
    const ends = seg.kind === 'line' ? [[seg.x0, seg.z0], [seg.x0 + seg.tx * seg.length, seg.z0 + seg.tz * seg.length]] : [[seg.cx - seg.r, seg.cz - seg.r], [seg.cx + seg.r, seg.cz + seg.r]];
    for (const [x, z] of ends) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
  }
  const m = ARENA_WALL.margin;
  const arena = { x0: x0 - m, x1: x1 + m, z0: z0 - m, z1: z1 + m };

  const near = { dist: 0, d: 0, along: 0, tx: 1, tz: 0, u: -1 };
  const best = { dist: 0, d: 0, s: 0, tx: 1, tz: 0, u: -1, seg: null };
  function nearest(x, z) {
    best.dist = Infinity;
    for (const seg of segments) {
      nearestOn(seg, x, z, near);
      if (near.dist < best.dist) {
        best.dist = near.dist;
        best.d = near.d;
        best.s = (seg.s0 + near.along) % track.length;
        best.tx = near.tx;
        best.tz = near.tz;
        best.u = near.u;
        best.seg = seg;
      }
    }
    return best;
  }

  // Lift of the features at `s` along the loop.
  function liftAt(s) {
    for (const f of features) {
      let u = s - f.s0;
      if (u < -track.length / 2) u += track.length;
      else if (u > track.length / 2) u -= track.length;
      const lift = featureLift(f, u);
      if (lift !== null) return { lift, kind: f.kind };
    }
    return null;
  }

  // Mounds on the dead ground between the lanes: rounded humps on a jittered 14 m grid, kept
  // behind the barriers.
  function mounds(x, z) {
    const cell = 14;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let h = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const hx = cx + i;
        const hz = cz + j;
        if (hash2(hx, hz, 7) > 0.45) continue;
        const px = (hx + 0.2 + 0.6 * hash2(hx, hz, 8)) * cell;
        const pz = (hz + 0.2 + 0.6 * hash2(hx, hz, 9)) * cell;
        const radius = 2.5 + 2.5 * hash2(hx, hz, 10);
        const q = Math.hypot(x - px, z - pz) / radius;
        if (q >= 1) continue;
        const c = Math.cos((q * Math.PI) / 2);
        h = Math.max(h, (0.5 + 1.1 * hash2(hx, hz, 11)) * c * c);
      }
    }
    return h;
  }

  function sample(x, z) {
    const n = nearest(x, z);
    const ad = Math.abs(n.d);
    const lane = 1 - smoothstep(LANE_HALF, LANE_HALF + 1.5, ad);
    let h = 0;
    let puddle = 0;
    let feature = null;
    const f = lane > 0 ? liftAt(n.s) : null;
    if (f) {
      feature = f.kind;
      if (f.kind === 'puddle') {
        // The hole keeps to the lane (its sides steep under the barriers), so the water shows only there.
        const inside = 1 - smoothstep(LANE_HALF - 0.5, LANE_HALF + 0.3, ad);
        h += f.lift * inside;
        puddle = inside * smoothstep(0, -PUDDLE_DEPTH * 0.5, f.lift);
      } else h += f.lift * lane;
    }
    // Banked corners: the outside of the lane rises up to 35 cm at the barrier, eased in and out.
    if (n.u >= 0 && ad < LANE_HALF + 1.5) {
      const outward = n.seg.sweep > 0 ? n.d : -n.d;
      const ease = smoothstep(0, 0.25, n.u) * smoothstep(1, 0.75, n.u);
      h += 0.35 * smoothstep(0, LANE_HALF, outward) * ease * lane + 0.35 * ease * (1 - lane) * (outward > 0 ? 1 : 0) * smoothstep(LANE_HALF + 3, LANE_HALF + 1.5, ad);
    }
    // The dead ground: mounds, kept behind the barriers and inside the arena.
    const dead = smoothstep(LANE_HALF + 1.5, LANE_HALF + 3.5, ad);
    const inArena = x > arena.x0 + 4 && x < arena.x1 - 4 && z > arena.z0 + 4 && z < arena.z1 - 4;
    const mound = dead > 0 && inArena ? mounds(x, z) * dead : 0;
    h += mound;
    return { h, d: n.d, dist: ad, s: n.s, tx: n.tx, tz: n.tz, lane, puddle, mound, feature, arena: inArena ? 1 : 0 };
  }

  const heightAt = (x, z) => sample(x, z).h;
  heightAt.sample = sample;
  // What the tyres stand on: the lanes are graded and packed by the racing (a little firmer than
  // the loose dirt of the dead ground); there is no rock.
  heightAt.groundAt = (x, z, out = { road: 0, rock: 0 }) => {
    const s = sample(x, z);
    out.road = 0.5 * s.lane * (1 - s.puddle);
    out.rock = 0;
    return out;
  };
  heightAt.roadDistance = (x, z) => nearest(x, z).dist;
  // Heading (radians about +y, 0 = +x) the way round the loop.
  heightAt.roadHeading = (x, z) => {
    const n = nearest(x, z);
    return Math.atan2(-n.tz, n.tx);
  };
  // Respawns face the way round, not whichever way the car was facing.
  heightAt.oneWay = true;
  heightAt.waterLevel = WATER_LEVEL;
  heightAt.track = track;
  heightAt.arena = arena;
  heightAt.barriers = buildBarriers(track, arena);
  heightAt.barrierBoxes = barrierBoxes(heightAt.barriers, heightAt);
  // The tyres feel the rails as well as the ground (they do not collide with Rapier's colliders).
  heightAt.barrierRocks = heightAt.barrierBoxes.filter((b) => b.kind === 'rail').map(boxRock);
  heightAt.world = 'stadium';
  return heightAt;
}
