// The ground near the car on the deformation grid (12.5 cm), so the ruts and berms the tyres leave
// in the soil show as real grooves (the snowfield has its own, render/snow-surface.js). The terrain
// mesh is only a 1 m grid and never shows them, while the GPU tyres feel the ruts (tire/gpu-tires.js
// adds the deformation to the drawn ground): without this patch a tyre in a rut sank into the drawn
// ground. Inside the patch the terrain mesh is sunk out of sight (see setGroundPatch).
//
// The patch's undeformed shape and its colours come from the terrain mesh's own 1 m corners
// (groundMeshData), interpolated on the same triangles in the vertex shader, so where there is no
// rut it looks exactly like the terrain mesh, and its edge meets it without a crack. A texture holds
// each vertex's deformation, faded out toward the edge. The patch follows the car in whole metres.
import { DataTexture, FloatType, Mesh, MeshStandardNodeMaterial, NearestFilter, RGBAFormat, RedFormat } from 'three/webgpu';
import { Fn, ivec2, mix, normalize, positionLocal, step, textureLoad, transformNormalToView, uniform, varying, vec2, vec3 } from 'three/tsl';
import { groundMeshData, groundNormal, groundShading } from './terrain-mesh.js';
import { patchGeometry } from './snow-surface.js';
import { DEFORM_CELL } from '../terrain/deformation.js';

export const PATCH_SIZE = 48; // m
const CELL = DEFORM_CELL;
const PER_METRE = Math.round(1 / CELL);
const N = PATCH_SIZE * PER_METRE + 1; // vertices per side
const C = PATCH_SIZE + 1; // 1 m corners per side
const EDGE_FADE = 1.5; // m over which the deformation fades out toward the edge
const RECENTRE = 4; // m the car may get from the patch centre before it moves

// The vertices within EDGE_FADE of the edge and how much of the deformation each keeps: 0 on the
// outermost ring, rising to 1 at EDGE_FADE in.
function edgeWeights() {
  const fade = [];
  const weights = [];
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const w = (Math.min(ix, iz, N - 1 - ix, N - 1 - iz) * CELL) / EDGE_FADE;
      if (w >= 1) continue;
      fade.push(iz * N + ix);
      weights.push(w);
    }
  }
  return { fade: Uint32Array.from(fade), weights: Float32Array.from(weights) };
}

function floatTexture(data, size, format) {
  const texture = new DataTexture(data, size, size, format, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  return texture;
}

// `corners`: per 1 m corner, (colour, gravel), (roadDist, steep, lake, height) and the normal;
// `deform`: per vertex, the deformation.
function groundMaterial(corners, deform, origin) {
  const material = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  // The vertex's cell (the geometry holds cell indices in x and z), and where it lies in its metre.
  const cell = ivec2(positionLocal.x, positionLocal.z);
  const gx = positionLocal.x.div(PER_METRE);
  const gz = positionLocal.z.div(PER_METRE);
  const mx = gx.floor();
  const mz = gz.floor();
  const fx = gx.sub(mx);
  const fz = gz.sub(mz);
  // On the terrain mesh's triangles, (a, c, b) and (b, c, d) (see chunkTrimesh), as the GPU
  // interpolates its vertex attributes.
  const lower = step(fx.add(fz), 1);
  const onTriangles = (texture) => {
    const at = (dx, dz) => textureLoad(texture, ivec2(mx, mz).add(ivec2(dx, dz)).clamp(ivec2(0, 0), ivec2(C - 1, C - 1)));
    const c00 = at(0, 0);
    const c10 = at(1, 0);
    const c01 = at(0, 1);
    const c11 = at(1, 1);
    const below = c00.add(c10.sub(c00).mul(fx)).add(c01.sub(c00).mul(fz));
    const above = c11.add(c01.sub(c11).mul(fx.oneMinus())).add(c10.sub(c11).mul(fz.oneMinus()));
    return mix(above, below, lower);
  };
  const a = onTriangles(corners[0]);
  const b = onTriangles(corners[1]);
  const base = onTriangles(corners[2]).xyz;
  const def = (dx, dz) => textureLoad(deform, cell.add(ivec2(dx, dz)).clamp(ivec2(0, 0), ivec2(N - 1, N - 1))).x;
  material.positionNode = vec3(origin.x.add(positionLocal.x.mul(CELL)), b.w.add(def(0, 0)), origin.y.add(positionLocal.z.mul(CELL)));
  // The terrain's slope plus the ruts'.
  const normal = Fn(() => {
    const sx = base.x.negate().div(base.y).add(def(1, 0).sub(def(-1, 0)).div(2 * CELL));
    const sz = base.z.negate().div(base.y).add(def(0, 1).sub(def(0, -1)).div(2 * CELL));
    return normalize(vec3(sx.negate(), 1, sz.negate()));
  })();
  material.normalNode = transformNormalToView(groundNormal(normalize(varying(normal))));
  const shading = groundShading({
    color: varying(a.xyz),
    gravel: varying(a.w),
    roadDist: varying(b.x),
    steep: varying(b.y),
    lake: varying(b.z),
  });
  material.colorNode = shading.color;
  material.roughnessNode = shading.roughness;
  return material;
}

export class GroundSurface {
  constructor(scene, heightAt, deformation) {
    this.heightAt = heightAt;
    this.ground = heightAt.coarse ?? heightAt; // as sampleChunk samples the terrain mesh
    this.deformation = deformation;
    this.corners = [0, 1, 2].map(() => floatTexture(new Float32Array(C * C * 4), C, RGBAFormat));
    this.deform = floatTexture(new Float32Array(N * N), N, RedFormat);
    this.edge = edgeWeights();
    this.origin = uniform(vec2(0, 0));
    this.ix0 = null; // patch origin in whole metres
    this.iz0 = null;
    this.version = -1;
    this.mesh = new Mesh(patchGeometry(N), groundMaterial(this.corners, this.deform, this.origin));
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    // With the terrain, before the tyre tracks (see Tracks).
    this.mesh.renderOrder = -1;
    this.mesh.name = 'ground surface';
    scene.add(this.mesh);
    this.onMove = null; // (x0, z0, x1, z1) when the patch moves
  }

  // Moves the corner data by (-sx, -sz) corners, for a patch whose origin moved by (sx, sz) m.
  shiftCorners(sx, sz) {
    for (const t of this.corners) {
      const d = t.image.data;
      const copy = d.slice();
      for (let iz = 0; iz < C; iz++) {
        const pz = iz + sz;
        if (pz < 0 || pz >= C) continue;
        for (let ix = 0; ix < C; ix++) {
          const px = ix + sx;
          if (px >= 0 && px < C) d.set(copy.subarray((pz * C + px) * 4, (pz * C + px) * 4 + 4), (iz * C + ix) * 4);
        }
      }
    }
  }

  // Works out the corners [cx, cx + nx) x [cz, cz + nz) of a patch at (ix0, iz0) from the terrain
  // mesh's vertex data (groundMeshData), height in the second texture's w.
  fillCorners(ix0, iz0, cx, cz, nx, nz) {
    const heights = new Float32Array(nx * nz);
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) heights[iz * nx + ix] = this.ground(ix0 + cx + ix, iz0 + cz + iz);
    const m = groundMeshData(this.heightAt, heights, ix0 + cx, iz0 + cz, 1, nx - 1, nz - 1);
    const [a, b, n] = this.corners.map((t) => t.image.data);
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        const o = ((cz + iz) * C + cx + ix) * 4;
        a.set([m.colors[i * 3], m.colors[i * 3 + 1], m.colors[i * 3 + 2], m.gravel[i]], o);
        b.set([m.roadDist[i], m.steep[i], m.lake[i], heights[i]], o);
        n.set([m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2], 0], o);
      }
    }
  }

  // The patch's world rectangle.
  bounds() {
    return { x0: this.ix0, z0: this.iz0, x1: this.ix0 + PATCH_SIZE, z1: this.iz0 + PATCH_SIZE };
  }

  update(x, z) {
    const half = PATCH_SIZE / 2;
    const moved = this.ix0 === null || Math.abs(x - (this.ix0 + half)) > RECENTRE || Math.abs(z - (this.iz0 + half)) > RECENTRE;
    const version = this.deformation?.version ?? 0;
    if (!moved && version === this.version) return;
    if (moved) {
      const ix0 = Math.round(x - half);
      const iz0 = Math.round(z - half);
      // Keep the corners the old patch shares with the new one; work out only the new strips.
      const sx = this.ix0 === null ? C : ix0 - this.ix0;
      const sz = this.iz0 === null ? C : iz0 - this.iz0;
      if (Math.abs(sx) < C && Math.abs(sz) < C) this.shiftCorners(sx, sz);
      const keepX0 = Math.max(0, -sx);
      const keepX1 = Math.min(C, C - sx); // columns [keepX0, keepX1) were kept
      const keepZ0 = Math.max(0, -sz);
      const keepZ1 = Math.min(C, C - sz);
      if (keepX0 >= keepX1 || keepZ0 >= keepZ1) this.fillCorners(ix0, iz0, 0, 0, C, C);
      else {
        // New columns over the whole height, then new rows between them.
        if (keepX0 > 0) this.fillCorners(ix0, iz0, 0, 0, keepX0, C);
        if (keepX1 < C) this.fillCorners(ix0, iz0, keepX1, 0, C - keepX1, C);
        if (keepZ0 > 0) this.fillCorners(ix0, iz0, keepX0, 0, keepX1 - keepX0, keepZ0);
        if (keepZ1 < C) this.fillCorners(ix0, iz0, keepX0, keepZ1, keepX1 - keepX0, C - keepZ1);
      }
      for (const t of this.corners) t.needsUpdate = true;
      this.ix0 = ix0;
      this.iz0 = iz0;
      this.origin.value.set(ix0, iz0);
      this.onMove?.(this.bounds());
    }
    this.version = version;
    const out = this.deform.image.data;
    out.fill(0);
    this.deformation?.accumulate(this.ix0 * PER_METRE, this.iz0 * PER_METRE, N, N, out);
    const { fade, weights } = this.edge;
    for (let k = 0; k < fade.length; k++) out[fade[k]] *= weights[k];
    this.deform.needsUpdate = true;
  }
}
