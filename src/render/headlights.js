// The car's lights: a spot light in each of the round lamps on the nose box (or the body's headlamps), aimed a little down
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

// The spot lights themselves, made once and reused by every car built after (only the player's car
// has lights). three's lighting keys each lit material's shader on the scene's lights by their ids,
// so new lights after a rebuild (any panel change) rebuilt every material in the scene: a half-second
// stall. The same lights keep those shaders.
let spotLights = null;
function sharedSpotLights() {
  spotLights ??= {
    heads: [1, -1].map(() => new SpotLight('#fff3df', 0, HEADLIGHT.distance, HEADLIGHT.angle, HEADLIGHT.penumbra, HEADLIGHT.decay)),
    tail: new SpotLight('#ff2414', 0, TAILLIGHT.distance, TAILLIGHT.angle, TAILLIGHT.penumbra, TAILLIGHT.decay),
  };
  return spotLights;
}

// The spot lights in the car's frame (+x forward), returned as a group to add to the car. `lamp`:
// the headlamps' centre (design frame, right side), the round lamps' unless the body has its own.
// The lights move into the new group (out of the last car's, which is being taken down).
export function createHeadlights({ lamp = HEADLAMP } = {}) {
  const group = new Group();
  group.name = 'headlights';
  // The lights stay in the scene when off (at zero intensity): adding or taking them out changes
  // every lit material's shader, and switching them on stalled the drive while those compiled.
  // In the scene from the start, those shaders are compiled with the rest on the loading screen.
  const shared = sharedSpotLights();
  const x = stretchX(lamp.x) + 0.02;
  const lights = [1, -1].map((s, i) => {
    const light = shared.heads[i];
    light.intensity = 0;
    light.position.set(x, lamp.y, s * lamp.z);
    light.target.position.set(x + HEADLIGHT.aim.x, lamp.y + HEADLIGHT.aim.y, s * (lamp.z + HEADLIGHT.toe * HEADLIGHT.aim.x));
    group.add(light, light.target);
    return light;
  });
  // One red light between the tail lamps stands in for both.
  const tx = stretchX(TAILLAMP.x) - 0.03;
  const tail = shared.tail;
  tail.intensity = 0;
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
  for (const light of group.userData.lights) light.intensity = HEADLIGHT.intensity * beamScale * level;
  group.userData.tail.intensity = TAILLIGHT.intensity * beamScale * level;
  headlampMaterial.emissiveIntensity = HEADLIGHT.glowOff + (HEADLIGHT.glowOn - HEADLIGHT.glowOff) * level;
  tailLampMaterial.emissiveIntensity = TAILLIGHT.glowOn * level;
}
