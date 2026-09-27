// Satellite imagery draped over real-world terrain chunks (see terrain/real.js): each chunk gets
// its own texture, stitched from the imagery tiles under it once they have downloaded.
import { DataTexture, MeshStandardNodeMaterial, SRGBColorSpace, Texture } from 'three/webgpu';
import { abs, attribute, dot, fract, mix, positionWorld, sin, smoothstep, texture, uv, vec2, vec3 } from 'three/tsl';
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

// OSM roads painted over the imagery (see city/roads.js for the 'road' attribute): asphalt with a
// yellow centre line on two-lane roads (as in Norway), a kerb and a sidewalk on streets, and light
// paving on footpaths. The imagery's parked cars and shadows are covered on the road.
const hash = (p) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
function roadOverlay(ground) {
  const road = attribute('road', 'vec4');
  const edge = road.x;
  const centre = road.y;
  const pathEdge = road.z;
  const half = road.w;
  const grain = hash(positionWorld.xz.mul(6).floor()).mul(0.06).add(0.97);
  const patches = sin(positionWorld.x.mul(0.21).add(sin(positionWorld.z.mul(0.17)).mul(2))).mul(0.04).add(1);
  const asphalt = vec3(0.21, 0.215, 0.22).mul(grain).mul(patches);
  const onRoad = smoothstep(0.12, -0.12, edge);
  const onPath = smoothstep(0.12, -0.12, pathEdge);
  // Streets (not service lanes) have a raised kerb and a 2.5 m sidewalk.
  const street = smoothstep(2.9, 3.1, half);
  const sidewalk = smoothstep(-0.05, 0.1, edge).mul(smoothstep(2.6, 2.4, edge)).mul(street);
  const kerb = smoothstep(0.25, 0.1, abs(edge.sub(0.12))).mul(street);
  const centreLine = smoothstep(0.13, 0.07, centre).mul(street).mul(onRoad);
  const paving = vec3(0.6, 0.58, 0.54).mul(grain);
  let colour = mix(ground, paving.mul(0.95), sidewalk);
  colour = mix(colour, vec3(0.64, 0.6, 0.53).mul(grain), onPath);
  colour = mix(colour, vec3(0.55, 0.54, 0.52), kerb.mul(0.8));
  colour = mix(colour, asphalt, onRoad);
  colour = mix(colour, vec3(0.85, 0.66, 0.16), centreLine);
  return colour;
}

// Material for one chunk: the placeholder at first, the stitched imagery when it is ready. The
// mesh's uv runs (0, 0) at the chunk's north-west corner to (1, 1) at its south-east corner.
// With `roads`, the chunk mesh has a 'road' attribute and the roads are painted on.
export function createImageryMaterial(projection, x0, z0, size, { roads = false } = {}) {
  const map = texture(placeholder, uv());
  const material = new MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  material.colorNode = roads ? roadOverlay(map.rgb) : map;
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
