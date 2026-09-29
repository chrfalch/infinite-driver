// The snow surface near the car, on the deformation grid (12.5 cm), so the ruts the tyres pack
// into the snow show as real grooves with the berms beside them. The terrain mesh is only a 1 m
// grid, so on snow it is sunk out of sight under this patch (see setSnowPatch in terrain-mesh.js).
//
// The patch is a fixed grid of vertices; a texture holds each vertex's height (ground as drawn plus
// the deformation) and how packed the snow there is. It follows the car in whole metres, so its
// edges stay on the terrain mesh's grid lines, and toward the edge the deformation fades out, so the
// edge meets the terrain mesh exactly.
import { BufferAttribute, BufferGeometry, DataTexture, FloatType, Mesh, MeshStandardNodeMaterial, NearestFilter, RGFormat } from 'three/webgpu';
import { Fn, float, ivec2, mix, normalize, positionLocal, smoothstep, textureLoad, transformNormalToView, uniform, varying, vec2, vec3, vec4 } from 'three/tsl';
import { freshSnowColor } from './terrain-mesh.js';
import { DEFORM_CELL } from '../terrain/deformation.js';
import { drawnSurface } from '../terrain/drawn-surface.js';

export const PATCH_SIZE = 48; // m
const CELL = DEFORM_CELL;
const N = Math.round(PATCH_SIZE / CELL) + 1; // vertices per side
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

function patchGeometry() {
  const positions = new Float32Array(N * N * 3);
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const i = iz * N + ix;
      positions[i * 3] = ix;
      positions[i * 3 + 2] = iz;
    }
  }
  const indices = new Uint32Array((N - 1) * (N - 1) * 6);
  let k = 0;
  for (let iz = 0; iz < N - 1; iz++) {
    for (let ix = 0; ix < N - 1; ix++) {
      const a = ix + iz * N;
      const b = a + 1;
      const c = a + N;
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

// Snow colours: fresh snow is bright and slightly blue in the shade; packed snow in a rut is a
// little greyer and smoother (it shines more), and the wind leaves faint ripples on the fresh snow.
function snowMaterial(texture, origin) {
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
  const packed = varying(textureLoad(texture, cell).y);
  const pack = smoothstep(0.05, 0.9, packed);
  material.colorNode = vec4(mix(freshSnowColor, vec3(0.76, 0.81, 0.88), pack), 1);
  material.roughnessNode = mix(float(0.95), float(0.6), pack);
  return material;
}

export class SnowSurface {
  constructor(scene, heightAt, deformation) {
    this.heightAt = heightAt;
    this.surface = drawnSurface(heightAt);
    this.deformation = deformation;
    this.packDepth = heightAt.snow.packDepth;
    this.data = new Float32Array(N * N * 2);
    this.texture = new DataTexture(this.data, N, N, RGFormat, FloatType);
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.origin = uniform(vec2(0, 0));
    this.base = new Float32Array(N * N);
    this.spare = new Float32Array(N * N);
    this.def = new Float32Array(N * N);
    this.weights = edgeWeights();
    this.ix0 = null;
    this.iz0 = null;
    this.version = -1;
    this.mesh = new Mesh(patchGeometry(), snowMaterial(this.texture, this.origin));
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
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
      const base = this.spare;
      const sx = this.ix0 === null ? N : ix0 - this.ix0;
      const sz = this.iz0 === null ? N : iz0 - this.iz0;
      for (let iz = 0; iz < N; iz++) {
        const pz = iz + sz;
        const rowReuse = pz >= 0 && pz < N;
        for (let ix = 0; ix < N; ix++) {
          const px = ix + sx;
          base[iz * N + ix] = rowReuse && px >= 0 && px < N ? this.base[pz * N + px] : this.surface((ix0 + ix) * CELL, (iz0 + iz) * CELL);
        }
      }
      this.spare = this.base;
      this.base = base;
      this.ix0 = ix0;
      this.iz0 = iz0;
      this.origin.value.set(ix0 * CELL, iz0 * CELL);
      this.onMove?.(this.bounds());
    }
    this.version = version;
    const def = this.def;
    def.fill(0);
    this.deformation?.accumulate(this.ix0, this.iz0, N, N, def);
    const { base, weights, data } = this;
    const pack = 1 / this.packDepth;
    for (let i = 0; i < N * N; i++) {
      const d = def[i] * weights[i];
      data[i * 2] = base[i] + d;
      data[i * 2 + 1] = d < 0 ? Math.min(1, -d * pack) : 0;
    }
    this.texture.needsUpdate = true;
  }
}
