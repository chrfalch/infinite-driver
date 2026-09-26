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
} from 'three/webgpu';
import { Fn, attribute, cross, float, int, ivec2, normalize, textureLoad, uniform, vec3, vec4 } from 'three/tsl';

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
    return p.add(n.mul(lattice.z));
  })();
  material.colorNode = vec4(attribute('color', 'vec3'), float(1));
  return { material, texture };
}

// A world-space tyre mesh for one soft tyre. `mesh` is the torusMesh description (nu, nv, mirror
// shows in the sign of its z coordinates).
export function createMtTyreMesh(mesh) {
  const { nu, nv } = mesh;
  // The first sidewall point (j = nv / 4) tells which way the cross-section runs.
  const mirror = mesh.vertices[Math.round(nv / 4) * 3 + 2] < 0;
  const { material, texture } = tyreMaterial(nu, nv, mirror ? -1 : 1);
  const object = new Mesh(treadGeometry(nu, nv, mirror), material);
  object.castShadow = true;
  object.receiveShadow = true;
  object.frustumCulled = false;
  object.userData.lattice = texture;
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
  }
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
