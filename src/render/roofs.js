// Loads the straight skeleton Wasm module (CGAL, via the straight-skeleton package) for pitched
// roofs (city/buildings.js). Browser only: the package's build needs a window.
import skeletonPackage from 'straight-skeleton';
import { setRoofSkeleton } from '../city/buildings.js';

export async function initRoofs() {
  const { SkeletonBuilder } = skeletonPackage;
  await SkeletonBuilder.init();
  setRoofSkeleton((rings) => SkeletonBuilder.buildFromPolygon(rings));
}
