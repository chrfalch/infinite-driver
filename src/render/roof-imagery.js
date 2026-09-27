// Real roofs: satellite imagery on the roofs of the building groups near the car (city/city.js).
//
// Each group of buildings (a 128 m cell) that is near enough gets a layer of one shared texture
// array, filled with the imagery over the group's bounding box, and its roof vertices get that
// layer number in their 'roofMap' attribute (u, v, layer; layer -1 = procedural roof). One array
// keeps a single facade material (render/facade.js) for every building. When all layers are in
// use, the farthest group gives its layer up and goes back to the procedural roof.
import { DataArrayTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three/webgpu';
import { drawImagery } from './imagery.js';

export const ROOF_LAYER_SIZE = 512; // px
export const ROOF_LAYERS = 40;
const NEAR = 450; // m: groups within this get imagery
const TILES_ACROSS = 4; // imagery tiles across a group's longer side (zoom is picked for this)
const MAX_ZOOM = 19;

export const roofArray = new DataArrayTexture(new Uint8Array(ROOF_LAYER_SIZE * ROOF_LAYER_SIZE * 4 * ROOF_LAYERS), ROOF_LAYER_SIZE, ROOF_LAYER_SIZE, ROOF_LAYERS);
roofArray.colorSpace = SRGBColorSpace;
roofArray.magFilter = LinearFilter;
roofArray.minFilter = LinearMipmapLinearFilter;
roofArray.generateMipmaps = true;
roofArray.needsUpdate = true;

// Zoom at which TILES_ACROSS imagery tiles cover `extent` metres.
function zoomFor(projection, extent) {
  for (let z = MAX_ZOOM; z > 12; z--) if (projection.metresPerPixel(z) * 256 * TILES_ACROSS >= extent) return z;
  return 12;
}

export function createRoofImagery(projection) {
  const owners = new Array(ROOF_LAYERS).fill(null); // group per layer
  let ctx = null;
  let loading = 0;

  function setLayer(group, layer) {
    group.layer = layer;
    const attr = group.mesh.geometry.getAttribute('roofMap');
    for (const i of group.roofVertices) attr.array[i * 3 + 2] = layer;
    attr.needsUpdate = true;
  }

  async function fill(group, layer) {
    loading++;
    try {
      ctx ??= new OffscreenCanvas(ROOF_LAYER_SIZE, ROOF_LAYER_SIZE).getContext('2d', { willReadFrequently: true });
      const { x0, z0, x1, z1 } = group.bounds;
      const zoom = zoomFor(projection, Math.max(x1 - x0, z1 - z0));
      // The canvas is shared: update() starts one fill at a time.
      await drawImagery(ctx, projection, x0, z0, x1, z1, zoom, ROOF_LAYER_SIZE, ROOF_LAYER_SIZE);
      if (owners[layer] !== group) return;
      const pixels = ctx.getImageData(0, 0, ROOF_LAYER_SIZE, ROOF_LAYER_SIZE).data;
      roofArray.image.data.set(pixels, layer * ROOF_LAYER_SIZE * ROOF_LAYER_SIZE * 4);
      roofArray.addLayerUpdate(layer);
      roofArray.needsUpdate = true;
      setLayer(group, layer);
    } finally {
      loading--;
    }
  }

  return {
    // groups: every building group with { bounds, mesh, roofVertices, layer }; target: the car.
    update(groups, target) {
      // One download batch at a time (the canvas is shared).
      if (loading) return;
      const dist = (g) => Math.hypot(Math.max(g.bounds.x0 - target.x, 0, target.x - g.bounds.x1), Math.max(g.bounds.z0 - target.z, 0, target.z - g.bounds.z1));
      let best = null;
      let bestD = NEAR;
      for (const g of groups) {
        if (g.layer >= 0 || g.pending || !g.roofVertices.length) continue;
        const d = dist(g);
        if (d < bestD) {
          best = g;
          bestD = d;
        }
      }
      if (!best) return;
      // A free layer, or the one of the farthest group that is farther than this one.
      let layer = owners.indexOf(null);
      if (layer < 0) {
        let far = bestD;
        owners.forEach((g, i) => {
          const d = g.disposed ? Infinity : dist(g);
          if (d > far) {
            far = d;
            layer = i;
          }
        });
        if (layer < 0) return;
        const old = owners[layer];
        if (!old.disposed) setLayer(old, -1);
      }
      owners[layer] = best;
      best.pending = true;
      fill(best, layer).finally(() => {
        best.pending = false;
      });
    },
    release(group) {
      const i = owners.indexOf(group);
      if (i >= 0) owners[i] = null;
    },
  };
}
