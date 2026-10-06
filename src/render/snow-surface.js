// The snow surface near the car, on the deformation grid (12.5 cm), so the ruts the tyres pack
// into the snow show as real grooves with the berms beside them. The terrain mesh is only a 1 m
// grid, so on snow it is sunk out of sight under this patch (see setGroundPatch in terrain-mesh.js).
//
// The patch is a fixed grid of vertices; a texture holds each vertex's height (the snow surface plus
// the deformation) and how packed the snow there is. It follows the car in whole metres, so its
// edges stay on the terrain mesh's grid lines, and toward the edge it fades into the terrain mesh's
// coarser surface and the deformation fades out, so the edge meets the terrain mesh exactly.
import { BufferAttribute, BufferGeometry, DataTexture, FloatType, Mesh, MeshStandardNodeMaterial, NearestFilter, RGFormat } from 'three/webgpu';
import { Fn, float, ivec2, mix, normalize, positionLocal, smoothstep, textureLoad, transformNormalToView, uniform, varying, vec2, vec3, vec4 } from 'three/tsl';
import { snowGroundColor, snowGroundRoughness } from './terrain-mesh.js';
import { DEFORM_CELL } from '../terrain/deformation.js';
import { drawnSurface } from '../terrain/drawn-surface.js';

export const PATCH_SIZE = 48; // m
const CELL = DEFORM_CELL;
const N = Math.round(PATCH_SIZE / CELL) + 1; // vertices per side
export const SNOW_PATCH_N = N;
const EDGE_FADE = 1.5; // m over which the deformation fades out toward the edge
const RECENTRE = 4; // m the car may get from the patch centre before it moves

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

// Snow colours (as on the terrain mesh, see snowGroundColor): fresh snow is bright and slightly
// blue; packed snow in a rut or on the road is greyer and smoother (it shines more), and where the
// road's snow is worn through, the asphalt shows; on the lake, black ice. `texture`: height and
// packing per vertex; `road`: signed distance to the road's centre line and distance inside the
// lake's shoreline per vertex (only rewritten when the patch moves).
function snowMaterial(texture, road, origin) {
  const material = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  // The vertex's cell (the geometry holds cell indices in x and z).
  const cell = ivec2(positionLocal.x, positionLocal.z);
  const at = (dx, dz) => textureLoad(texture, cell.add(ivec2(dx, dz)).clamp(ivec2(0, 0), ivec2(N - 1, N - 1))).x;
  const h = at(0, 0);
  material.positionNode = vec3(origin.x.add(positionLocal.x.mul(CELL)), h, origin.y.add(positionLocal.z.mul(CELL)));
  const normal = Fn(() => {
    const sx = at(1, 0).sub(at(-1, 0)).div(2 * CELL);
    const sz = at(0, 1).sub(at(0, -1)).div(2 * CELL);
    return normalize(vec3(sx.negate(), 1, sz.negate()));
  })();
  material.normalNode = transformNormalToView(normalize(varying(normal)));
  const pack = smoothstep(0.05, 0.9, varying(textureLoad(texture, cell).y));
  const place = varying(textureLoad(road, cell).xy);
  material.colorNode = vec4(snowGroundColor(place.x, pack, place.y), 1);
  material.roughnessNode = snowGroundRoughness(place.x, pack, place.y);
  return material;
}

export class SnowSurface {
  constructor(scene, heightAt, deformation) {
    this.heightAt = heightAt;
    this.coarse = drawnSurface(heightAt, true);
    this.deformation = deformation;
    this.snowAt = heightAt.snowAt;
    this.data = new Float32Array(N * N * 2);
    this.texture = new DataTexture(this.data, N, N, RGFormat, FloatType);
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.road = new DataTexture(new Float32Array(N * N * 2), N, N, RGFormat, FloatType);
    this.road.minFilter = NearestFilter;
    this.road.magFilter = NearestFilter;
    this.origin = uniform(vec2(0, 0));
    // Per vertex, kept across moves: the snow surface's height, the terrain mesh's there (the patch
    // blends into it at its edge, so the two meet without a crack), the snow's firmness and pack depth
    // (see terrain/snow.js), and where it is: the distances to the road and into the lake.
    this.cells = { base: new Float32Array(N * N), coarse: new Float32Array(N * N), firm: new Float32Array(N * N), pack: new Float32Array(N * N), side: new Float32Array(N * N), lake: new Float32Array(N * N) };
    this.spare = { base: new Float32Array(N * N), coarse: new Float32Array(N * N), firm: new Float32Array(N * N), pack: new Float32Array(N * N), side: new Float32Array(N * N), lake: new Float32Array(N * N) };
    this.def = new Float32Array(N * N);
    this.weights = edgeWeights();
    this.ix0 = null;
    this.iz0 = null;
    this.version = -1;
    this.mesh = new Mesh(patchGeometry(), snowMaterial(this.texture, this.road, this.origin));
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    // With the terrain, before the tyre tracks (which write no depth).
    this.mesh.renderOrder = -1;
    this.mesh.name = 'snow surface';
    scene.add(this.mesh);
    this.onMove = null; // (x0, z0, x1, z1) when the patch moves
  }

  // The patch's world rectangle.
  bounds() {
    const x0 = this.ix0 * CELL;
    const z0 = this.iz0 * CELL;
    return { x0, z0, x1: x0 + PATCH_SIZE, z1: z0 + PATCH_SIZE };
  }

  update(x, z) {
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
            next.base[i] = prev.base[j];
            next.coarse[i] = prev.coarse[j];
            next.firm[i] = prev.firm[j];
            next.pack[i] = prev.pack[j];
            next.side[i] = prev.side[j];
            next.lake[i] = prev.lake[j];
          } else {
            const wx = (ix0 + ix) * CELL;
            const wz = (iz0 + iz) * CELL;
            const s = this.snowAt(wx, wz);
            next.base[i] = this.heightAt(wx, wz);
            next.coarse[i] = this.coarse(wx, wz);
            next.firm[i] = s.firm;
            next.pack[i] = s.packDepth;
            next.side[i] = this.heightAt.roadSide(wx, wz);
            next.lake[i] = s.lake;
          }
        }
      }
      this.spare = prev;
      this.cells = next;
      const place = this.road.image.data;
      for (let i = 0; i < N * N; i++) {
        place[i * 2] = next.side[i];
        place[i * 2 + 1] = next.lake[i];
      }
      this.road.needsUpdate = true;
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
    const { base, coarse, firm, pack } = this.cells;
    for (let i = 0; i < N * N; i++) {
      const w = weights[i];
      const d = def[i] * w;
      data[i * 2] = coarse[i] + (base[i] - coarse[i]) * w + d;
      // How packed, as the tyres feel it (snowPacking in tire/gpu-tires.js).
      const packed = pack[i] > 0 && d < 0 ? Math.min(1, -d / pack[i]) : 0;
      data[i * 2 + 1] = firm[i] + (1 - firm[i]) * packed;
    }
    this.texture.needsUpdate = true;
  }
}
