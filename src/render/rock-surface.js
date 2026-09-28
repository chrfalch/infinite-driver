// Draws the dry river's rock sheet (terrain/rock-sheet.js builds its vertex data).
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial } from 'three/webgpu';

// Smooth-shaded: the sheet's normals come from its grid (see rockSheetData).
export const rockSheetMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });

export function createRockSheetMesh(data) {
  if (!data) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, rockSheetMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'rock sheet';
  return mesh;
}
