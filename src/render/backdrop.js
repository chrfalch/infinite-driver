// Backdrop for the low, tilted views: a gradient sky dome and two rings of big mesas and peaks on
// the horizon, hazed toward the sky colour. They follow the camera target, so they stay on the
// horizon however far you drive. Drawn without fog (the terrain fog would hide them). The sky's
// colours, the sun, the moon and the stars follow the time of day (render/daylight.js sets them).
import { createNoise2D } from 'simplex-noise';
import { BackSide, DoubleSide, BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshBasicNodeMaterial, MeshLambertNodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import { attribute, dot, floor, fract, hash, length, max, mix, normalize, positionLocal, pow, smoothstep, uniform, vec3 } from 'three/tsl';
import { mulberry32 } from '../terrain/height.js';
import { NIGHT_SKY } from './time-of-day.js';

// Per world: the sky by day (horizon, top, and the isometric views' plain background) and the two
// mountain rings' foot and top colours; `night` the same after dark (the sky defaults to NIGHT_SKY,
// the mountains to their day colours, lit by the moon).
const LOOKS = {
  canyon: {
    day: { horizon: '#e3cfb4', top: '#4f94d8', background: '#e9e2d3', far: ['#8a3f24', '#e08a52'], near: ['#8a3f24', '#e08a52'] },
    steps: 4,
    scale: 1,
  },
  // Dry river: a deeper blue sky, blue-grey forested hills far off and a yellow sandstone escarpment.
  river: {
    day: { horizon: '#d3dde2', top: '#2f78cf', background: '#e4e1d6', far: ['#56675e', '#8d9c93'], near: ['#5d6148', '#b59a66'] },
    steps: 3,
    scale: 0.5,
  },
  // Town: wooded hills and mountains around it. At night a faint glow low on the horizon, the hills
  // dark against it.
  town: {
    day: { horizon: '#d5dde2', top: '#3d84d2', background: '#dfe2df', far: ['#33433a', '#71837a'], near: ['#2b3a2a', '#5c6d50'] },
    night: { horizon: '#18222f', top: '#02040a', background: '#0b111c', far: ['#090d12', '#1f2a2e'], near: ['#070a0d', '#1a2421'] },
    steps: 8,
    scale: 0.75,
    haze: [0.6, 0.4],
    glow: 0.03,
  },
  // Sunny town: a clear blue sky, green wooded hills and blue-grey mountains hazed toward a pale
  // horizon; less haze than the others by day (`orthoFog`, `dayFog`: see render/daylight.js).
  daytown: {
    day: { horizon: '#d6e4ea', top: '#3d8ad6', background: '#d6e4ea', far: ['#5d7684', '#a7bcc4'], near: ['#3e6438', '#86a46a'] },
    steps: 8,
    scale: 0.75,
    haze: [0.55, 0.3],
    orthoFog: [170, 330],
    dayFog: [120, 320],
  },
  // Snowfield: snow-capped ranges, standing dark against a faint glow at night. `glow`: skylight
  // scattered back off the snow.
  snow: {
    day: { horizon: '#dde5ee', top: '#3a7fd0', background: '#e6ebf0', far: ['#5a6576', '#eef3f8'], near: ['#535d6b', '#e2e9f1'] },
    night: { horizon: '#1a2335', top: '#02040a', background: '#0b111c', far: ['#0b0f17', '#2c3546'], near: ['#090c13', '#262e3d'] },
    steps: 40,
    scale: 0.8,
    haze: [0.6, 0.4],
    glow: 0.05,
  },
};
const toColors = (p) => ({ ...p, horizon: new Color(p.horizon), top: new Color(p.top), background: new Color(p.background) });
for (const look of Object.values(LOOKS)) {
  look.day = toColors(look.day);
  look.night = look.night ? toColors(look.night) : { ...NIGHT_SKY, far: look.day.far, near: look.day.near };
}
export function worldLook(world) {
  return LOOKS[world] ?? LOOKS.canyon;
}

// The sky's state, set by the time of day: colours at the horizon and overhead, the directions to
// the sun and moon, the sunset glow's colour (black: none), and how dark it is (0..1: the stars,
// the mountains' night colours).
export const sky = {
  horizon: uniform(new Color()),
  top: uniform(new Color()),
  sun: uniform(new Vector3(0, 1, 0)),
  moon: uniform(new Vector3(0, -1, 0)),
  glow: uniform(new Color(0, 0, 0)),
  dark: uniform(0),
};

// One ring of mountains: a strip of flat-shaded quads around the target at radius ~r, with a
// mesa-like skyline (terraced noise), coloured from shadowed foot to lit top, by day and by night.
function mountainRing({ radius, height, seed, haze, day, night, which, steps: terraces = 4, glow = 0, segments = 180 }) {
  const noise = createNoise2D(mulberry32(seed));
  const rows = 4;
  const positions = [];
  const colors = { day: [], night: [] };
  const c = new Color();
  const profile = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a);
    const z = Math.sin(a);
    const n = 0.5 + 0.5 * noise(x * 1.6, z * 1.6) * 0.7 + 0.5 * noise(x * 5, z * 5) * 0.3;
    // Terrace the skyline into mesas and buttes.
    const steps = terraces;
    const t = Math.floor(n * steps) / steps + Math.max(0, (n * steps) % 1 - 0.75) * 4 / steps;
    const r = radius * (1 + 0.08 * noise(x * 3 + 9, z * 3));
    profile.push({ x: x * r, z: z * r, h: height * (0.25 + t) });
  }
  const shades = Object.entries({ day, night }).map(([key, p]) => [colors[key], new Color(p[which][0]), new Color(p[which][1]), p.horizon]);
  const vertex = (p, row) => {
    const f = row / (rows - 1);
    positions.push(p.x, -30 + (p.h + 30) * f, p.z);
    for (const [out, foot, top, horizon] of shades) {
      c.copy(foot).lerp(top, f * 0.9).lerp(horizon, haze);
      out.push(c.r, c.g, c.b);
    }
  };
  for (let i = 0; i < segments; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    for (let row = 0; row < rows - 1; row++) {
      vertex(a, row);
      vertex(b, row);
      vertex(a, row + 1);
      vertex(b, row);
      vertex(b, row + 1);
      vertex(a, row + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors.day), 3));
  geometry.setAttribute('nightColor', new BufferAttribute(new Float32Array(colors.night), 3));
  geometry.computeVertexNormals();
  const material = new MeshLambertNodeMaterial({ fog: false, flatShading: true, side: DoubleSide });
  material.colorNode = mix(attribute('color', 'vec3'), attribute('nightColor', 'vec3'), sky.dark);
  // `glow`: skylight scattered back off snowfields, so faces away from the sun do not go grey.
  if (glow) material.emissiveNode = sky.horizon.mul(glow);
  return new Mesh(geometry, material);
}

export function createBackdrop(scene, world = 'canyon') {
  const look = worldLook(world);
  const group = new Group();
  group.name = 'backdrop';
  const skyMaterial = new MeshBasicNodeMaterial({ side: BackSide, fog: false, depthWrite: false });
  const view = normalize(positionLocal);
  const up = view.y;
  let skyColor = mix(sky.horizon, sky.top, smoothstep(-0.02, 0.45, up));
  // Sunset glow: the sky around the sun (and low down on its side) takes the sun's colour.
  const toSun = max(dot(view, sky.sun), 0);
  skyColor = skyColor.add(sky.glow.mul(pow(toSun, 6).mul(0.8).add(pow(toSun, 48).mul(0.6))));
  // The sun's and moon's discs, a little soft at the rim; the moon only after dark.
  skyColor = mix(skyColor, vec3(1, 0.97, 0.88), smoothstep(0.99955, 0.9997, toSun));
  skyColor = mix(skyColor, vec3(0.86, 0.9, 0.97), smoothstep(0.99955, 0.9997, dot(view, sky.moon)).mul(sky.dark));
  // Stars: one in a few hundred cells of a grid on the sky's directions, a soft dot of random
  // brightness in its cell, fading out into the haze near the horizon, only in the dark.
  const dir = view.mul(260);
  const cell = floor(dir).add(400);
  const pick = hash(cell.x.add(cell.y.mul(800)).add(cell.z.mul(640000)));
  const spot = smoothstep(0.32, 0.08, length(fract(dir).sub(0.5)));
  const star = smoothstep(0.9965, 1, pick).mul(spot).mul(smoothstep(0.04, 0.25, up)).mul(sky.dark);
  skyMaterial.colorNode = skyColor.add(vec3(0.85, 0.9, 1).mul(star.mul(2.5)));
  const dome = new Mesh(new SphereGeometry(1500, 32, 16), skyMaterial);
  dome.renderOrder = -2;
  group.add(dome);
  const [farHaze, nearHaze] = look.haze ?? [0.55, 0.28];
  const ring = { day: look.day, night: look.night, steps: look.steps, glow: look.glow };
  const far = mountainRing({ radius: 900, height: 170 * look.scale, seed: 5, haze: farHaze, which: 'far', ...ring });
  const near = mountainRing({ radius: 520, height: 110 * look.scale, seed: 11, haze: nearHaze, which: 'near', ...ring });
  group.add(far, near);
  group.visible = false;
  scene.add(group);
  return {
    group,
    // Keep the sky centred on the camera and the mountains around the car.
    update(camera, target, visible) {
      group.visible = visible;
      if (!visible) return;
      dome.position.copy(camera.position);
      far.position.set(target.x, target.y - 8, target.z);
      near.position.set(target.x, target.y - 8, target.z);
    },
  };
}
