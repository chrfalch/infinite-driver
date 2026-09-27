// Google Photorealistic 3D Tiles over real-world terrain (?place=...&tiles=google, with the Map
// Tiles API key in VITE_GOOGLE_MAPS_KEY). The tiles are only drawn: the car still drives on the
// elevation terrain (terrain/real.js), which is kept as an invisible shadow catcher under them.
//
// The tiles come in Earth-centred coordinates. The reorientation plugin puts the place at the
// origin with +x west and +z north; a half turn about y gives the game's +x east, +z south. The
// tiles' heights are above the WGS84 ellipsoid while the terrain's are above sea level (about
// 40 m apart around Oslo), so the tiles are shifted down to sit on the terrain: the shift is
// the median gap between the two over a grid of points around the car, measured again as the
// car travels.
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { GLTFExtensionsPlugin, ReorientationPlugin, TileCompressionPlugin, UnloadTilesPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { Group, MeshBasicNodeMaterial, Raycaster, Vector3 } from 'three/webgpu';

const RECALIBRATE_EVERY = 250; // m travelled
const GRID = 5; // raycasts per side
const GRID_SPACING = 12; // m between raycasts
// Only detailed tiles are measured: the coarse ones that load first are metres off.
const MAX_TILE_ERROR = 4; // m (a tile's geometric error)
const MAX_GAP = 150; // m, a sanity limit (the geoid is within about 110 m of the ellipsoid)

export function createPhotoTiles({ key, place, scene, renderer, heightAt }) {
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true }));
  const draco = new DRACOLoader();
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new UnloadTilesPlugin());
  const rad = Math.PI / 180;
  tiles.registerPlugin(new ReorientationPlugin({ lat: place.lat * rad, lon: place.lon * rad, height: 0 }));

  // Photographed light and shade are baked into the textures, so the tiles are drawn unlit.
  tiles.addEventListener('load-model', ({ scene: model }) => {
    model.traverse((child) => {
      if (!child.isMesh) return;
      const old = child.material;
      child.material = new MeshBasicNodeMaterial({ map: old.map, side: old.side });
      old.dispose();
    });
  });
  tiles.addEventListener('dispose-model', ({ scene: model }) => {
    model.traverse((child) => {
      if (child.isMesh) child.material.dispose();
    });
  });

  const holder = new Group();
  holder.name = 'photo tiles';
  holder.rotation.y = Math.PI;
  holder.add(tiles.group);
  scene.add(holder);

  let camera = null;
  let calibratedAt = null; // { x, z } of the last height calibration
  // Finer tiles replace coarse ones as they load, so measure again whenever a batch finishes.
  let loadedMore = false;
  tiles.addEventListener('tiles-load-end', () => {
    loadedMore = true;
  });
  const raycaster = new Raycaster();
  raycaster.firstHitOnly = true;
  const origin = new Vector3();
  const down = new Vector3(0, -1, 0);

  // Median gap between the terrain and the tiles' surface around (x, z), or null when too few
  // tiles are loaded there yet. The median ignores roofs and treetops.
  function measureOffset(x, z) {
    const gaps = [];
    const half = ((GRID - 1) * GRID_SPACING) / 2;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const px = x - half + i * GRID_SPACING;
        const pz = z - half + j * GRID_SPACING;
        origin.set(px, 2000, pz);
        raycaster.set(origin, down);
        const hit = raycaster.intersectObject(tiles.group, true)[0];
        if (hit && hit.object.userData.tile?.geometricError <= MAX_TILE_ERROR) gaps.push(heightAt(px, pz) - hit.point.y);
      }
    }
    if (gaps.length < (GRID * GRID) / 2) return null;
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  return {
    tiles,
    get ready() {
      return calibratedAt !== null;
    },
    update(activeCamera, target) {
      if (activeCamera !== camera) {
        if (camera) tiles.deleteCamera(camera);
        camera = activeCamera;
        tiles.setCamera(camera);
      }
      tiles.setResolutionFromRenderer(camera, renderer);
      camera.updateMatrixWorld();
      tiles.update();

      // Height calibration once tiles are there, after each batch of loads, and every few
      // hundred metres travelled.
      const far = !calibratedAt || Math.hypot(target.x - calibratedAt.x, target.z - calibratedAt.z) > RECALIBRATE_EVERY;
      if (far || loadedMore) {
        loadedMore = false;
        const gap = measureOffset(target.x, target.z);
        if (gap !== null && Math.abs(gap) < MAX_GAP) {
          holder.position.y += gap;
          holder.updateMatrixWorld();
          calibratedAt = { x: target.x, z: target.z };
        }
      }
    },
    dispose() {
      scene.remove(holder);
      tiles.dispose();
      draco.dispose();
    },
  };
}
