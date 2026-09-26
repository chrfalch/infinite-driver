// A V8 for the engine bay behind the seats (visual only): block and oil pan, two cylinder heads at
// 90° with valve covers, intake manifold with a round air cleaner, a header per bank into a
// collector and exhaust pipe, a gearbox behind the engine, and a radiator at the back of the car.
// Chassis-local coordinates; the crankshaft runs along x.
import {
  BoxGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three/webgpu';

const iron = new MeshStandardMaterial({ color: '#3b3e42', roughness: 0.55, metalness: 0.6 });
const alloy = new MeshStandardMaterial({ color: '#a7aaad', roughness: 0.35, metalness: 0.8 });
const valveCover = new MeshStandardMaterial({ color: '#b3261e', roughness: 0.35, metalness: 0.5 });
const chrome = new MeshStandardMaterial({ color: '#d9d9d9', roughness: 0.15, metalness: 0.95 });
const header = new MeshStandardMaterial({ color: '#8a6f55', roughness: 0.5, metalness: 0.7 });
const core = new MeshStandardMaterial({ color: '#2a2c2e', roughness: 0.8, metalness: 0.3 });

export function createV8({ x = -0.92, y = -0.12, length = 0.58 } = {}) {
  const group = new Group();
  const add = (geometry, material, px, py, pz, rx = 0, ry = 0, rz = 0) => {
    const m = new Mesh(geometry, material);
    m.position.set(px, py, pz);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  // Block and oil pan.
  add(new BoxGeometry(length, 0.26, 0.3), iron, x, y, 0);
  add(new BoxGeometry(length * 0.8, 0.08, 0.24), iron, x, y - 0.17, 0);
  // Heads and valve covers, one bank each side at 45° from vertical.
  for (const s of [1, -1]) {
    const bank = 0.78 * s; // rad
    const hz = s * 0.17;
    const hy = y + 0.17;
    add(new BoxGeometry(length * 0.95, 0.1, 0.17), iron, x, hy, hz, bank);
    const vz = hz + s * 0.06;
    add(new BoxGeometry(length * 0.88, 0.05, 0.14), valveCover, x, hy + 0.06, vz, bank);
    // Header: four primaries out of the head, down and back into a collector.
    for (let c = 0; c < 4; c++) {
      const px = x + length * (0.36 - c * 0.24);
      const start = new Vector3(px, hy - 0.03, s * 0.27);
      const pts = [
        start,
        new Vector3(px, hy - 0.08, s * 0.36),
        new Vector3(px - 0.06, y - 0.12, s * 0.37),
        new Vector3(x - length * 0.55, y - 0.2, s * 0.3),
      ];
      add(new TubeGeometry(new CatmullRomCurve3(pts), 16, 0.017, 8), header, 0, 0, 0);
    }
    // Collector and exhaust pipe running back under the rear frame.
    const exhaust = [
      new Vector3(x - length * 0.55, y - 0.2, s * 0.3),
      new Vector3(x - length * 0.9, y - 0.22, s * 0.3),
      new Vector3(-1.9, y - 0.12, s * 0.32),
      new Vector3(-2.3, y - 0.05, s * 0.3),
    ];
    add(new TubeGeometry(new CatmullRomCurve3(exhaust), 24, 0.03, 10), header, 0, 0, 0);
    add(new CylinderGeometry(0.036, 0.036, 0.1, 14), chrome, -2.34, y - 0.04, s * 0.3, 0, 0, Math.PI / 2);
  }
  // Intake manifold, carburettor, and a round chrome air cleaner.
  add(new BoxGeometry(length * 0.8, 0.08, 0.2), alloy, x, y + 0.2, 0);
  add(new BoxGeometry(0.12, 0.06, 0.12), alloy, x, y + 0.27, 0);
  add(new CylinderGeometry(0.15, 0.15, 0.07, 32), chrome, x, y + 0.33, 0);
  add(new CylinderGeometry(0.03, 0.03, 0.02, 12), chrome, x, y + 0.375, 0);
  // Front of the engine (toward the seats): timing cover, pulleys and a belt.
  const front = x + length / 2;
  add(new BoxGeometry(0.04, 0.24, 0.24), alloy, front + 0.02, y + 0.02, 0);
  add(new CylinderGeometry(0.07, 0.07, 0.03, 20), alloy, front + 0.055, y - 0.07, 0, 0, 0, Math.PI / 2);
  add(new CylinderGeometry(0.055, 0.055, 0.03, 20), alloy, front + 0.055, y + 0.1, 0, 0, 0, Math.PI / 2);
  add(new TorusGeometry(0.11, 0.008, 6, 24), core, front + 0.055, y + 0.015, 0, 0, Math.PI / 2, 0);
  // Gearbox behind the engine, above the rear differential.
  const back = x - length / 2;
  add(new CylinderGeometry(0.15, 0.11, 0.14, 20), alloy, back - 0.06, y, 0, 0, 0, Math.PI / 2);
  add(new BoxGeometry(0.34, 0.18, 0.2), alloy, back - 0.3, y + 0.02, 0);
  // Radiator at the back of the car, leaning back, with its fan shroud.
  add(new BoxGeometry(0.06, 0.4, 0.56), core, -2.2, 0.28, 0, 0, 0, -0.35);
  add(new BoxGeometry(0.02, 0.42, 0.58), alloy, -2.17, 0.29, 0, 0, 0, -0.35);
  add(new CylinderGeometry(0.17, 0.17, 0.05, 24), iron, -2.12, 0.27, 0, 0, 0, Math.PI / 2 - 0.35);
  return group;
}
