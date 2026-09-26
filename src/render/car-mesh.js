import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from 'three/webgpu';
import { CAR } from '../vehicle/config.js';

const paint = new MeshStandardMaterial({ color: '#e8744f', roughness: 0.45, metalness: 0.1 });
const glass = new MeshStandardMaterial({ color: '#2b3440', roughness: 0.15, metalness: 0.3 });
const trim = new MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.8 });
const tyre = new MeshStandardMaterial({ color: '#1c1c1c', roughness: 0.9 });
const rim = new MeshStandardMaterial({ color: '#d9d9d9', roughness: 0.35, metalness: 0.6 });
const lamp = new MeshStandardMaterial({ color: '#fff4d6', emissive: '#fff1c2', emissiveIntensity: 0.6 });
const tail = new MeshStandardMaterial({ color: '#9e1c1c', emissive: '#7a0f0f', emissiveIntensity: 0.5 });

function box(w, h, d, material, x, y, z) {
  const m = new Mesh(new BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Chassis-local: +x forward, +y up, +z right. Origin is the physics body origin.
export function createCarMesh() {
  const { x: hx, y: hy, z: hz } = CAR.halfExtents;
  const car = new Group();
  car.add(box(hx * 2, hy * 2, hz * 2, paint, 0, 0, 0));
  car.add(box(hx * 1.05, 0.42, hz * 1.8, paint, -0.2, hy + 0.21, 0));
  car.add(box(hx * 1.07, 0.3, hz * 1.84, glass, -0.2, hy + 0.2, 0));
  car.add(box(0.12, 0.2, hz * 1.9, trim, hx, -0.12, 0));
  car.add(box(0.12, 0.2, hz * 1.9, trim, -hx, -0.12, 0));
  car.add(box(0.05, 0.1, 0.3, lamp, hx + 0.02, 0.1, -hz + 0.25));
  car.add(box(0.05, 0.1, 0.3, lamp, hx + 0.02, 0.1, hz - 0.25));
  car.add(box(0.05, 0.1, 0.3, tail, -hx - 0.02, 0.1, -hz + 0.25));
  car.add(box(0.05, 0.1, 0.3, tail, -hx - 0.02, 0.1, hz - 0.25));
  return car;
}

// The outer group steers; the inner group spins around its local z (the axle).
export function createWheelMesh() {
  const steer = new Group();
  const spin = new Group();
  const tyreMesh = new Mesh(new CylinderGeometry(CAR.wheelRadius, CAR.wheelRadius, CAR.wheelWidth, 24), tyre);
  tyreMesh.rotation.x = Math.PI / 2;
  tyreMesh.castShadow = true;
  const rimMesh = new Mesh(new BoxGeometry(CAR.wheelRadius * 1.1, CAR.wheelRadius * 0.35, CAR.wheelWidth + 0.02), rim);
  const rimMesh2 = rimMesh.clone();
  rimMesh2.rotation.z = Math.PI / 2;
  spin.add(tyreMesh, rimMesh, rimMesh2);
  steer.add(spin);
  return steer;
}
