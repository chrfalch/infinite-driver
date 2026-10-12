// Backdrop for the low, tilted views: a gradient sky dome and two rings of big red mesas and
// peaks on the horizon, hazed toward the sky colour. They follow the camera target, so they stay on
// the horizon however far you drive. Drawn without fog (the terrain fog would hide them).
import { createNoise2D } from 'simplex-noise';
import { BackSide, DoubleSide, BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshBasicNodeMaterial, MeshLambertMaterial, SphereGeometry } from 'three/webgpu';
import { floor, fract, hash, length, mix, normalize, positionLocal, smoothstep, vec3 } from 'three/tsl';
import { mulberry32 } from '../terrain/height.js';

export const HORIZON = new Color('#e3cfb4');
const SKY_TOP = new Color('#4f94d8');

// Per world: sky colours and the two mountain rings' foot and top colours.
const LOOKS = {
  canyon: { horizon: HORIZON, skyTop: SKY_TOP, far: ['#8a3f24', '#e08a52'], near: ['#8a3f24', '#e08a52'], steps: 4, scale: 1 },
  // Dry river: a deeper blue sky, blue-grey forested hills far off and a yellow sandstone escarpment.
  river: { horizon: new Color('#d3dde2'), skyTop: new Color('#2f78cf'), far: ['#56675e', '#8d9c93'], near: ['#5d6148', '#b59a66'], steps: 3, scale: 0.5 },
  // Dark town, at night: a starry sky with a faint glow low on the horizon, dark wooded hills
  // and mountains against it (lit like the snowfield, by the moon and the car's headlights).
  town: {
    horizon: new Color('#18222f'),
    skyTop: new Color('#02040a'),
    far: ['#090d12', '#1f2a2e'],
    near: ['#070a0d', '#1a2421'],
    steps: 8,
    scale: 0.75,
    haze: [0.6, 0.4],
    glow: 0.03,
    stars: true,
    night: true,
    fog: [20, 120],
  },
  // Snowfield, at night: a starry sky, a faint glow low on the horizon, and snow-capped ranges
  // standing dark against it. `night`: the scene is lit by the moon and the car's headlights;
  // `fog`: the perspective view's haze (near, far), closer in the dark.
  snow: {
    horizon: new Color('#1a2335'),
    skyTop: new Color('#02040a'),
    far: ['#0b0f17', '#2c3546'],
    near: ['#090c13', '#262e3d'],
    steps: 40,
    scale: 0.8,
    haze: [0.6, 0.4],
    glow: 0.05,
    stars: true,
    night: true,
    fog: [20, 120],
  },
};
export function worldLook(world) {
  return LOOKS[world] ?? LOOKS.canyon;
}

// One ring of mountains: a strip of flat-shaded quads around the target at radius ~r, with a
// mesa-like skyline (terraced noise), coloured from shadowed red at the foot to lit sandstone.
function mountainRing({ radius, height, seed, haze, colors: [footColor, topColor], horizon, steps: terraces = 4, glow = 0, segments = 180 }) {
  const noise = createNoise2D(mulberry32(seed));
  const rows = 4;
  const positions = [];
  const colors = [];
  const foot = new Color(footColor);
  const top = new Color(topColor);
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
  const vertex = (p, row) => {
    const f = row / (rows - 1);
    positions.push(p.x, -30 + (p.h + 30) * f, p.z);
    c.copy(foot).lerp(top, f * 0.9).lerp(horizon, haze);
    colors.push(c.r, c.g, c.b);
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
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();
  // `glow`: skylight scattered back off snowfields, so faces away from the sun do not go grey.
  const material = new MeshLambertMaterial({ vertexColors: true, fog: false, flatShading: true, side: DoubleSide, emissive: horizon.clone().multiplyScalar(glow) });
  return new Mesh(geometry, material);
}

export function createBackdrop(scene, world = 'canyon') {
  const look = worldLook(world);
  const group = new Group();
  group.name = 'backdrop';
  const skyMaterial = new MeshBasicNodeMaterial({ side: BackSide, fog: false, depthWrite: false });
  const up = normalize(positionLocal).y;
  let skyColor = mix(vec3(look.horizon.r, look.horizon.g, look.horizon.b), vec3(look.skyTop.r, look.skyTop.g, look.skyTop.b), smoothstep(-0.02, 0.45, up));
  if (look.stars) {
    // Stars: one in a few hundred cells of a grid on the sky's directions, a soft dot of random
    // brightness in its cell, fading out into the haze near the horizon.
    const dir = normalize(positionLocal).mul(260);
    const cell = floor(dir).add(400);
    const pick = hash(cell.x.add(cell.y.mul(800)).add(cell.z.mul(640000)));
    const dot = smoothstep(0.32, 0.08, length(fract(dir).sub(0.5)));
    const star = smoothstep(0.9965, 1, pick).mul(dot).mul(smoothstep(0.04, 0.25, up));
    skyColor = skyColor.add(vec3(0.85, 0.9, 1).mul(star.mul(2.5)));
  }
  skyMaterial.colorNode = skyColor;
  const sky = new Mesh(new SphereGeometry(1500, 32, 16), skyMaterial);
  sky.renderOrder = -2;
  group.add(sky);
  const [farHaze, nearHaze] = look.haze ?? [0.55, 0.28];
  const far = mountainRing({ radius: 900, height: 170 * look.scale, seed: 5, haze: farHaze, colors: look.far, horizon: look.horizon, steps: look.steps, glow: look.glow });
  const near = mountainRing({ radius: 520, height: 110 * look.scale, seed: 11, haze: nearHaze, colors: look.near, horizon: look.horizon, steps: look.steps, glow: look.glow });
  group.add(far, near);
  group.visible = false;
  scene.add(group);
  return {
    group,
    horizon: look.horizon,
    fog: look.fog ?? [80, 210],
    // Keep the sky centred on the camera and the mountains around the car.
    update(camera, target, visible) {
      group.visible = visible;
      if (!visible) return;
      sky.position.copy(camera.position);
      far.position.set(target.x, target.y - 8, target.z);
      near.position.set(target.x, target.y - 8, target.z);
    },
  };
}
