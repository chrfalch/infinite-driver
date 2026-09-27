// Facade material for real-place buildings (city/buildings.js): one material for every wall and
// roof. Windows are drawn per pixel from the wall coordinates (u along the wall, v up it), so they
// stay sharp at any distance and cost no geometry: a grid of floors and bays varied per building,
// shop windows on the ground floor, a parapet band at the top, and a few lit rooms.
//
// Walls between the camera and the car are cut away (a dithered hole around the line of sight),
// so buildings never hide the car. Shadows are still cast by the whole building.
import { MeshStandardNodeMaterial, Vector3 } from 'three/webgpu';
import { hash2, valueNoise } from './noise.js';
import { roofArray } from './roof-imagery.js';
import { facadeTarget } from './facade-bake.js';
import {
  attribute,
  bool,
  cameraPosition,
  dot,
  float,
  floor,
  fract,
  fwidth,
  int,
  length,
  max,
  mix,
  positionWorld,
  screenCoordinate,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';

const facade = attribute('facade', 'vec4');
const u = facade.x;
const v = facade.y;
const wallHeight = facade.z;
const roof = facade.w;
const seed = attribute('seed', 'float');
const tint = attribute('tint', 'vec3');

const hash = hash2;

// A soft box: 1 inside [a, b], 0 outside, with edges blurred over w.
const band = (x, a, b, w) => smoothstep(a.sub(w), a.add(w), x).mul(smoothstep(b.add(w), b.sub(w), x));

// Floors and bays, varied per building.
const floorHeight = float(3.0).add(seed.mul(0.6));
const bayWidth = float(2.5).add(fract(seed.mul(7.13)).mul(1.6));
const col = u.div(bayWidth);
const row = v.div(floorHeight);
const cellX = fract(col);
const cellY = fract(row);
const bay = floor(col);
const storey = floor(row);
// Blur by the pixel footprint; windows smaller than a couple of pixels fade to the average.
const aa = max(fwidth(col), fwidth(row)).mul(0.8);
const farFade = smoothstep(0.45, 0.2, aa);
const halfWindow = float(0.2).add(fract(seed.mul(3.7)).mul(0.12));
const upper = band(cellX, float(0.5).sub(halfWindow), float(0.5).add(halfWindow), aa).mul(band(cellY, float(0.28), float(0.82), aa));
// Ground floor of buildings over two storeys: wide shop windows.
const shopfront = band(cellX, float(0.08), float(0.92), aa).mul(band(cellY, float(0.12), float(0.8), aa));
const tall = smoothstep(6, 7, wallHeight);
const ground = storey.lessThan(0.5).and(tall.greaterThan(0.5));
const windowShape = ground.select(shopfront, upper);
// No windows on the parapet, below the ground floor, or on very low buildings (sheds, garages).
const inWall = smoothstep(0.4, 0.9, v).mul(smoothstep(wallHeight.sub(0.5), wallHeight.sub(1.1), v)).mul(smoothstep(3.5, 4.5, wallHeight));
const windowMask = windowShape.mul(inWall).mul(farFade).mul(roof.oneMinus());

// Glass: dark blue-grey, a little different per pane, with a few warm lit rooms.
const pane = hash(vec2(bay.add(seed.mul(91)), storey));
const glass = mix(vec3(0.1, 0.13, 0.16), vec3(0.26, 0.31, 0.36), pane);
const lit = smoothstep(0.93, 0.95, hash(vec2(bay.mul(1.7), storey.add(seed.mul(13)))));
const glassColor = mix(glass, vec3(0.95, 0.78, 0.5), lit.mul(0.7));
// Walls: the building's colour with a little grime towards the ground, a darker plinth, a belt
// line over the ground floor, and a lighter parapet cap.
const grime = mix(float(0.82), float(1), smoothstep(0, 6, v));
const plinth = smoothstep(0.9, 0.7, v).mul(0.25);
const belt = band(v, floorHeight.sub(0.25), floorHeight.sub(0.05), float(0.03)).mul(tall).mul(0.12);
const cap = smoothstep(wallHeight.sub(0.35), wallHeight.sub(0.3), v).mul(0.12);
const noise = hash(floor(positionWorld.xz.mul(2.5)).add(floor(positionWorld.y.mul(2.5)))).mul(0.05).add(0.975);
const wall = tint.mul(grime).mul(float(1).sub(plinth).sub(belt).add(cap)).mul(noise);
// Average colour far away, where the windows have faded out.
const far = mix(wall, glass, windowShape.mul(inWall).mul(0.35).mul(farFade.oneMinus()));
// Roofs: per building one of dark tar, grey gravel, sheet metal or Oslo's green copper, with soft
// weathering patches (a smooth value noise, so the roof does not look like a chequerboard).
const roofPick = fract(seed.mul(17.3));
const roofBase = roofPick
  .lessThan(0.4)
  .select(vec3(0.24, 0.24, 0.25), roofPick.lessThan(0.7).select(vec3(0.42, 0.41, 0.39), roofPick.lessThan(0.9).select(vec3(0.33, 0.35, 0.37), vec3(0.36, 0.5, 0.44))));
const weathering = valueNoise(positionWorld.xz.div(4)).mul(0.6).add(valueNoise(positionWorld.xz.div(1.3)).mul(0.4));
const proceduralRoof = roofBase.mul(weathering.mul(0.18).add(0.91));
// Near the car, the real roof from satellite imagery (render/roof-imagery.js).
const roofMap = attribute('roofMap', 'vec3');
const hasImagery = roofMap.z.greaterThan(-0.5);
const imagery = texture(roofArray, roofMap.xy).depth(int(max(roofMap.z, float(0)).add(0.5)));
// The photo already has the sun's light in it, and the roof is lit again here: darken it to match.
const roofColor = hasImagery.select(imagery.rgb.mul(0.42), proceduralRoof);

// Line-of-sight cut-away around `focus` (the car).
const focus = uniform(new Vector3());
export function setFacadeFocus(p) {
  focus.value.set(p.x, p.y + 0.8, p.z);
}
const sight = focus.sub(cameraPosition);
const t = dot(positionWorld.sub(cameraPosition), sight).div(dot(sight, sight));
const off = length(positionWorld.sub(cameraPosition.add(sight.mul(t))));
// Dither the rim so the hole edge is soft.
const dither = hash(screenCoordinate.xy.floor());
const radius = float(6.5).add(dither.mul(1.5));
const blocked = t.lessThan(0.985).and(off.lessThan(radius)).and(positionWorld.y.greaterThan(focus.y.sub(1.5)));

// Near the car with ?facades=google: the real wall from the baked photos (render/facade-bake.js).
const wallMap = attribute('wallMap', 'vec3');
const hasPhoto = wallMap.z.greaterThan(-0.5).and(roof.lessThan(0.5));
const photo = texture(facadeTarget.texture, wallMap.xy).depth(int(max(wallMap.z, float(0)).add(0.5)));
const wallColor = hasPhoto.select(photo.rgb.mul(0.85), mix(far, glassColor, windowMask));

export const facadeMaterial = new MeshStandardNodeMaterial({ metalness: 0 });
facadeMaterial.colorNode = mix(wallColor, roofColor, roof);
facadeMaterial.roughnessNode = mix(mix(float(0.88), float(0.18), windowMask), float(0.8), roof);
// Glass catches some sky; lit rooms glow a little.
facadeMaterial.emissiveNode = hasPhoto.select(vec3(0), vec3(0.35, 0.42, 0.5).mul(windowMask).mul(0.12).add(vec3(0.9, 0.7, 0.4).mul(lit).mul(windowMask).mul(0.25)));
facadeMaterial.maskNode = blocked.not();
facadeMaterial.maskShadowNode = bool(true);
