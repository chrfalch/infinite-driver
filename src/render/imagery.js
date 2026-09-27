// Satellite imagery draped over real-world terrain chunks (see terrain/real.js): each chunk gets
// its own texture, stitched from the imagery tiles under it once they have downloaded.
import { DataTexture, MeshStandardNodeMaterial, SRGBColorSpace, Texture } from 'three/webgpu';
import { texture, uv } from 'three/tsl';
import { TILE_SIZE } from '../geo/projection.js';
import { loadTileBitmap, SATELLITE_URL } from '../geo/tiles.js';

// Zoom 19 is about 15 cm per pixel at Oslo's latitude: a 64 m chunk spans about 430 pixels.
export const IMAGERY_ZOOM = 19;
const TEXTURE_SIZE = 512;

// Grey-green shown until a chunk's imagery arrives.
const placeholder = new DataTexture(new Uint8Array([112, 118, 102, 255]), 1, 1);
placeholder.colorSpace = SRGBColorSpace;
placeholder.needsUpdate = true;

// Stitches the imagery tiles under the square [x0, x0 + size] x [z0, z0 + size] (world metres)
// into one bitmap: top row north (z0), left column west (x0).
async function stitch(projection, x0, z0, size) {
  const a = projection.toPixel(x0, z0, IMAGERY_ZOOM);
  const b = projection.toPixel(x0 + size, z0 + size, IMAGERY_ZOOM);
  const scale = TEXTURE_SIZE / (b.x - a.x);
  const jobs = [];
  for (let ty = Math.floor(a.y / TILE_SIZE); ty <= Math.floor(b.y / TILE_SIZE); ty++) {
    for (let tx = Math.floor(a.x / TILE_SIZE); tx <= Math.floor(b.x / TILE_SIZE); tx++) {
      jobs.push(loadTileBitmap(SATELLITE_URL(IMAGERY_ZOOM, tx, ty)).then((bitmap) => ({ bitmap, tx, ty })));
    }
  }
  const parts = await Promise.all(jobs);
  const canvas = new OffscreenCanvas(TEXTURE_SIZE, TEXTURE_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(112, 118, 102)';
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  // A hair of overlap hides seams between tiles drawn at fractional positions.
  const side = TILE_SIZE * scale + 0.5;
  for (const { bitmap, tx, ty } of parts) {
    if (bitmap) ctx.drawImage(bitmap, (tx * TILE_SIZE - a.x) * scale, (ty * TILE_SIZE - a.y) * scale, side, side);
  }
  return canvas.transferToImageBitmap();
}

// Material for one chunk: the placeholder at first, the stitched imagery when it is ready. The
// mesh's uv runs (0, 0) at the chunk's north-west corner to (1, 1) at its south-east corner.
export function createImageryMaterial(projection, x0, z0, size) {
  const map = texture(placeholder, uv());
  const material = new MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  material.colorNode = map;
  material.userData.imagery = { map, disposed: false };
  stitch(projection, x0, z0, size).then((bitmap) => {
    const state = material.userData.imagery;
    if (state.disposed) {
      bitmap.close();
      return;
    }
    const image = new Texture(bitmap);
    image.colorSpace = SRGBColorSpace;
    image.flipY = false;
    image.anisotropy = 8;
    image.needsUpdate = true;
    state.texture = image;
    map.value = image;
  });
  return material;
}

export function disposeImageryMaterial(material) {
  const state = material.userData.imagery;
  if (!state) return;
  state.disposed = true;
  state.texture?.dispose();
  state.texture?.image?.close?.();
  material.dispose();
}
