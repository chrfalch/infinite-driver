// Draws the dry river's rock sheet (terrain/rock-sheet.js builds its vertex data).
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { modelWorldMatrix, normalize, positionLocal, transformNormalToView, varying, vec3, vec4 } from 'three/tsl';
import { rutAt } from './rut-map.js';
import { bump, riverGroundMaterial } from './river-ground.js';

// Flat-shaded (face normals in the shader), so each 25 cm triangle of the chipped sheet is a hard
// facet and the boulders read as broken rock, not smooth humps.
// ?ground=<look> swaps in one of the prototype looks (render/river-ground.js).
export const rockSheetMaterial =
  riverGroundMaterial() ?? new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true });

// The ruts near the car on the sheet: the tyres rut its soil pockets (terrain/riverbed.js); `ruts`
// is the ground patch's deformation texture (render/rut-map.js). The vertex shader lowers the sheet
// by them (on its 25 cm grid, coarser than the patch's 12.5 cm). With a node look, the ruts also
// tilt the normal.
export function showRutsOnSheet(ruts) {
  const world = modelWorldMatrix.mul(vec4(positionLocal, 1));
  const rut = rutAt(ruts, world.x, world.z);
  rockSheetMaterial.positionNode = positionLocal.add(vec3(0, rut, 0));
  const normal = rockSheetMaterial.userData.worldNormal;
  if (normal) rockSheetMaterial.normalNode = transformNormalToView(bump(normalize(normal), varying(rut)));
  rockSheetMaterial.needsUpdate = true;
}

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
  // With the ground (render/ground-surface.js), before the tyre tracks, which write no depth.
  mesh.renderOrder = -1;
  mesh.name = 'rock sheet';
  return mesh;
}
