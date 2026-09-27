// OSM city around a real place: buildings and roads from vector tiles (city/vector-tiles.js),
// streamed around the car.
//
// - Road segments are indexed as tiles arrive; terrain chunks paint them (city/roads.js) and wait
//   for them with city.ensure, like they wait for the elevation tiles.
// - Buildings: one merged mesh per tile with the facade material (render/facade.js), built once
//   the tile's elevation is loaded. Tiles far from the car are dropped.
// - Colliders: each building gets its own fixed trimesh (the same triangles that are drawn) when
//   the car comes within COLLIDER_NEAR metres, and loses it past COLLIDER_FAR.
import { BufferAttribute, BufferGeometry, Mesh } from 'three/webgpu';
import { TILE_SIZE } from '../geo/projection.js';
import { buildBuildings } from './buildings.js';
import { BUCKET, indexRoads } from './roads.js';
import { CITY_ZOOM, loadCityTile } from './vector-tiles.js';
import { facadeMaterial } from '../render/facade.js';

const LOAD_RADIUS = 700; // m around the car
const DROP_RADIUS = 1600; // m
const COLLIDER_NEAR = 70; // m from a building's bounding box
const COLLIDER_FAR = 130; // m
const COLLIDERS_PER_FRAME = 24;

export function createCity({ projection, heightAt, scene }) {
  const tiles = new Map(); // "tx,ty" -> { tx, ty, state: 'loading' | 'ready', data, mesh }
  const buckets = new Map(); // road segments (city/roads.js)
  const solids = new Set(); // buildings of built tiles
  let physics = null;
  let frame = 0;

  const tileOf = (x, z) => {
    const p = projection.toPixel(x, z, CITY_ZOOM);
    return [Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE)];
  };
  function tileBounds(tx, ty) {
    const a = projection.fromPixel(tx * TILE_SIZE, ty * TILE_SIZE, CITY_ZOOM);
    const b = projection.fromPixel((tx + 1) * TILE_SIZE, (ty + 1) * TILE_SIZE, CITY_ZOOM);
    return [a.x, a.z, b.x, b.z];
  }

  function request(tx, ty) {
    const key = `${tx},${ty}`;
    let tile = tiles.get(key);
    if (tile) return tile;
    tile = { tx, ty, state: 'loading', data: null, mesh: null, promise: null };
    tiles.set(key, tile);
    tile.promise = loadCityTile(projection, tx, ty)
      .catch((error) => {
        console.warn('city tile failed', tx, ty, error);
        return { buildings: [], roads: [] };
      })
      .then(async (data) => {
        tile.data = data;
        indexRoads(data.roads, buckets);
        tile.state = 'roads';
        // Buildings stand on the terrain, so its heights must be loaded first.
        await heightAt.load(...tileBounds(tx, ty));
        if (tiles.get(key) !== tile) return;
        buildTile(tile);
        tile.state = 'ready';
      });
    return tile;
  }

  function buildTile(tile) {
    const built = buildBuildings(tile.data.buildings, heightAt);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(built.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(built.normals, 3));
    geometry.setAttribute('facade', new BufferAttribute(built.facade, 4));
    geometry.setAttribute('tint', new BufferAttribute(built.tint, 3));
    geometry.setAttribute('seed', new BufferAttribute(built.seed, 1));
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, facadeMaterial);
    mesh.name = `buildings ${tile.tx},${tile.ty}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    tile.mesh = mesh;
    tile.solids = built.solids;
    for (const s of built.solids) solids.add(s);
  }

  function dropTile(key, tile) {
    tiles.delete(key);
    if (tile.mesh) {
      scene.remove(tile.mesh);
      tile.mesh.geometry.dispose();
    }
    for (const s of tile.solids ?? []) {
      removeCollider(s);
      solids.delete(s);
    }
  }

  function removeCollider(s) {
    if (s.collider && physics) physics.world.removeCollider(s.collider, false);
    s.collider = null;
  }

  // Distance from (x, z) to a building's footprint box.
  const boxDistance = (s, x, z) => Math.hypot(Math.max(s.min.x - x, 0, x - s.max.x), Math.max(s.min.z - z, 0, z - s.max.z));

  return {
    // True when the roads under the rectangle are known; starts downloads for the others.
    ensure(x0, z0, x1, z1) {
      const [ta, tb] = tileOf(x0 - BUCKET, z0 - BUCKET);
      const [tc, td] = tileOf(x1 + BUCKET, z1 + BUCKET);
      let ready = true;
      for (let ty = tb; ty <= td; ty++) for (let tx = ta; tx <= tc; tx++) if (request(tx, ty).state === 'loading') ready = false;
      return ready;
    },
    // Resolves when the tiles under the rectangle are downloaded and built.
    async load(x0, z0, x1, z1) {
      const [ta, tb] = tileOf(x0, z0);
      const [tc, td] = tileOf(x1, z1);
      const jobs = [];
      for (let ty = tb; ty <= td; ty++) for (let tx = ta; tx <= tc; tx++) jobs.push(request(tx, ty).promise);
      await Promise.all(jobs);
    },
    // Road segments near a rectangle (for painting a terrain chunk).
    segmentsIn(x0, z0, x1, z1) {
      const out = new Set();
      for (let j = Math.floor(z0 / BUCKET); j <= Math.floor(z1 / BUCKET); j++) {
        for (let i = Math.floor(x0 / BUCKET); i <= Math.floor(x1 / BUCKET); i++) {
          for (const s of buckets.get(`${i},${j}`) ?? []) out.add(s);
        }
      }
      return [...out];
    },
    // Loads tiles around the car, drops far ones, and keeps colliders on the buildings near it.
    update(world, target) {
      physics ??= world;
      const [ctx, cty] = tileOf(target.x, target.z);
      const reach = Math.ceil(LOAD_RADIUS / (projection.metresPerPixel(CITY_ZOOM) * TILE_SIZE));
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const [x0, z0, x1, z1] = tileBounds(ctx + dx, cty + dy);
          const d = Math.hypot(Math.max(x0 - target.x, 0, target.x - x1), Math.max(z0 - target.z, 0, target.z - z1));
          if (d < LOAD_RADIUS) request(ctx + dx, cty + dy);
        }
      }
      if (frame++ % 15 === 0) {
        for (const [key, tile] of tiles) {
          const [x0, z0, x1, z1] = tileBounds(tile.tx, tile.ty);
          const d = Math.hypot(Math.max(x0 - target.x, 0, target.x - x1), Math.max(z0 - target.z, 0, target.z - z1));
          if (d > DROP_RADIUS && tile.state === 'ready') dropTile(key, tile);
        }
      }
      // Colliders: add the nearest few missing ones each frame, remove far ones.
      const { rapier, world: rapierWorld } = physics;
      let added = 0;
      for (const s of solids) {
        const d = boxDistance(s, target.x, target.z);
        if (!s.collider && d < COLLIDER_NEAR && added < COLLIDERS_PER_FRAME) {
          s.collider = rapierWorld.createCollider(rapier.ColliderDesc.trimesh(s.vertices, s.indices).setFriction(0.6));
          added++;
        } else if (s.collider && d > COLLIDER_FAR) removeCollider(s);
      }
    },
    get stats() {
      let colliders = 0;
      for (const s of solids) if (s.collider) colliders++;
      return { tiles: tiles.size, buildings: solids.size, colliders };
    },
  };
}
