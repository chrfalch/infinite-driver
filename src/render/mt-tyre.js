// Mud-terrain tyre look for the soft (GPU or Rapier) tyres: a finer visual mesh carried by the
// solver's particle lattice. Every vertex stores where it sits on the lattice (u around the wheel,
// v around the cross-section, in lattice cells) and how far it stands off the surface (h). The
// vertex shader interpolates the lattice with a Catmull-Rom patch, takes the surface normal from
// the patch derivatives, and pushes the vertex out by h. So the chunky tread blocks, the shoulder
// lugs that wrap onto the sidewall, and the sidewall lettering all ride on the deforming carcass:
// when the tyre squashes on a rock, the blocks squash with it. The lattice itself is uploaded each
// frame as a tiny float texture (one texel per particle).
//
// Lattice layout (see tire/soft-tire.js torusMesh): particle k = i * nv + j, i around the wheel
// (0..nu), j around the cross-section (0..nv) with j = 0 at the tread centre, nv / 4 on a sidewall,
// nv / 2 at the bead. The particles are the tread surface minus the contact radius (0.02 m), so
// blocks 0.022 m tall just reach the ground where the tyre touches it.
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Mesh,
  MeshStandardNodeMaterial,
  NearestFilter,
  RGBAFormat,
  RedFormat,
} from 'three/webgpu';
import { Fn, If, Loop, attribute, cross, float, int, ivec2, modelWorldMatrix, modelWorldMatrixInverse, normalize, select, textureLoad, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { GROUND_N } from '../tire/gpu-tire-solver.js';
import { SOIL_MIN } from '../terrain/riverbed.js';

// The ground under the car as the tyres feel it, without the gravel (the GPU tyre solver's grid:
// the drawn terrain plus the ruts; see updateGpuGround), shared by every tyre. The tyre solver lets
// the tread a little into the ground (its contact spring gives, most under a heavy load on rock;
// the tread dips between gravel stones that are only painted on; the grid's 12.5 cm triangles cut a
// little off the rock sheet's facets), and the tyre is drawn moved with the chassis' drawing
// offset, which is not quite where the ground is. So the vertex shader lifts any drawn point that
// is below this ground back onto it: the tread flattens on the ground instead of sinking into it.
// Off on snow, where a tyre sinking into fresh snow is drawn so.
const groundTexture = new DataTexture(new Float32Array(GROUND_N * GROUND_N), GROUND_N, GROUND_N, RedFormat, FloatType);
groundTexture.minFilter = NearestFilter;
groundTexture.magFilter = NearestFilter;
const groundOrigin = uniform(vec2(0, 0));
const groundCell = uniform(0.125);
const groundOn = uniform(0);

// Copies the solver's ground grid (GROUND_N² heights from (x0, z0), `cell` apart) for drawing.
export function setTyreGround(heights, x0, z0, cell, on = true) {
  groundTexture.image.data.set(heights.subarray(0, GROUND_N * GROUND_N));
  groundTexture.needsUpdate = true;
  groundOrigin.value.set(x0, z0);
  groundCell.value = cell;
  groundOn.value = on ? 1 : 0;
}

// The grid's height at world (x, z), on its triangles (as the solver reads it).
const tyreGroundAt = (x, z) => {
  const last = GROUND_N - 1.001;
  const gx = x.sub(groundOrigin.x).div(groundCell).clamp(0, last);
  const gz = z.sub(groundOrigin.y).div(groundCell).clamp(0, last);
  const ix = gx.floor();
  const iz = gz.floor();
  const fx = gx.sub(ix);
  const fz = gz.sub(iz);
  const at = (dx, dz) => textureLoad(groundTexture, ivec2(int(ix).add(dx), int(iz).add(dz))).x;
  const h00 = at(0, 0);
  const h10 = at(1, 0);
  const h01 = at(0, 1);
  const h11 = at(1, 1);
  const below = h00.add(h10.sub(h00).mul(fx)).add(h01.sub(h00).mul(fz));
  const above = h11.add(h01.sub(h11).mul(fx.oneMinus())).add(h10.sub(h11).mul(fz.oneMinus()));
  return select(fx.add(fz).lessThanEqual(1), below, above);
};

// The dry river's rock sheet around the car, exactly as drawn (terrain/rock-sheet.js: its grid
// points moved at random, so its facets read as broken rock). The ground grid above has 12.5 cm
// triangles that cut a little off the sheet's sharp ridges (up to a few centimetres), and a ridge
// then showed through the tread, so on the sheet the vertex shader also lifts drawn points above its
// own triangles. Per grid point (x, z, h, whether the cell from there is drawn), SHEET_N² of them
// from grid point (sheetOrigin.x, sheetOrigin.y).
const SHEET_N = 65; // 16 m at 25 cm
const sheetTexture = new DataTexture(new Float32Array(SHEET_N * SHEET_N * 4), SHEET_N, SHEET_N, RGBAFormat, FloatType);
sheetTexture.minFilter = NearestFilter;
sheetTexture.magFilter = NearestFilter;
const sheetOrigin = uniform(vec2(0, 0));
const sheetStep = uniform(0.25);
const sheetOn = uniform(0);
const sheetState = { ix0: null, iz0: null };

// Keeps the sheet texture centred near (x, z) from the drawn surface's sheet grid (drawnSurface's
// `sheet`), or turns it off (no sheet in this world).
export function setTyreSheet(sheet, x, z) {
  if (!sheet) {
    sheetOn.value = 0;
    return;
  }
  const half = (SHEET_N - 1) / 2;
  const cx = Math.round(x / sheet.step);
  const cz = Math.round(z / sheet.step);
  // Move it when the car is 2 m off its centre (the tyres stay well inside).
  if (sheetState.ix0 !== null && Math.abs(cx - (sheetState.ix0 + half)) * sheet.step < 2 && Math.abs(cz - (sheetState.iz0 + half)) * sheet.step < 2) return;
  const ix0 = cx - half;
  const iz0 = cz - half;
  const data = sheetTexture.image.data;
  for (let j = 0; j < SHEET_N; j++) {
    for (let i = 0; i < SHEET_N; i++) {
      const q = sheet.point(ix0 + i, iz0 + j);
      // Soil pockets take ruts, which this grid does not have: there the tyre grid (with the ruts)
      // is the ground, so they count as not drawn.
      data.set([q.x, q.z, q.h, sheet.drawn(ix0 + i, iz0 + j) && !(q.soil > SOIL_MIN) ? 1 : 0], (j * SHEET_N + i) * 4);
    }
  }
  sheetTexture.needsUpdate = true;
  Object.assign(sheetState, { ix0, iz0 });
  sheetOrigin.value.set(ix0, iz0);
  sheetStep.value = sheet.step;
  sheetOn.value = 1;
}

// The highest drawn sheet triangle over world (x, z), or a large negative number where there is
// none. As drawnSurface finds it: the jitter is under half a step, so the triangles over a point
// belong to its plain grid cell or a neighbour.
const sheetTopAt = (x, z) => {
  const ix = x.div(sheetStep).floor().sub(sheetOrigin.x);
  const iz = z.div(sheetStep).floor().sub(sheetOrigin.y);
  const P = [];
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      P.push(textureLoad(sheetTexture, ivec2(int(ix).add(i - 1), int(iz).add(j - 1)).clamp(ivec2(0, 0), ivec2(SHEET_N - 1, SHEET_N - 1))));
    }
  }
  // Height on triangle (p, q, r) at (x, z) if inside, else -1e9 (barycentric, a hair of slack).
  const onTriangle = (p, q, r, drawn) => {
    const det = q.y.sub(r.y).mul(p.x.sub(r.x)).add(r.x.sub(q.x).mul(p.y.sub(r.y)));
    const u = q.y.sub(r.y).mul(x.sub(r.x)).add(r.x.sub(q.x).mul(z.sub(r.y))).div(det);
    const v = r.y.sub(p.y).mul(x.sub(r.x)).add(p.x.sub(r.x).mul(z.sub(r.y))).div(det);
    const w = float(1).sub(u).sub(v);
    const inside = u.min(v).min(w).greaterThanEqual(-1e-4).and(drawn.greaterThan(0.5));
    return select(inside, u.mul(p.z).add(v.mul(q.z)).add(w.mul(r.z)), float(-1e9));
  };
  let top = float(-1e9);
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const k = j * 4 + i;
      const a = P[k];
      const b = P[k + 1];
      const c = P[k + 4];
      const d = P[k + 5];
      // Texels hold (x, z, h, drawn): use .x, .y, .z as x, z, h.
      top = top.max(onTriangle(a, c, b, a.w)).max(onTriangle(b, c, d, a.w));
    }
  }
  return select(sheetOn.greaterThan(0.5), top, float(-1e9));
};

// Rocks near a tyre, for the vertex shader: up to DRAW_ROCKS rocks, each a bounding sphere and
// DRAW_FACES face planes (the same convex hulls the tyre solver collides with).
const DRAW_ROCKS = 3;
const DRAW_FACES = 80;

export const LUG_HEIGHT = 0.022; // m, matches the solver's contact radius (0.02) plus a little

const PITCHES = 20; // tread pitches around the tyre
const CARCASS = [0.032, 0.028, 0.024]; // dark rubber in the voids (linear colour)
const BLOCK = [0.085, 0.07, 0.055]; // dusty, worn block tops
const SIDE = [0.06, 0.052, 0.044];

// Catmull-Rom weights and their derivatives for parameter t.
function crWeights(t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}
function crDerivs(t) {
  const t2 = t * t;
  return [(-3 * t2 + 4 * t - 1) / 2, (9 * t2 - 10 * t) / 2, (-9 * t2 + 8 * t + 1) / 2, (3 * t2 - 2 * t) / 2];
}

// ---- Tread layout: a list of quads in (a, s) space ----
// a runs 0..PITCHES around the tyre (one unit per pitch), s is the cross-section position in lattice
// cells (0 = tread centre, ±nv/4 = sidewall middle). Each block is {a0, a1, s0, s1, h0, h1, skew}
// with the height going from h0 at s0 to h1 at s1.
function treadBlocks(nv) {
  const q = nv / 10; // the layout was drawn for nv = 10
  const blocks = [];
  for (let p = 0; p < PITCHES; p++) {
    for (const side of [1, -1]) {
      const off = side > 0 ? 0 : 0.5; // the two halves are staggered by half a pitch
      const a = p + off;
      // Centre block, split by a sipe.
      blocks.push({ a0: a + 0.05, a1: a + 0.3, s0: side * 0.12 * q, s1: side * 0.95 * q, h0: LUG_HEIGHT, h1: LUG_HEIGHT, skew: 0.18 * side });
      blocks.push({ a0: a + 0.34, a1: a + 0.6, s0: side * 0.12 * q, s1: side * 0.95 * q, h0: LUG_HEIGHT, h1: LUG_HEIGHT, skew: 0.18 * side });
      // Shoulder lug, alternating long (wraps well onto the sidewall) and short.
      const long = p % 2 === 0;
      blocks.push({
        a0: a + 0.5,
        a1: a + 0.98,
        s0: side * 1.08 * q,
        s1: side * (long ? 2.35 : 1.95) * q,
        h0: LUG_HEIGHT,
        h1: LUG_HEIGHT * (long ? 0.45 : 0.6),
        skew: 0.1 * side,
      });
    }
  }
  // Sidewall: raised "lettering" dashes on two arcs, and a rim-protector rib near the bead.
  for (const side of [1, -1]) {
    for (const [start, count] of [[1.5, 26], [11.5, 26]]) {
      let a = start;
      for (let c = 0; c < count; c++) {
        const w = 0.07 + ((c * 7919) % 5) * 0.025;
        const tall = (c * 104729) % 3 === 0;
        blocks.push({ a0: a, a1: a + w, s0: side * 2.95 * q, s1: side * (tall ? 3.45 : 3.3) * q, h0: 0.004, h1: 0.004, skew: 0 });
        a += w + 0.05 + ((c * 31) % 3) * 0.03;
      }
    }
    for (let p = 0; p < PITCHES * 2; p++) {
      blocks.push({ a0: p * 0.5, a1: p * 0.5 + 0.47, s0: side * 3.95 * q, s1: side * 4.15 * q, h0: 0.005, h1: 0.005, skew: 0 });
    }
  }
  return blocks;
}

// Geometry in lattice space: attribute `lattice` = (u, v, h, 0) and a colour per vertex.
function buildGeometry(nu, nv) {
  const lat = [];
  const col = [];
  const idx = [];
  const aToU = nu / PITCHES;
  const vert = (u, v, h, c) => {
    lat.push(u, v, h, 0);
    col.push(...c);
    return lat.length / 4 - 1;
  };
  // Carcass: a plain grid over the whole torus.
  const U = nu * 2;
  const V = nv * 3;
  for (let i = 0; i <= U; i++) for (let j = 0; j <= V; j++) vert((i / U) * nu, (j / V) * nv - nv / 2, 0, CARCASS);
  for (let i = 0; i < U; i++) {
    for (let j = 0; j < V; j++) {
      const a = i * (V + 1) + j;
      const b = (i + 1) * (V + 1) + j;
      idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  // Blocks: a curved top (subdivided so it follows the carcass) and sloped side walls.
  for (const k of treadBlocks(nv)) {
    // Small sidewall details need no subdivision; tread blocks follow the carcass curvature.
    const small = k.h0 < 0.01;
    const ni = small ? 1 : 2;
    const nj = small ? 1 : Math.max(2, Math.ceil(Math.abs(k.s1 - k.s0) / 0.45));
    const draft = 0.12; // the top is inset this share of the block from its footprint
    const top = [];
    const at = (fa, fs, inset) => {
      const s = k.s0 + (k.s1 - k.s0) * fs;
      const aMid = (k.a0 + k.a1) / 2;
      const half = ((k.a1 - k.a0) / 2) * (1 - inset * draft * 2);
      const a = aMid + (fa - 0.5) * 2 * half + k.skew * (s - k.s0);
      const sIn = inset ? k.s0 + (k.s1 - k.s0) * (draft + fs * (1 - 2 * draft)) : s;
      return [a * aToU, sIn];
    };
    const hOf = (fs) => k.h0 + (k.h1 - k.h0) * fs;
    const cTop = Math.abs(k.s0) > nv * 0.25 ? SIDE : BLOCK;
    for (let i = 0; i <= ni; i++) {
      for (let j = 0; j <= nj; j++) {
        const [u, v] = at(i / ni, j / nj, 1);
        top.push(vert(u, v, hOf(j / nj), cTop));
      }
    }
    for (let i = 0; i < ni; i++) {
      for (let j = 0; j < nj; j++) {
        const a = top[i * (nj + 1) + j];
        const b = top[(i + 1) * (nj + 1) + j];
        idx.push(a, b + 1, b, a, a + 1, b + 1);
      }
    }
    // Side walls around the footprint: top edge -> base edge.
    const ring = [];
    for (let i = 0; i < ni; i++) ring.push([i / ni, 0]);
    for (let j = 0; j < nj; j++) ring.push([1, j / nj]);
    for (let i = ni; i > 0; i--) ring.push([i / ni, 1]);
    for (let j = nj; j > 0; j--) ring.push([0, j / nj]);
    const topIdx = (fa, fs) => top[Math.round(fa * ni) * (nj + 1) + Math.round(fs * nj)];
    const base = ring.map(([fa, fs]) => {
      const [u, v] = at(fa, fs, 0);
      return vert(u, v, -0.002, CARCASS);
    });
    for (let r = 0; r < ring.length; r++) {
      const n = (r + 1) % ring.length;
      const t0 = topIdx(...ring[r]);
      const t1 = topIdx(...ring[n]);
      idx.push(t0, base[r], base[n], t0, base[n], t1);
    }
  }
  const geometry = new BufferGeometry();
  const lattice = new Float32Array(lat);
  geometry.setAttribute('lattice', new BufferAttribute(lattice, 4));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  // Positions are computed in the shader; this attribute only sizes the draw.
  geometry.setAttribute('position', new BufferAttribute(new Float32Array((lat.length / 4) * 3), 3));
  geometry.setIndex(idx);
  return geometry;
}

const geometryCache = new Map();
function treadGeometry(nu, nv, mirror) {
  const key = `${nu}x${nv}${mirror ? 'm' : ''}`;
  if (!geometryCache.has(key)) {
    const g = buildGeometry(nu, nv);
    // A mirrored tyre (right side) has its cross-section running the other way round, so the
    // outward normal is flipped; the triangles are flipped to stay front-facing.
    if (mirror) {
      const index = g.getIndex().array;
      for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
    }
    geometryCache.set(key, g);
  }
  return geometryCache.get(key);
}

// Lattice position at (u, v) and the outward normal, evaluated on the CPU from a flat xyz array.
// Used for the static (rigid) tyre and in tests.
export function evaluateLattice(positions, nu, nv, u, v, sign = 1) {
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const wu = crWeights(u - iu);
  const wv = crWeights(v - iv);
  const du = crDerivs(u - iu);
  const dv = crDerivs(v - iv);
  const p = [0, 0, 0];
  const pu = [0, 0, 0];
  const pv = [0, 0, 0];
  for (let a = 0; a < 4; a++) {
    const i = (((iu + a - 1) % nu) + nu) % nu;
    for (let b = 0; b < 4; b++) {
      const j = (((iv + b - 1) % nv) + nv) % nv;
      const k = (i * nv + j) * 3;
      for (let c = 0; c < 3; c++) {
        const x = positions[k + c];
        p[c] += wu[a] * wv[b] * x;
        pu[c] += du[a] * wv[b] * x;
        pv[c] += wu[a] * dv[b] * x;
      }
    }
  }
  const n = [pu[1] * pv[2] - pu[2] * pv[1], pu[2] * pv[0] - pu[0] * pv[2], pu[0] * pv[1] - pu[1] * pv[0]];
  const l = Math.hypot(...n) * sign || 1;
  return { p, n: n.map((x) => x / l) };
}

function tyreMaterial(nu, nv, sign) {
  // The lattice texture is per tyre, so each tyre gets its own material instance.
  const texture = new DataTexture(new Float32Array(nu * nv * 4), nv, nu, RGBAFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  const signU = uniform(sign);
  const rockTexture = new DataTexture(new Float32Array((DRAW_FACES + 1) * DRAW_ROCKS * 4), DRAW_FACES + 1, DRAW_ROCKS, RGBAFormat, FloatType);
  rockTexture.minFilter = NearestFilter;
  rockTexture.magFilter = NearestFilter;
  rockTexture.needsUpdate = true;
  const material = new MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0, flatShading: true });
  const lattice = attribute('lattice', 'vec4');
  material.positionNode = Fn(() => {
    const u = lattice.x;
    const v = lattice.y;
    const iu = int(u.floor());
    const iv = int(v.floor());
    const tu = u.fract();
    const tv = v.fract();
    const W = (t) => {
      const t2 = t.mul(t);
      const t3 = t2.mul(t);
      return [
        t3.negate().add(t2.mul(2)).sub(t).mul(0.5),
        t3.mul(3).sub(t2.mul(5)).add(2).mul(0.5),
        t3.mul(-3).add(t2.mul(4)).add(t).mul(0.5),
        t3.sub(t2).mul(0.5),
      ];
    };
    const D = (t) => {
      const t2 = t.mul(t);
      return [
        t2.mul(-3).add(t.mul(4)).sub(1).mul(0.5),
        t2.mul(9).sub(t.mul(10)).mul(0.5),
        t2.mul(-9).add(t.mul(8)).add(1).mul(0.5),
        t2.mul(3).sub(t.mul(2)).mul(0.5),
      ];
    };
    const wu = W(tu);
    const wv = W(tv);
    const du = D(tu);
    const dv = D(tv);
    const p = vec3(0).toVar();
    const pu = vec3(0).toVar();
    const pv = vec3(0).toVar();
    for (let a = 0; a < 4; a++) {
      const i = iu.add(a - 1 + nu * 4).mod(nu);
      for (let b = 0; b < 4; b++) {
        const j = iv.add(b - 1 + nv * 4).mod(nv);
        const x = textureLoad(texture, ivec2(j, i)).xyz;
        p.addAssign(x.mul(wu[a].mul(wv[b])));
        pu.addAssign(x.mul(du[a].mul(wv[b])));
        pv.addAssign(x.mul(wu[a].mul(dv[b])));
      }
    }
    const n = normalize(cross(pu, pv)).mul(signU);
    // Where the carcass wraps tightly round something (a rock edge), the Catmull-Rom patch swings
    // outward past the particles, i.e. into the rock. Keep it within 5 mm outside the plain
    // bilinear surface through the four nearest particles (on the round tread the patch only
    // bulges about 1 mm beyond it, so the smooth shape is kept).
    const q = (a, b) => textureLoad(texture, ivec2(iv.add(b + nv * 4).mod(nv), iu.add(a + nu * 4).mod(nu)));
    const x00 = q(0, 0);
    const x10 = q(1, 0);
    const x01 = q(0, 1);
    const x11 = q(1, 1);
    const lin = x00.mul(tu.oneMinus().mul(tv.oneMinus())).add(x10.mul(tu.mul(tv.oneMinus()))).add(x01.mul(tu.oneMinus().mul(tv))).add(x11.mul(tu.mul(tv)));
    const bulge = p.sub(lin.xyz).dot(n);
    const surface = p.sub(n.mul(bulge.sub(0.005).max(0)));
    // Lugs are drawn no taller than the gap to the ground or rock under them (w, from the solver),
    // so they squash flat where the tyre presses on a rock.
    const height = lattice.z.min(lin.w.max(0));
    const out = surface.add(n.mul(height)).toVar();
    // The particles are about 7 cm apart, so the surface between them can cut through a sharp rock
    // edge even when every particle is outside the rock. Push drawn points out of the rock hulls,
    // so the tread visibly wraps the rock instead of the rock poking through it.
    for (let r = 0; r < DRAW_ROCKS; r++) {
      const sphere = textureLoad(rockTexture, ivec2(0, r));
      If(sphere.w.greaterThan(0).and(out.sub(sphere.xyz).length().lessThan(sphere.w.add(0.05))), () => {
        const best = float(-1e9).toVar();
        const normal = vec3(0, 1, 0).toVar();
        Loop({ start: int(1), end: int(DRAW_FACES + 1), type: 'int' }, ({ i }) => {
          const plane = textureLoad(rockTexture, ivec2(i, r));
          const dist = plane.xyz.dot(out).sub(plane.w);
          If(dist.greaterThan(best), () => {
            best.assign(dist);
            normal.assign(plane.xyz);
          });
        });
        If(best.lessThan(0.002), () => {
          out.addAssign(normal.mul(float(0.002).sub(best)));
        });
      });
    }
    // Never below the ground (see groundTexture) or the rock sheet's own triangles (see
    // sheetTexture). The tyre mesh is in world space, moved by its matrix (the drawing offsets), so
    // the lift is turned back into the mesh's frame.
    const world = modelWorldMatrix.mul(vec4(out, 1)).xyz;
    const bottom = tyreGroundAt(world.x, world.z).max(sheetTopAt(world.x, world.z));
    const lift = bottom.sub(world.y).max(0).mul(groundOn);
    out.addAssign(modelWorldMatrixInverse.mul(vec4(0, lift, 0, 0)).xyz);
    return out;
  })();
  material.colorNode = vec4(attribute('color', 'vec3'), float(1));
  return { material, texture, rockTexture };
}

// A world-space tyre mesh for one soft tyre. `mesh` is the torusMesh description (nu, nv, mirror
// shows in the sign of its z coordinates).
export function createMtTyreMesh(mesh) {
  const { nu, nv } = mesh;
  // The first sidewall point (j = nv / 4) tells which way the cross-section runs.
  const mirror = mesh.vertices[Math.round(nv / 4) * 3 + 2] < 0;
  const { material, texture, rockTexture } = tyreMaterial(nu, nv, mirror ? -1 : 1);
  const object = new Mesh(treadGeometry(nu, nv, mirror), material);
  object.castShadow = true;
  object.receiveShadow = true;
  object.frustumCulled = false;
  object.userData.lattice = texture;
  object.userData.rocks = rockTexture;
  object.userData.rockKey = '';
  // Start from the rest shape so the first frame is sensible.
  setLattice(object, mesh.vertices, 3);
  return object;
}

// Uploads particle positions (stride 3 for xyz, 4 for the GPU solver's vec4) into the lattice.
export function setLattice(object, positions, stride = 3, offset = 0) {
  const texture = object.userData.lattice;
  const out = texture.image.data;
  const n = out.length / 4;
  if (stride === 4) out.set(positions.subarray(offset, offset + n * 4));
  else for (let k = 0; k < n; k++) {
    out[k * 4] = positions[offset + k * 3];
    out[k * 4 + 1] = positions[offset + k * 3 + 1];
    out[k * 4 + 2] = positions[offset + k * 3 + 2];
    out[k * 4 + 3] = 1; // no clearance data: never flatten the lugs
  }
  texture.needsUpdate = true;
}

// Chooses the rocks nearest to the tyre (from the solver's rock list) for the vertex shader.
// Only re-uploads when the set changes.
export function setNearbyRocks(object, rocks, centre) {
  const near = (rocks ?? [])
    .map((rock) => ({ rock, d: Math.hypot(rock.sphere[0] - centre[0], rock.sphere[1] - centre[1], rock.sphere[2] - centre[2]) - rock.sphere[3] }))
    .filter((r) => r.d < 0.8)
    .sort((a, b) => a.d - b.d)
    .slice(0, DRAW_ROCKS)
    .map((r) => r.rock);
  const key = near.map((r) => r.sphere.join(',')).join('|');
  if (key === object.userData.rockKey) return;
  object.userData.rockKey = key;
  const texture = object.userData.rocks;
  const data = texture.image.data;
  data.fill(0);
  near.forEach((rock, r) => {
    const row = r * (DRAW_FACES + 1) * 4;
    data.set(rock.sphere, row);
    data.set(rock.planes.subarray(0, DRAW_FACES * 4), row + 4);
  });
  texture.needsUpdate = true;
}

// A static M/T tyre (rigid-wheel mode) in wheel-local space, axle along z, built on the CPU from
// the rest lattice.
export function createStaticMtTyre(mesh) {
  const { nu, nv, vertices } = mesh;
  const mirror = vertices[Math.round(nv / 4) * 3 + 2] < 0;
  const src = treadGeometry(nu, nv, mirror);
  const lattice = src.getAttribute('lattice').array;
  const count = lattice.length / 4;
  const pos = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    const { p, n } = evaluateLattice(vertices, nu, nv, lattice[k * 4], lattice[k * 4 + 1], mirror ? -1 : 1);
    const h = lattice[k * 4 + 2];
    pos.set([p[0] + n[0] * h, p[1] + n[1] * h, p[2] + n[2] * h], k * 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(pos, 3));
  geometry.setAttribute('color', src.getAttribute('color').clone());
  geometry.setIndex(src.getIndex().clone());
  const object = new Mesh(geometry, staticRubber);
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}
const staticRubber = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, flatShading: true });
