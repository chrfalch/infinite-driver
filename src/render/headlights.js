// The car's lights: a spot light in each of the round lamps on the nose box, aimed a little down
// the road ahead, so they light up a wide pool in front of the car and the road a few tens of
// metres on; and the round tail lamps at the back, which glow red and throw a faint red light on
// the ground behind. H switches them all on and off at any time of day (Input.headlights); they
// fade like filaments.
import { Group, SpotLight } from 'three/webgpu';
import { HEADLAMP, headlampMaterial, TAILLAMP, tailLampMaterial } from './tube-chassis.js';
import { stretchX } from '../vehicle/physics.js';

export const HEADLIGHT = Object.freeze({
  intensity: 230, // per lamp
  decay: 1.3, // falls off slower than the physical square of distance: less glare at the bumper, more reach
  distance: 90, // m: cut-off of the beam
  angle: 0.55, // rad: half-angle of the cone
  penumbra: 0.55, // share of the cone that fades out toward its edge
  aim: { x: 20, y: -0.6 }, // where the beam centre points, from the lamp (chassis frame, m)
  toe: 0.06, // m each beam points outward at the aim
  glowOff: 0.6, // lens glow (emissiveIntensity) with the lights off and on
  glowOn: 4,
});

export const TAILLIGHT = Object.freeze({
  intensity: 3, // the red light thrown back, both lamps together
  decay: 2,
  distance: 9, // m
  angle: 1.1, // rad: a wide, soft cone
  penumbra: 1,
  aim: { x: -3, y: -1.5 }, // down onto the ground behind the car (chassis frame, m)
  glowOn: 2.2, // lens glow (emissiveIntensity) with the lights on; dark when off
});

// By day the sun drowns most of the beams: they shine at this share of their strength, rising to
// full strength in the dark (setHeadlightDarkness, from the time of day).
const DAY_BEAM = 0.12;
let beamScale = 1;
export function setHeadlightDarkness(dark) {
  beamScale = DAY_BEAM + (1 - DAY_BEAM) * dark;
}

// Below this level the lights are taken out of the scene, so with them off the materials skip
// lights they would not show.
const OFF = 0.002;

// The spot lights in the car's frame (+x forward), returned as a group to add to the car.
export function createHeadlights() {
  const group = new Group();
  group.name = 'headlights';
  group.visible = false;
  const x = stretchX(HEADLAMP.x) + 0.02;
  const lights = [1, -1].map((s) => {
    const light = new SpotLight('#fff3df', 0, HEADLIGHT.distance, HEADLIGHT.angle, HEADLIGHT.penumbra, HEADLIGHT.decay);
    light.position.set(x, HEADLAMP.y, s * HEADLAMP.z);
    light.target.position.set(x + HEADLIGHT.aim.x, HEADLAMP.y + HEADLIGHT.aim.y, s * (HEADLAMP.z + HEADLIGHT.toe * HEADLIGHT.aim.x));
    group.add(light, light.target);
    return light;
  });
  // One red light between the tail lamps stands in for both.
  const tx = stretchX(TAILLAMP.x) - 0.03;
  const tail = new SpotLight('#ff2414', 0, TAILLIGHT.distance, TAILLIGHT.angle, TAILLIGHT.penumbra, TAILLIGHT.decay);
  tail.position.set(tx, TAILLAMP.y, 0);
  tail.target.position.set(tx + TAILLIGHT.aim.x, TAILLAMP.y + TAILLIGHT.aim.y, 0);
  group.add(tail, tail.target);
  group.userData.lights = lights;
  group.userData.tail = tail;
  return group;
}

// Fade the lights and the lens glow toward on or off (`level` 0..1 is kept on the group).
export function updateHeadlights(group, on, delta) {
  const k = Math.min(1, delta / 0.08);
  const level = (group.userData.level ?? 0) + ((on ? 1 : 0) - (group.userData.level ?? 0)) * k;
  group.userData.level = level;
  group.visible = on || level > OFF;
  for (const light of group.userData.lights) light.intensity = HEADLIGHT.intensity * beamScale * level;
  group.userData.tail.intensity = TAILLIGHT.intensity * beamScale * level;
  headlampMaterial.emissiveIntensity = HEADLIGHT.glowOff + (HEADLIGHT.glowOn - HEADLIGHT.glowOff) * level;
  tailLampMaterial.emissiveIntensity = TAILLIGHT.glowOn * level;
}
