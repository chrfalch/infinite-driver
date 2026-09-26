// Backdrop for the low, tilted views: a gradient sky dome and two rings of big red mesas and
// peaks on the horizon, hazed toward the sky colour. They follow the camera target, so they stay on
// the horizon however far you drive. Drawn without fog (the terrain fog would hide them).
import { createNoise2D } from 'simplex-noise';
import { BackSide, DoubleSide, BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshBasicNodeMaterial, MeshLambertMaterial, SphereGeometry } from 'three/webgpu';
import { mix, normalize, positionLocal, smoothstep, vec3 } from 'three/tsl';
import { mulberry32 } from '../terrain/height.js';

export const HORIZON = new Color('#e3cfb4');
const SKY_TOP = new Color('#4f94d8');

// One ring of mountains: a strip of flat-shaded quads around the target at radius ~r, with a
// mesa-like skyline (terraced noise), coloured from shadowed red at the foot to lit sandstone.
function mountainRing({ radius, height, seed, haze, segments = 180 }) {
  const noise = createNoise2D(mulberry32(seed));
  const rows = 4;
  const positions = [];
  const colors = [];
  const foot = new Color('#8a3f24');
  const top = new Color('#e08a52');
  const c = new Color();
  const profile = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a);
    const z = Math.sin(a);
    const n = 0.5 + 0.5 * noise(x * 1.6, z * 1.6) * 0.7 + 0.5 * noise(x * 5, z * 5) * 0.3;
    // Terrace the skyline into mesas and buttes.
    const steps = 4;
    const t = Math.floor(n * steps) / steps + Math.max(0, (n * steps) % 1 - 0.75) * 4 / steps;
    const r = radius * (1 + 0.08 * noise(x * 3 + 9, z * 3));
    profile.push({ x: x * r, z: z * r, h: height * (0.25 + t) });
  }
  const vertex = (p, row) => {
    const f = row / (rows - 1);
    positions.push(p.x, -30 + (p.h + 30) * f, p.z);
    c.copy(foot).lerp(top, f * 0.9).lerp(HORIZON, haze);
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
  const material = new MeshLambertMaterial({ vertexColors: true, fog: false, flatShading: true, side: DoubleSide });
  return new Mesh(geometry, material);
}

export function createBackdrop(scene) {
  const group = new Group();
  group.name = 'backdrop';
  const skyMaterial = new MeshBasicNodeMaterial({ side: BackSide, fog: false, depthWrite: false });
  const up = normalize(positionLocal).y;
  skyMaterial.colorNode = mix(vec3(HORIZON.r, HORIZON.g, HORIZON.b), vec3(SKY_TOP.r, SKY_TOP.g, SKY_TOP.b), smoothstep(-0.02, 0.45, up));
  const sky = new Mesh(new SphereGeometry(1500, 32, 16), skyMaterial);
  sky.renderOrder = -2;
  group.add(sky);
  const far = mountainRing({ radius: 900, height: 170, seed: 5, haze: 0.55 });
  const near = mountainRing({ radius: 520, height: 110, seed: 11, haze: 0.28 });
  group.add(far, near);
  group.visible = false;
  scene.add(group);
  return {
    group,
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
