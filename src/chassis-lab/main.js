// Tube chassis lab: shows one procedural tube chassis design with wheels, axles, shocks and seats
// for scale. ?design=<index>&view=<3q|side|front|top|3qr>. Drag to orbit.
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { DESIGNS, PICKUPS, createTubeChassis } from '../render/tube-chassis.js';

const params = new URLSearchParams(location.search);
const index = Number(params.get('design') ?? 0);
const view = params.get('view') ?? '3q';

const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
renderer.toneMapping = ACESFilmicToneMapping;
document.getElementById('app').append(renderer.domElement);
await renderer.init();

const scene = new Scene();
scene.background = new Color('#e9e2d3');
scene.add(new HemisphereLight('#fff6e8', '#8a7d62', 1.3));
const sun = new DirectionalLight('#fff3dc', 2.6);
sun.position.set(-4, 7, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 20 });
scene.add(sun);
const floor = new Mesh(new PlaneGeometry(40, 40), new MeshStandardMaterial({ color: '#cdbf9f', roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// Car frame: chassis origin at ride height (ground at y = -0.89 in chassis coordinates).
const RIDE = 0.89;
const car = new (await import('three/webgpu')).Group();
car.position.y = RIDE;
scene.add(car);
const { group, design } = createTubeChassis(index);
car.add(group);
document.querySelector('#label h1').textContent = `${index + 1}. ${design.name}`;
document.querySelector('#label p').textContent = design.note;

const dark = new MeshStandardMaterial({ color: '#2b2c2e', roughness: 0.55, metalness: 0.5 });
const rubber = new MeshStandardMaterial({ color: '#1f1e1d', roughness: 0.95 });
const rim = new MeshStandardMaterial({ color: '#b8b5ad', roughness: 0.35, metalness: 0.7 });
const coil = new MeshStandardMaterial({ color: '#e8c547', roughness: 0.4, metalness: 0.4 });
const seatMat = new MeshStandardMaterial({ color: '#35332f', roughness: 0.85 });
const add = (m, x, y, z) => { m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; car.add(m); return m; };
const between = (a, b, r, mat) => {
  const A = new Vector3(...a), B = new Vector3(...b);
  const d = B.clone().sub(A);
  const m = new Mesh(new CylinderGeometry(r, r, d.length(), 12), mat);
  m.position.copy(A).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), d.normalize());
  m.castShadow = true;
  car.add(m);
};
const HUB_Y = -0.45;
for (const f of [1, -1]) {
  const x = f * 1.35;
  for (const s of [1, -1]) {
    const tyre = add(new Mesh(new CylinderGeometry(0.46, 0.46, 0.32, 32), rubber), x, HUB_Y, s * 1.05);
    tyre.rotation.x = Math.PI / 2;
    const r = add(new Mesh(new CylinderGeometry(0.25, 0.25, 0.33, 24), rim), x, HUB_Y, s * 1.05);
    r.rotation.x = Math.PI / 2;
    const tread = add(new Mesh(new TorusGeometry(0.44, 0.03, 6, 32), rubber), x, HUB_Y, s * 1.05);
    // Coil-over from the shock top to the axle.
    const top = PICKUPS.shockTop(f > 0);
    const bottom = [x - f * 0.05, HUB_Y + 0.08, s * 0.72];
    between([top[0], top[1], s * top[2]], bottom, 0.03, dark);
    between([top[0], top[1] - 0.08, s * top[2]], [bottom[0], bottom[1] + 0.18, bottom[2]], 0.055, coil);
    // Links.
    const lo = PICKUPS.lowerLink(f > 0), up = PICKUPS.upperLink(f > 0);
    between([lo[0], lo[1] - 0.02, s * lo[2]], [x, HUB_Y - 0.1, s * 0.5], 0.022, dark);
    between([up[0], up[1] - 0.02, s * up[2]], [x - f * 0.05, HUB_Y + 0.12, s * 0.3], 0.02, dark);
  }
  between([x, HUB_Y, -0.9], [x, HUB_Y, 0.9], 0.05, dark);
  add(new Mesh(new SphereGeometry(0.15, 20, 14), dark), x, HUB_Y, 0.12);
}
// Seats and steering for scale.
for (const s of [1, -1]) {
  add(new Mesh(new BoxGeometry(0.5, 0.1, 0.46), seatMat), -0.2, -0.26, s * 0.3);
  const back = add(new Mesh(new BoxGeometry(0.1, 0.62, 0.46), seatMat), -0.46, 0.05, s * 0.3);
  back.rotation.z = 0.2;
}
const wheel = add(new Mesh(new TorusGeometry(0.18, 0.018, 8, 24), dark), 0.3, 0.3, -0.3);
wheel.rotation.y = Math.PI / 2;
wheel.rotation.x = 0.5;

const camera = new PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 100);
const views = { '3q': [5.2, 2.6, 5.2], '3qr': [-5.2, 2.6, 5.4], side: [0, 1.2, 8.2], front: [8.2, 1.4, 0], top: [0.01, 9, 0] };
const eye = views[view] ?? views['3q'];
let az = Math.atan2(eye[2], eye[0]);
let el = Math.atan2(eye[1], Math.hypot(eye[0], eye[2]));
const dist = Math.hypot(...eye);
const target = new Vector3(0, 0.75, 0);
const place = () => {
  camera.position.set(Math.cos(az) * Math.cos(el) * dist, Math.sin(el) * dist + target.y * 0.3, Math.sin(az) * Math.cos(el) * dist);
  camera.lookAt(target);
};
place();
let drag = null;
renderer.domElement.addEventListener('pointerdown', (e) => (drag = [e.clientX, e.clientY]));
addEventListener('pointerup', () => (drag = null));
addEventListener('pointermove', (e) => {
  if (!drag) return;
  az += (e.clientX - drag[0]) * 0.008;
  el = Math.min(1.5, Math.max(0.02, el + (e.clientY - drag[1]) * 0.006));
  drag = [e.clientX, e.clientY];
  place();
});
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
renderer.setAnimationLoop(() => renderer.render(scene, camera));
window.__lab = { designs: DESIGNS.length };
