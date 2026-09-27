// Procedural ground material for real-place terrain chunks: the chunk's ground map (city/ground.js)
// says how much lawn, forest floor, paving, water or worn ground each spot is, and each surface is
// drawn here from noise, so it is sharp up close and needs no photo downloads. Roads are painted
// on top (render/imagery.js roadOverlay).
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { float, fract, fwidth, max, min, mix, positionWorld, smoothstep, texture, uv, vec2, vec3 } from 'three/tsl';
import { hash2, valueNoise } from './noise.js';
import { roadOverlay } from './imagery.js';

const xz = positionWorld.xz;
// Two scales of soft patches plus a fine speckle, shared by the natural surfaces.
const broad = valueNoise(xz.div(9)).mul(0.65).add(valueNoise(xz.div(3.1)).mul(0.35));
const speckle = hash2(xz.mul(5).floor());

// Lawn: greens with lighter and drier patches.
const lawn = mix(vec3(0.2, 0.33, 0.12), vec3(0.33, 0.44, 0.17), broad).mul(speckle.mul(0.1).add(0.95));
// Forest floor: dark moss, needles and earth.
const forest = mix(vec3(0.14, 0.18, 0.09), vec3(0.27, 0.23, 0.14), valueNoise(xz.div(2.3))).mul(speckle.mul(0.14).add(0.93));
// Paving: 60 x 40 cm stone slabs in running bond, joints fading out where they get too small.
const slab = vec2(0.6, 0.4);
const cell = xz.div(slab);
const row = cell.y.floor();
const bond = vec2(cell.x.add(row.mul(0.5)), cell.y);
const inSlab = fract(bond);
const joint = min(min(inSlab.x, inSlab.x.oneMinus()), min(inSlab.y, inSlab.y.oneMinus()));
const jointWidth = max(fwidth(bond.x), fwidth(bond.y));
const jointFade = smoothstep(0.35, 0.15, jointWidth);
const jointMask = smoothstep(jointWidth.mul(1.5).add(0.04), jointWidth.add(0.02), joint).mul(jointFade);
const slabTone = hash2(bond.floor()).mul(0.08).add(0.96);
const paving = vec3(0.56, 0.55, 0.52).mul(slabTone).mul(broad.mul(0.08).add(0.96)).mul(float(1).sub(jointMask.mul(0.3)));
// Water: dark and smooth, a little lighter in ripples.
const water = mix(vec3(0.08, 0.15, 0.19), vec3(0.12, 0.21, 0.25), valueNoise(xz.div(1.7)));
// Where OSM says nothing (mostly open urban ground between blocks): grey gravel and hard-packed
// earth with a few tufts of grass.
const worn = mix(vec3(0.47, 0.46, 0.42), vec3(0.37, 0.4, 0.3), broad.mul(broad)).mul(speckle.mul(0.12).add(0.94));

// The ground map's borders are 0.5 m texels; a little noise breaks up their straight edges.
const wobble = vec2(valueNoise(xz.div(1.3)), valueNoise(xz.div(1.3).add(17))).sub(0.5).mul(0.012);

// groundMap: the chunk's surface mix; roadMap: its road field (city/roads.js) at the same 0.5 m
// resolution, finer than the 1 m terrain vertices, so road edges stay straight.
export function createCityGroundMaterial(groundMap, roadMap) {
  const mix4 = texture(groundMap, uv().add(wobble)).rgb;
  const w = min(min(mix4.r, mix4.g), mix4.b);
  const wLawn = mix4.r.sub(w);
  const wForest = mix4.g.sub(w);
  const wPaving = mix4.b.sub(w);
  const wWorn = max(float(0), float(1).sub(max(max(mix4.r, mix4.g), mix4.b)));
  const ground = lawn.mul(wLawn).add(forest.mul(wForest)).add(paving.mul(wPaving)).add(water.mul(w)).add(worn.mul(wWorn));
  const material = new MeshStandardNodeMaterial({ metalness: 0 });
  material.colorNode = roadOverlay(ground, texture(roadMap, uv()));
  material.roughnessNode = mix(float(0.92), float(0.2), w);
  return material;
}
