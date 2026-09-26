import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial } from 'three/webgpu';

const rubber = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });

// A world-space mesh whose vertices are a soft tyre's particles, with shaded tread blocks so
// rolling and squash are easy to see.
export function createSoftTireMesh(soft, mesh) {
  const { nu, nv } = mesh;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(soft.particlePositions(), 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  const colors = new Float32Array(nu * nv * 3);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const onTread = Math.cos((j / nv) * Math.PI * 2) > 0.3;
      const shade = onTread ? (i % 2 ? 0.075 : 0.025) : 0.045;
      colors.set([shade, shade * 0.96, shade * 0.9], (i * nv + j) * 3);
    }
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const object = new Mesh(geometry, rubber);
  object.castShadow = true;
  object.receiveShadow = true;
  object.frustumCulled = false;
  return object;
}

export function updateSoftTireMesh(object, soft) {
  const position = object.geometry.getAttribute('position');
  position.array.set(soft.particlePositions());
  position.needsUpdate = true;
  object.geometry.computeVertexNormals();
}
