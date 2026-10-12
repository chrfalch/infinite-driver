// The snow surface near the car, on the deformation grid (12.5 cm), so the ruts the tyres pack
// into the snow show as real grooves with the berms beside them. The terrain mesh is only a 1 m
// grid, so on snow it is sunk out of sight under this patch (see setGroundPatch in terrain-mesh.js).
//
// The patch is a fixed grid of vertices. Textures hold each vertex's snow surface (its height, how
// firm, where it is), its deformation and how packed the snow there is, and the terrain mesh's own
// 1 m corners (groundMeshData), which the vertex shader interpolates on the same triangles as the
// terrain mesh. Away from the car the snow surface morphs into that coarse surface, smoothly with the
// distance from the car (FADE_START to FADE_END), so the lumps of the plough banks melt into the
// terrain mesh's smoother banks instead of ending at the patch's edge, and the morph moves with the
// car instead of jumping when the patch does. Out there the patch is the terrain mesh, normals and
// packing included, so its edge meets it unseen. The patch follows the car in whole metres, so its
// edges stay on the terrain mesh's grid lines; the deformation fades out toward the edge.
import { BufferAttribute, BufferGeometry, DataTexture, FloatType, Mesh, MeshStandardNodeMaterial, NearestFilter, RGBAFormat, RGFormat } from 'three/webgpu';
import { Fn, float, int, ivec2, mix, normalize, positionLocal, smoothstep, step, textureLoad, transformNormalToView, uniform, varying, vec2, vec3, vec4 } from 'three/tsl';
import { groundMeshData, snowGroundColor, snowGroundRoughness } from './terrain-mesh.js';
import { DEFORM_CELL } from '../terrain/deformation.js';

export const PATCH_SIZE = 48; // m
const CELL = DEFORM_CELL;
const PER_METRE = Math.round(1 / CELL);
const N = Math.round(PATCH_SIZE / CELL) + 1; // vertices per side
export const SNOW_PATCH_N = N;
const C = PATCH_SIZE + 1; // 1 m corners per side
const EDGE_FADE = 1.5; // m over which the deformation fades out toward the edge
const RECENTRE = 4; // m the car may get from the patch centre before it moves
// The snow surface's own shape (to FADE_START m from the car) morphs into the terrain mesh's (from
// FADE_END on). FADE_END stays inside the patch wherever the car is in it (at least
// PATCH_SIZE / 2 - RECENTRE from every edge).
export const FADE_START = 12;
export const FADE_END = PATCH_SIZE / 2 - RECENTRE - 0.5;

// Where the edge fade leaves the deformation: 0 on the outermost ring, 1 from EDGE_FADE in.
function edgeWeights() {
  const w = new Float32Array(N * N);
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const d = Math.min(ix, iz, N - 1 - ix, N - 1 - iz) * CELL;
      w[iz * N + ix] = Math.min(1, d / EDGE_FADE);
    }
  }
  return w;
}

// A square grid of n x n vertices holding their cell indices in x and z (the shader places them).
export function patchGeometry(n = N) {
  const positions = new Float32Array(n * n * 3);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      positions[i * 3] = ix;
      positions[i * 3 + 2] = iz;
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let iz = 0; iz < n - 1; iz++) {
    for (let ix = 0; ix < n - 1; ix++) {
      const a = ix + iz * n;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

function floatTexture(data, size, format) {
  const texture = new DataTexture(data, size, size, format, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  return texture;
}

// The snow surface's height at cell `at` (an ivec2 node): its own shape morphed into the terrain
// mesh's by the distance from the car, plus the deformation. Also the morph weight `w` (1 the snow
// surface's own, 0 the terrain mesh's) and the coarse corner data interpolated there.
// `textures`: { snow: per vertex (height, firmness, road side, lake), dynamic: per vertex
// (deformation, packing), corners: per 1 m corner [(normal, height), (gravel)] }.
function surfaceAt({ snow, dynamic, corners, origin, centre }, at) {
  const cell = at.clamp(ivec2(0, 0), ivec2(N - 1, N - 1));
  const x = float(cell.x);
  const z = float(cell.y);
  const world = vec2(origin.x.add(x.mul(CELL)), origin.y.add(z.mul(CELL)));
  const w = smoothstep(FADE_END, FADE_START, world.sub(centre).length());
  // On the terrain mesh's triangles, (a, c, b) and (b, c, d) (see chunkTrimesh), as the GPU
  // interpolates its vertex attributes.
  const gx = x.div(PER_METRE);
  const gz = z.div(PER_METRE);
  const mx = gx.floor().min(C - 2);
  const mz = gz.floor().min(C - 2);
  const fx = gx.sub(mx);
  const fz = gz.sub(mz);
  const lower = step(fx.add(fz), 1);
  const onTriangles = (texture) => {
    const at = (dx, dz) => textureLoad(texture, ivec2(int(mx).add(dx), int(mz).add(dz)));
    const c00 = at(0, 0);
    const c10 = at(1, 0);
    const c01 = at(0, 1);
    const c11 = at(1, 1);
    const below = c00.add(c10.sub(c00).mul(fx)).add(c01.sub(c00).mul(fz));
    const above = c11.add(c01.sub(c11).mul(fx.oneMinus())).add(c10.sub(c11).mul(fz.oneMinus()));
    return mix(above, below, lower);
  };
  const coarse = onTriangles(corners[0]);
  const own = textureLoad(snow, cell);
  const dyn = textureLoad(dynamic, cell);
  return { w, coarse, gravel: onTriangles(corners[1]).x, own, dyn, height: mix(coarse.w, own.x, w).add(dyn.x) };
}

// Snow colours (as on the terrain mesh, see snowGroundColor): fresh snow is bright and slightly
// blue; packed snow in a rut or on the road is greyer and smoother (it shines more), and where the
// road's snow is worn through, the asphalt shows; on the lake, black ice. Toward FADE_END the
// shape, normals and packing become the terrain mesh's (plus the ruts').
function snowMaterial(textures) {
  const material = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const { origin } = textures;
  // The vertex's cell (the geometry holds cell indices in x and z).
  const cell = ivec2(positionLocal.x, positionLocal.z);
  const here = surfaceAt(textures, cell);
  material.positionNode = vec3(origin.x.add(positionLocal.x.mul(CELL)), here.height, origin.y.add(positionLocal.z.mul(CELL)));
  // The slope: the terrain mesh's (from its interpolated normal) morphed into the snow surface's own,
  // plus the ruts'.
  const normal = Fn(() => {
    const own = (dx, dz) => textureLoad(textures.snow, cell.add(ivec2(dx, dz)).clamp(ivec2(0, 0), ivec2(N - 1, N - 1))).x;
    const def = (dx, dz) => textureLoad(textures.dynamic, cell.add(ivec2(dx, dz)).clamp(ivec2(0, 0), ivec2(N - 1, N - 1))).x;
    const n = here.coarse.xyz;
    const sx = mix(n.x.negate().div(n.y), own(1, 0).sub(own(-1, 0)).div(2 * CELL), here.w).add(def(1, 0).sub(def(-1, 0)).div(2 * CELL));
    const sz = mix(n.z.negate().div(n.y), own(0, 1).sub(own(0, -1)).div(2 * CELL), here.w).add(def(0, 1).sub(def(0, -1)).div(2 * CELL));
    return normalize(vec3(sx.negate(), 1, sz.negate()));
  })();
  material.normalNode = transformNormalToView(normalize(varying(normal)));
  // How packed: the snow's own firmness morphed into the terrain mesh's (its 'gravel' attribute),
  // plus what the tyres packed.
  const S = (v) => smoothstep(0.05, 0.9, v);
  const firm = S(here.own.y);
  const pack = varying(mix(here.gravel, firm, here.w).add(S(here.dyn.y)).sub(firm));
  const place = varying(here.own.zw);
  material.colorNode = vec4(snowGroundColor(place.x, pack, place.y), 1);
  material.roughnessNode = snowGroundRoughness(place.x, pack, place.y);
  return material;
}

export class SnowSurface {
  constructor(scene, heightAt, deformation) {
    this.heightAt = heightAt;
    this.deformation = deformation;
    this.snowAt = heightAt.snowAt;
    // Per vertex: the snow surface's height, firmness, road side and lake (rewritten when the patch
    // moves); the deformation and packing (rewritten as the ruts change).
    this.snow = floatTexture(new Float32Array(N * N * 4), N, RGBAFormat);
    this.data = new Float32Array(N * N * 2);
    this.texture = floatTexture(this.data, N, RGFormat);
    // Per 1 m corner, the terrain mesh's (normal, height) and (gravel).
    this.corners = [0, 1].map(() => floatTexture(new Float32Array(C * C * 4), C, RGBAFormat));
    this.origin = uniform(vec2(0, 0));
    this.centre = uniform(vec2(0, 0)); // the car: where the morph is centred
    // Per vertex, kept across moves: the snow's firmness and pack depth (see terrain/snow.js).
    this.cells = { firm: new Float32Array(N * N), pack: new Float32Array(N * N) };
    this.spare = { firm: new Float32Array(N * N), pack: new Float32Array(N * N) };
    this.def = new Float32Array(N * N);
    this.weights = edgeWeights();
    this.ix0 = null;
    this.iz0 = null;
    this.version = -1;
    this.textures = { snow: this.snow, dynamic: this.texture, corners: this.corners, origin: this.origin, centre: this.centre };
    this.mesh = new Mesh(patchGeometry(), snowMaterial(this.textures));
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    // With the terrain, before the tyre tracks (which write no depth).
    this.mesh.renderOrder = -1;
    this.mesh.name = 'snow surface';
    scene.add(this.mesh);
    this.onMove = null; // (x0, z0, x1, z1) when the patch moves
  }

  // The drawn height at cell (ix, iz) (int nodes), for meshes that lie on the snow (the tyre tracks).
  heightNode(ix, iz) {
    return surfaceAt(this.textures, ivec2(ix, iz)).height;
  }

  // The patch's world rectangle.
  bounds() {
    const x0 = this.ix0 * CELL;
    const z0 = this.iz0 * CELL;
    return { x0, z0, x1: x0 + PATCH_SIZE, z1: z0 + PATCH_SIZE };
  }

  // The terrain mesh's corners for a patch at (x0, z0) m (groundMeshData, as the chunks have them).
  fillCorners(x0, z0) {
    const heights = new Float32Array(C * C);
    for (let iz = 0; iz < C; iz++) for (let ix = 0; ix < C; ix++) heights[iz * C + ix] = this.heightAt(x0 + ix, z0 + iz);
    const m = groundMeshData(this.heightAt, heights, x0, z0, 1, C - 1);
    const [a, b] = this.corners.map((t) => t.image.data);
    for (let i = 0; i < C * C; i++) {
      a.set([m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2], heights[i]], i * 4);
      b[i * 4] = m.gravel[i];
    }
    for (const t of this.corners) t.needsUpdate = true;
  }

  update(x, z) {
    this.centre.value.set(x, z);
    const half = PATCH_SIZE / 2;
    const moved = this.ix0 === null || Math.abs(x - (this.ix0 * CELL + half)) > RECENTRE || Math.abs(z - (this.iz0 * CELL + half)) > RECENTRE;
    const version = this.deformation?.version ?? 0;
    if (!moved && version === this.version) return;
    if (moved) {
      // Whole metres, so the edges lie on the terrain mesh's grid lines.
      const ix0 = Math.round(x - half) / CELL;
      const iz0 = Math.round(z - half) / CELL;
      const next = this.spare;
      const prev = this.cells;
      const snow = this.snow.image.data;
      const old = snow.slice();
      const sx = this.ix0 === null ? N : ix0 - this.ix0;
      const sz = this.iz0 === null ? N : iz0 - this.iz0;
      for (let iz = 0; iz < N; iz++) {
        const pz = iz + sz;
        const rowReuse = pz >= 0 && pz < N;
        for (let ix = 0; ix < N; ix++) {
          const px = ix + sx;
          const i = iz * N + ix;
          if (rowReuse && px >= 0 && px < N) {
            const j = pz * N + px;
            next.firm[i] = prev.firm[j];
            next.pack[i] = prev.pack[j];
            for (let k = 0; k < 4; k++) snow[i * 4 + k] = old[j * 4 + k];
          } else {
            const wx = (ix0 + ix) * CELL;
            const wz = (iz0 + iz) * CELL;
            const s = this.snowAt(wx, wz);
            next.firm[i] = s.firm;
            next.pack[i] = s.packDepth;
            snow[i * 4] = this.heightAt(wx, wz);
            snow[i * 4 + 1] = s.firm;
            snow[i * 4 + 2] = this.heightAt.roadSide(wx, wz);
            snow[i * 4 + 3] = s.lake;
          }
        }
      }
      this.spare = prev;
      this.cells = next;
      this.snow.needsUpdate = true;
      this.fillCorners(ix0 * CELL, iz0 * CELL);
      this.ix0 = ix0;
      this.iz0 = iz0;
      this.origin.value.set(ix0 * CELL, iz0 * CELL);
      this.onMove?.(this.bounds());
    }
    this.version = version;
    const def = this.def;
    def.fill(0);
    this.deformation?.accumulate(this.ix0, this.iz0, N, N, def);
    const { weights, data } = this;
    const { firm, pack } = this.cells;
    for (let i = 0; i < N * N; i++) {
      const d = def[i] * weights[i];
      data[i * 2] = d;
      // How packed, as the tyres feel it (snowPacking in tire/gpu-tires.js).
      const packed = pack[i] > 0 && d < 0 ? Math.min(1, -d / pack[i]) : 0;
      data[i * 2 + 1] = firm[i] + (1 - firm[i]) * packed;
    }
    this.texture.needsUpdate = true;
  }
}
