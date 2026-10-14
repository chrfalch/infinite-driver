// Dry river: the course markers along the bed, set out like a trial's: a mark every MARK_SPACING m
// along each bed, on its two banks in turn, standing on the tops of the boulder walls so they line
// the bed without standing in it. A mark is
// - a flag on a pole flying out from the bed (red on the left bank, yellow on the right, looking up
//   the bed toward +x),
// - a chevron board where the bed bends tighter than CHEVRON_RADIUS and the mark is on the outside
//   of the bend (its arrows point into the bend, for drivers either way),
// - or a stack of tyres where the bed narrows to a gap (half-width under GAP_WIDTH), on both banks
//   at its ends.
// A start gantry spans the bed just ahead of where the car starts.
//
// Every chunk's marks come from its position alone (each mark belongs to the chunk its point on the
// bed's centre line is in). A mark: { kind: 'flag' | 'chevron' | 'tyres' | 'gantry', x, y, z, yaw, ... }
// with y the ground under it; yaw turns its front (+z) about +y.
import { CHUNK_SIZE } from './chunk.js';

export const MARK_SPACING = 7; // m along the bed between marks (so 14 m between marks on one bank)
export const CHEVRON_RADIUS = 28; // m: bends tighter than this get chevrons on their outside
export const GAP_WIDTH = 2.2; // m of half-width: a gap, marked with tyres
// How far out from the bed's edge the marks stand: on the wall tops (the walls rise from about
// 0.6 m to 2.4 m past the edge of a bed of the usual width, bankDistance in riverbed.js).
export const MARK_OFFSET = 3.2;
const GANTRY_MARK = 2; // the mark on bed 0 (from the start, at s = 0) the start gantry replaces
const GANTRY_CLEAR = 4.6; // m from the bed's floor up to the underside of its banner

const LOOK = 6; // m along the bed either side, to measure its bend

export function generateTrackMarkers(heightAt, cx, cz) {
  const beds = heightAt.beds;
  if (!beds) return [];
  const marks = [];
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const x1 = x0 + CHUNK_SIZE;
  const z1 = z0 + CHUNK_SIZE;
  // The beds whose centre lines may cross this chunk.
  const a = [beds.across(x0, z0), beds.across(x1, z0), beds.across(x0, z1), beds.across(x1, z1)];
  const k0 = Math.ceil((Math.min(...a) - 30) / beds.spacing);
  const k1 = Math.floor((Math.max(...a) + 30) / beds.spacing);
  for (let k = k0; k <= k1; k++) {
    // Walk the centre line across the chunk a metre of x at a time, and set a mark where the way
    // along it passes a multiple of MARK_SPACING.
    let z = beds.centre(x0 - 1, k);
    let last = Math.floor(beds.along(x0 - 1, k) / MARK_SPACING);
    for (let x = x0; x < x1; x++) {
      z = beds.centre(x, k, z);
      const s = beds.along(x, k);
      const n = Math.floor(s / MARK_SPACING);
      if (n === last) continue;
      last = n;
      if (z < z0 || z >= z1) continue;
      markAt(heightAt, k, n, x, z, marks);
    }
  }
  return marks;
}

// The bed's centre line at `s` along bed k: its point, the unit way along it (toward +x) and the
// unit normal to its left.
function lineAt(beds, s, k, x, z) {
  // From a nearby point (x, z) on the line, step along it to s (x grows along the bed).
  for (let i = 0; i < 3; i++) {
    const ds = s - beds.along(x, k);
    if (Math.abs(ds) < 0.01) break;
    const zn = beds.centre(x + 0.5, k, z);
    const step = Math.hypot(0.5, zn - z);
    x += (ds * 0.5) / step;
    z = beds.centre(x, k, z);
  }
  const zn = beds.centre(x + 0.25, k, z);
  const l = Math.hypot(0.25, zn - z);
  const tx = 0.25 / l;
  const tz = (zn - z) / l;
  // (Facing +x with +y up, the left is -z.)
  return { x, z, tx, tz, nx: tz, nz: -tx };
}

// Mark n on bed k, from (x, z) on its centre line a little past it.
function markAt(heightAt, k, n, x, z, marks) {
  const beds = heightAt.beds;
  const s = n * MARK_SPACING;
  const p = lineAt(beds, s, k, x, z);
  const width = beds.width(s, k);
  // The bed's bend: its heading's turn per metre between LOOK m before and after (left positive).
  const before = lineAt(beds, s - LOOK, k, p.x - LOOK * p.tx, p.z - LOOK * p.tz);
  const after = lineAt(beds, s + LOOK, k, p.x + LOOK * p.tx, p.z + LOOK * p.tz);
  const turn = Math.atan2(before.tx * after.tz - before.tz * after.tx, before.tx * after.tx + before.tz * after.tz);
  // (A positive cross product turns toward +z, the right; `curve` is positive to the left.)
  const curve = -turn / (2 * LOOK);
  // Even marks on the left bank, odd on the right (side +1 left, -1 right).
  const side = n % 2 === 0 ? 1 : -1;
  const out = width + MARK_OFFSET;
  const at = (sd, off = out) => {
    const mx = p.x + p.nx * sd * off;
    const mz = p.z + p.nz * sd * off;
    return { x: mx, y: heightAt(mx, mz), z: mz };
  };
  // Facing back down the bed (toward drivers coming up it): its +x is then the bed's right.
  const facing = Math.atan2(-p.tx, -p.tz);

  if (k === 0 && n === GANTRY_MARK) {
    // The start gantry: its two towers on the wall tops, its banner over the bed's highest floor
    // within a few metres.
    const half = width + MARK_OFFSET - 0.8;
    let floor = -Infinity;
    for (let d = -3; d <= 3; d += 0.5) floor = Math.max(floor, beds.floor(s + d, k));
    // Its feet: left (-x as it faces), right (+x).
    const feet = [1, -1].map((sd) => at(sd, half).y);
    marks.push({ kind: 'gantry', x: p.x, y: Math.min(...feet), z: p.z, yaw: facing, half, top: floor + GANTRY_CLEAR, feet });
  } else if (width < GAP_WIDTH) {
    // A gap: tyres instead of flags, closer in (the walls stand close), and on both banks at its
    // ends, a gate in and out.
    const end = beds.width(s - MARK_SPACING, k) >= GAP_WIDTH || beds.width(s + MARK_SPACING, k) >= GAP_WIDTH;
    for (const sd of end ? [-1, 1] : [side]) marks.push({ kind: 'tyres', ...at(sd, width + MARK_OFFSET - 0.6), yaw: hashTurn(k, n, sd) * 6.2832, high: 3 + ((n + sd) & 1) });
  } else if (Math.abs(curve) > 1 / CHEVRON_RADIUS && Math.sign(curve) !== side) {
    // The outside of a tight bend: the bend turns away from this bank. The board faces back down
    // the bed and its arrows point across it, into the bend (toward the other bank): `flip` when
    // that is its left as it faces (-x of its front), as drawn the arrows point to its +x.
    const m = at(side);
    // The board's +x in the world: (cos yaw, -sin yaw); into the bend is -side * normal.
    const into = -side * (p.nx * Math.cos(facing) - p.nz * Math.sin(facing));
    marks.push({ kind: 'chevron', ...m, yaw: facing, flip: into < 0 });
  } else {
    // The flag flies out from the bed, so it shows broadside to the camera following the car up
    // or down it (its +x, (cos yaw, -sin yaw), along the bank's outward normal, give or take).
    const yaw = Math.atan2(-side * p.nz, side * p.nx) + (hashTurn(k, n, 7) - 0.5) * 0.5;
    marks.push({ kind: 'flag', ...at(side), yaw, side });
  }
}

function hashTurn(a, b, c) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
