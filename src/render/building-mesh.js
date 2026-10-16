// The town's modelled buildings' material (render/town-kit-mesh.js): their colours come with the
// model, the glass is glossy and lights up at night, and surface detail is drawn per pixel.
//
// Any building between the camera and the car is cut away around the line of sight (a dithered
// hole), so the car stays in view among tall buildings.
import { MeshStandardNodeMaterial, Vector3 } from 'three/webgpu';
import { abs, attribute, cross, dot, float, floor, fract, hash, length, mix, normalWorld, positionWorld, screenCoordinate, smoothstep, step, uniform, vec2, vec3, vec4 } from 'three/tsl';

const baseColor = attribute('color', 'vec3');

// The cutaway: fragments near the line from the car toward the camera, on the camera's side of
// the car, are dropped in a dither pattern that thins out toward the hole's edge.
const carPosition = uniform(new Vector3(0, -1000, 0));
const toCamera = uniform(new Vector3(0, 1, 0));
const rel = positionWorld.sub(carPosition);
const along = dot(rel, toCamera);
const across = length(cross(rel, toCamera));
const hole = smoothstep(8, 4.5, across).mul(smoothstep(1.5, 4, along));
const dither = hash(vec2(screenCoordinate.x.floor(), screenCoordinate.y.floor()).dot(vec2(1, 113.7)));

// At night the glass is lit, warm and of varying brightness.
const night = uniform(0);
export function setBuildingNight(level) {
  night.value = Number(level);
}

// The models' glass is the `glass` attribute. Surface detail is drawn per pixel (no textures, no
// extra triangles): rows of tiles on the sloping roofs, brick courses on brick walls, a faint
// mottling on stucco, and the walls darkening toward the ground.
const kitGlass = attribute('glass', 'float');
const kitSurface = attribute('surface', 'float'); // 1 stucco wall, 2 brick wall (else 0)
const kitLevel = attribute('level', 'float'); // m above the building's ground
const ny = abs(normalWorld.y);
const runs = positionWorld.x.add(positionWorld.z); // a coordinate along any wall or roof
// Tiles: on slopes (not flat roofs or walls), a dark line under each row and staggered joints.
const sloped = smoothstep(0.2, 0.3, ny).mul(smoothstep(0.97, 0.9, ny)).mul(float(1).sub(kitGlass));
const tileRow = fract(kitLevel.mul(2.8));
const tileJoint = fract(runs.mul(1.6).add(floor(kitLevel.mul(2.8)).mul(0.5)));
const tiles = smoothstep(0.78, 0.95, tileRow).mul(0.2).add(smoothstep(0.9, 0.97, tileJoint).mul(0.08)).mul(sloped);
// Brick: 0.22 m courses with light mortar, half-brick bond.
const wallish = smoothstep(0.3, 0.15, ny);
const course = fract(kitLevel.div(0.22));
const head = fract(runs.div(0.48).add(floor(kitLevel.div(0.22)).mul(0.5)));
const mortar = float(1).sub(smoothstep(0.08, 0.16, course).mul(smoothstep(0.04, 0.1, head)));
const brick = step(1.5, kitSurface).mul(wallish).mul(mortar);
// Stucco: weathered in patches a couple of metres across.
const mottle = hash(floor(positionWorld.x.div(1.7)).add(floor(positionWorld.y.div(1.3)).mul(17.1)).add(floor(positionWorld.z.div(1.7)).mul(5.3))).sub(0.5).mul(0.06);
const stucco = step(0.5, kitSurface).mul(step(kitSurface, 1.5)).mul(wallish);
// Darker toward the ground (light bounced off the street and blocked by the neighbours).
const grounded = mix(float(0.74), float(1), smoothstep(0, 2.2, kitLevel)).mul(wallish).add(float(1).sub(wallish));
const kitColor = mix(baseColor.mul(float(1).sub(tiles)).mul(float(1).add(mottle.mul(stucco))), vec3(0.82, 0.78, 0.7), brick.mul(0.55)).mul(grounded);
export const kitBuildingMaterial = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
kitBuildingMaterial.colorNode = vec4(mix(kitColor, baseColor, kitGlass), 1);
kitBuildingMaterial.roughnessNode = mix(float(0.85), float(0.15), kitGlass);
kitBuildingMaterial.metalnessNode = kitGlass.mul(0.3);
const kitLit = hash(positionWorld.x.mul(0.7).floor().add(positionWorld.y.mul(0.4).floor().mul(31.7)).add(positionWorld.z.mul(0.7).floor().mul(7.3)));
kitBuildingMaterial.emissiveNode = vec3(1, 0.7, 0.38).mul(kitGlass).mul(step(0.5, kitLit).mul(kitLit.mul(0.8).add(0.4))).mul(night).mul(0.75);
kitBuildingMaterial.maskNode = hole.lessThan(dither.mul(0.98).add(0.01));
// The shadows stay whole.
kitBuildingMaterial.maskShadowNode = float(1).greaterThan(0);

// Where the car is and the direction from it toward the camera (called every frame). No car (the
// cockpit view, where nothing stands between the camera and the car): no hole.
export function setBuildingCutaway(car, camera) {
  if (!car) return carPosition.value.set(0, -1000, 0);
  carPosition.value.set(car.x, car.y + 0.6, car.z);
  toCamera.value.subVectors(camera.position, carPosition.value).normalize();
}
