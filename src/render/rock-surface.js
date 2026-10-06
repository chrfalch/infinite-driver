// Draws the dry river's rock sheet (terrain/rock-sheet.js builds its vertex data).
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial } from 'three/webgpu';
import { riverGroundMaterial } from './river-ground.js';

// Flat-shaded (face normals in the shader), so each 25 cm triangle of the chipped sheet is a hard
// facet and the boulders read as broken rock, not smooth humps.
// ?ground=<look> swaps in one of the prototype looks (render/river-ground.js).
export const rockSheetMaterial = riverGroundMaterial() ?? new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });

export function createRockSheetMesh(data) {
  if (!data) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
  if (data.ground) geometry.setAttribute('ground', new BufferAttribute(data.ground, 4));
  if (data.aboveBed) geometry.setAttribute('aboveBed', new BufferAttribute(data.aboveBed, 1));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, rockSheetMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'rock sheet';
  return mesh;
}
