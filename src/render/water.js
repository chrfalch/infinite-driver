// The town's water (terrain/town.js): one sheet at the water level that travels with the
// car, so the river and the ponds show wherever the ground dips below it. Clear teal, with small
// moving ripples that catch the sun; the bed shows through, darker where it is deeper (the
// terrain's colours, render/terrain-mesh.js).
import { Mesh, MeshStandardNodeMaterial, PlaneGeometry } from 'three/webgpu';
import { mix, normalize, positionWorld, sin, time, transformNormalToView, vec3 } from 'three/tsl';

const SIZE = 330; // m, about the streamed terrain (2 chunks each way of the car's)

export function createWater(scene, level) {
  const material = new MeshStandardNodeMaterial({ transparent: true, roughness: 0.1, metalness: 0, depthWrite: false });
  const x = positionWorld.x;
  const z = positionWorld.z;
  const a = sin(x.mul(0.9).add(z.mul(0.4)).add(time.mul(1.6)));
  const b = sin(x.mul(-0.5).add(z.mul(1.1)).add(time.mul(1.2)));
  const c = sin(x.mul(2.3).add(z.mul(1.7)).sub(time.mul(2.4)));
  material.normalNode = transformNormalToView(normalize(vec3(a.mul(0.07).add(c.mul(0.04)), 1, b.mul(0.07).sub(c.mul(0.03)))));
  material.colorNode = mix(vec3(0.13, 0.42, 0.5), vec3(0.28, 0.6, 0.65), a.mul(b).mul(0.5).add(0.5).mul(0.5));
  material.opacity = 0.8;
  const mesh = new Mesh(new PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), material);
  mesh.name = 'water';
  mesh.position.y = level;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return {
    mesh,
    // Keep the sheet centred on the car.
    update(x, z) {
      mesh.position.x = x;
      mesh.position.z = z;
    },
  };
}
