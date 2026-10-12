// Headlights: a spot light in each of the round lamps on the nose box, aimed a little down the road
// ahead, so at night they light up a wide pool in front of the car and the road a few tens of
// metres on. H switches them on and off (Input.headlights); they fade like filaments. The lights
// stay in the scene with zero intensity when off, so switching never recompiles the materials.
import { Group, SpotLight } from 'three/webgpu';
import { HEADLAMP, headlampMaterial } from './tube-chassis.js';
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

// The beams are only cast in night worlds (setHeadlightBeams); by day the lamps just glow, and the
// materials skip two lights they would not show.
let beams = false;
export function setHeadlightBeams(on) {
  beams = on;
}

// Two spot lights in the car's frame (+x forward), returned as a group to add to the car.
export function createHeadlights() {
  const group = new Group();
  group.name = 'headlights';
  group.visible = beams;
  const x = stretchX(HEADLAMP.x) + 0.02;
  const lights = [1, -1].map((s) => {
    const light = new SpotLight('#fff3df', 0, HEADLIGHT.distance, HEADLIGHT.angle, HEADLIGHT.penumbra, HEADLIGHT.decay);
    light.position.set(x, HEADLAMP.y, s * HEADLAMP.z);
    light.target.position.set(x + HEADLIGHT.aim.x, HEADLAMP.y + HEADLIGHT.aim.y, s * (HEADLAMP.z + HEADLIGHT.toe * HEADLIGHT.aim.x));
    group.add(light, light.target);
    return light;
  });
  group.userData.lights = lights;
  return group;
}

// Fade the beams and the lens glow toward on or off (`level` 0..1 is kept on the group).
export function updateHeadlights(group, on, delta) {
  const k = Math.min(1, delta / 0.08);
  const level = (group.userData.level ?? 0) + ((on ? 1 : 0) - (group.userData.level ?? 0)) * k;
  group.userData.level = level;
  for (const light of group.userData.lights) light.intensity = HEADLIGHT.intensity * level;
  headlampMaterial.emissiveIntensity = HEADLIGHT.glowOff + (HEADLIGHT.glowOn - HEADLIGHT.glowOff) * level;
}
