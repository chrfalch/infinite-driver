import { createNoise2D } from 'simplex-noise';
import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, exp, fract, mix, positionWorld, sin, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { gravelShade } from '../terrain/gravel.js';
import { GROUND } from '../tire/config.js';
import { mulberry32 } from '../terrain/height.js';
import { CHUNK_RES, CHUNK_SIZE } from '../terrain/chunk.js';

// Ground colour from the vertex colours, with the gravel stones drawn on top (the same stones the
// GPU tyres roll over; see terrain/gravel.js).
const gravelAmount = uniform(GROUND.gravel);
export function setGravelAmount(value) {
  gravelAmount.value = value;
}
export const terrainMaterial = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
// 'gravel' (0..1 per vertex) keeps the stones off steep rock faces. 'roadDist' (m from the road
// centre line) paints the road and its two worn ruts per pixel, so edges stay crisp on the 1 m mesh.
const roadDist = attribute('roadDist', 'float');
const roadMask = smoothstep(4.3, 2.9, roadDist);
const rut = roadDist.sub(1.05);
const rutWear = exp(rut.mul(rut).div(-0.13));
const roadColor = mix(vec3(0.8, 0.69, 0.54), vec3(0.69, 0.55, 0.4), rutWear.mul(0.8));
// Steep faces: horizontal sandstone strata from the world height, per pixel ('steep' per vertex),
// so the bands stay level across the tall triangles of a cliff.
const layer = positionWorld.y.div(2.1).add(sin(positionWorld.x.mul(0.07).add(positionWorld.z.mul(0.05))).mul(0.45));
const pick = fract(layer.floor().mul(0.618));
const strata = mix(mix(vec3(0.78, 0.36, 0.19), vec3(0.88, 0.53, 0.29), smoothstep(0, 0.5, pick)), vec3(0.94, 0.77, 0.6), smoothstep(0.55, 1, pick));
const seam = smoothstep(0.86, 0.97, fract(layer)).mul(0.25);
const rock = strata.mul(seam.oneMinus());
const ground = mix(attribute('color', 'vec3'), rock, attribute('steep', 'float'));
terrainMaterial.colorNode = vec4(
  mix(ground, roadColor, roadMask).mul(
    mix(vec3(1), gravelShade(), gravelAmount.clamp(0, 1).sqrt().mul(attribute('gravel', 'float'))),
  ),
  1,
);

const DIRT = new Color('#c2ab82');
const DRY = new Color('#b4ad84');
const GRASS = new Color('#98a36f');
const ROCK = new Color('#8a8074');
const tmp = new Color();
const patchNoise = createNoise2D(mulberry32(4242));
const fineNoise = createNoise2D(mulberry32(777));

function colorFor(h, slope, x, z, out) {
  // Soft patches of dirt, dry grass, and greener grass so motion reads on flat ground.
  const p = patchNoise(x * 0.035, z * 0.035) * 0.7 + patchNoise(x * 0.11, z * 0.11) * 0.3;
  if (p < 0) out.copy(DIRT).lerp(DRY, Math.min(1, (p + 0.6) / 0.6));
  else out.copy(DRY).lerp(GRASS, Math.min(1, p / 0.5));
  out.offsetHSL(0, 0, fineNoise(x * 0.6, z * 0.6) * 0.025 + h * 0.004);
  // Steep faces show rock.
  out.lerp(ROCK, Math.min(1, Math.max(0, (slope - 0.35) / 0.3)));
  return out;
}

// Canyon palette: pale dusty road with darker worn ruts, red-brown dust on the valley and
// foothills (greener near the road), and sandstone strata in orange, red and cream on steep faces.
const ROAD = new Color('#dcc6a2');
const RUT = new Color('#bd9e78');
const DUST = new Color('#c98a5c');
const DUST_DARK = new Color('#b36f47');
const VERGE = new Color('#a8a86a');
const MESA_TOP = new Color('#cf9466');
const band = new Color();

function canyonColor(s, slope, x, z, out) {
  const p = patchNoise(x * 0.04, z * 0.04) * 0.6 + patchNoise(x * 0.13, z * 0.13) * 0.4;
  out.copy(DUST).lerp(DUST_DARK, Math.min(1, Math.max(0, p * 0.8 + 0.3)));
  // Greener verges along the road edge and on the valley floor.
  const verge = Math.max(0, 1 - Math.abs(s.dist - 6.5) / 5) * (0.5 + 0.5 * patchNoise(x * 0.09 + 3, z * 0.09));
  out.lerp(VERGE, verge * 0.55);
  // Flat ledges on the mesas are lighter.
  if (s.rock > 1) out.lerp(MESA_TOP, 0.35);
  out.offsetHSL(0, 0, fineNoise(x * 0.6, z * 0.6) * 0.02);
  return out;
}

function slopeAt(heightAt, x, z) {
  const e = 0.5;
  const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return Math.hypot(dx, dz);
}

// Ground colour at a world position, matching the terrain mesh (used by the tyre tracks and soil).
export function terrainColorAt(heightAt, x, z, out = new Color()) {
  const slope = slopeAt(heightAt, x, z);
  if (heightAt.sample) {
    const s = heightAt.sample(x, z);
    canyonColor(s, slope, x, z, out);
    if (s.road > 0) out.lerp(band.copy(ROAD).lerp(RUT, s.rut * 0.8), s.road);
    return out;
  }
  return colorFor(heightAt(x, z), slope, x, z, out);
}

export function createChunkMesh(heightAt, heights, cx, cz, size = CHUNK_SIZE, res = CHUNK_RES) {
  const n = res + 1;
  const step = size / res;
  const x0 = cx * size;
  const z0 = cz * size;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const gravel = new Float32Array(n * n);
  const roadDist = new Float32Array(n * n).fill(99);
  const steep = new Float32Array(n * n);
  // Heights on the grid plus a one-sample border, so normals come from the grid (central
  // differences) and still match the neighbouring chunks.
  const m = n + 2;
  const grid = new Float32Array(m * m);
  for (let iz = -1; iz <= n; iz++) {
    for (let ix = -1; ix <= n; ix++) {
      const inside = ix >= 0 && ix < n && iz >= 0 && iz < n;
      grid[ix + 1 + (iz + 1) * m] = inside ? heights[ix + iz * n] : heightAt(x0 + ix * step, z0 + iz * step);
    }
  }
  const at = (ix, iz) => grid[ix + 1 + (iz + 1) * m];

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = ix + iz * n;
      const x = x0 + ix * step;
      const z = z0 + iz * step;
      const h = heights[i];
      positions.set([x, h, z], i * 3);
      const dx = (at(ix + 1, iz) - at(ix - 1, iz)) / (2 * step);
      const dz = (at(ix, iz + 1) - at(ix, iz - 1)) / (2 * step);
      const len = Math.hypot(dx, 1, dz);
      normals.set([-dx / len, 1 / len, -dz / len], i * 3);
      const slope = Math.hypot(dx, dz);
      if (heightAt.sample) {
        const s = heightAt.sample(x, z);
        canyonColor(s, slope, x, z, tmp);
        roadDist[i] = s.dist;
      } else colorFor(h, slope, x, z, tmp);
      colors.set([tmp.r, tmp.g, tmp.b], i * 3);
      gravel[i] = 1 - Math.min(1, Math.max(0, (slope - 0.4) / 0.4));
      if (heightAt.sample) steep[i] = Math.min(1, Math.max(0, (slope - 0.55) / 0.5));
    }
  }

  const indices = new Uint32Array(res * res * 6);
  let k = 0;
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const a = ix + iz * n;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('gravel', new BufferAttribute(gravel, 1));
  geometry.setAttribute('roadDist', new BufferAttribute(roadDist, 1));
  geometry.setAttribute('steep', new BufferAttribute(steep, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();

  const mesh = new Mesh(geometry, terrainMaterial);
  mesh.receiveShadow = true;
  mesh.name = `chunk ${cx},${cz}`;
  return mesh;
}
