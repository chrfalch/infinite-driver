// Sea surface for real-world terrain: a large flat sheet at sea level that follows the camera.
// The terrain under the sea is kept shallow (see SEA_FLOOR in terrain/real.js), so this covers it.
import { Mesh, MeshStandardNodeMaterial, PlaneGeometry } from 'three/webgpu';

export const SEA_LEVEL = 0.1; // m, a little over 0 so the flat sea-level ground in the data is under water

export function createWater(scene) {
  const material = new MeshStandardNodeMaterial({ color: '#3f5f6e', roughness: 0.25, metalness: 0, transparent: true, opacity: 0.85 });
  const mesh = new Mesh(new PlaneGeometry(3000, 3000), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = SEA_LEVEL;
  mesh.receiveShadow = true;
  mesh.name = 'sea';
  scene.add(mesh);
  return {
    mesh,
    follow(camera) {
      mesh.position.x = camera.position.x;
      mesh.position.z = camera.position.z;
    },
  };
}
