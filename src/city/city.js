// OSM city around a real place: buildings, roads and ground areas from vector tiles
// (city/vector-tiles.js), streamed around the car.
//
// - Road segments are indexed as tiles arrive; terrain chunks paint them (city/roads.js) and wait
//   for them with city.ensure, like they wait for the elevation tiles.
// - Ground: each terrain chunk gets a ground map (city/ground.js) from the areas, buildings and
//   roads under it, which also places its trees.
// - Buildings: one merged mesh per 128 m group with the facade material (render/facade.js), built
//   once the tile's elevation is loaded; groups near the car get satellite imagery on their roofs
//   (render/roof-imagery.js). Tiles far from the car are dropped.
// - Colliders: each building gets its own fixed trimesh (the same triangles that are drawn) when
//   the car comes within COLLIDER_NEAR metres, and loses it past COLLIDER_FAR.
import { BufferAttribute, BufferGeometry, DataTexture, DataUtils, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Mesh, RGBAFormat } from 'three/webgpu';
import { TILE_SIZE } from '../geo/projection.js';
import { buildBuildings } from './buildings.js';
import { GROUND_RES, placeTrees, rasterizeGround } from './ground.js';
import { BUCKET, indexRoads, roadAt } from './roads.js';
import { CITY_ZOOM, loadCityTile } from './vector-tiles.js';
import { facadeMaterial } from '../render/facade.js';
import { createRoofImagery } from '../render/roof-imagery.js';

const LOAD_RADIUS = 700; // m around the car
const DROP_RADIUS = 1600; // m
const COLLIDER_NEAR = 70; // m from a building's bounding box
const COLLIDER_FAR = 130; // m
const COLLIDERS_PER_FRAME = 24;
const GROUP = 128; // m, building groups (one mesh and one roof imagery layer each)

export function createCity({ projection, heightAt, scene }) {
  const tiles = new Map(); // "tx,ty" -> { tx, ty, state: 'loading' | 'roads' | 'ready', data, groups, solids }
  const buckets = new Map(); // road segments (city/roads.js)
  const shapes = new Map(); // "i,j" bucket -> ground areas, buildings and roads near it
  const grounds = new Map(); // chunk "x0,z0" -> { pixels, texture }
  let groundCtx = null;
  const roofs = createRoofImagery(projection);
  const groups = new Set(); // building groups of built tiles
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
    tile = { tx, ty, state: 'loading', data: null, groups: null, solids: null, promise: null };
    tiles.set(key, tile);
    tile.promise = loadCityTile(projection, tx, ty)
      .catch((error) => {
        console.warn('city tile failed', tx, ty, error);
        return { buildings: [], roads: [], areas: [] };
      })
      .then(async (data) => {
        tile.data = data;
        indexRoads(data.roads, buckets);
        indexShapes(data);
        tile.state = 'roads';
        // Buildings stand on the terrain, so its heights must be loaded first.
        await heightAt.load(...tileBounds(tx, ty));
        if (tiles.get(key) !== tile) return;
        buildTile(tile);
        tile.state = 'ready';
      });
    return tile;
  }

  // Buckets every ground area, building and road by its bounding box.
  function indexShapes({ areas, buildings, roads }) {
    const add = (kind, item, points) => {
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (const p of points) {
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        z0 = Math.min(z0, p.z);
        z1 = Math.max(z1, p.z);
      }
      const pad = kind === 'roads' ? item.half + 1 : 0;
      for (let j = Math.floor((z0 - pad) / BUCKET); j <= Math.floor((z1 + pad) / BUCKET); j++) {
        for (let i = Math.floor((x0 - pad) / BUCKET); i <= Math.floor((x1 + pad) / BUCKET); i++) {
          const key = `${i},${j}`;
          let cell = shapes.get(key);
          if (!cell) shapes.set(key, (cell = { areas: [], buildings: [], roads: [] }));
          cell[kind].push(item);
        }
      }
    };
    for (const a of areas) add('areas', a, a.rings.flat());
    for (const b of buildings) add('buildings', b, b.outer);
    for (const r of roads) add('roads', r, r.points);
  }

  function shapesIn(x0, z0, x1, z1) {
    const out = { areas: new Set(), buildings: new Set(), roads: new Set() };
    for (let j = Math.floor(z0 / BUCKET); j <= Math.floor(z1 / BUCKET); j++) {
      for (let i = Math.floor(x0 / BUCKET); i <= Math.floor(x1 / BUCKET); i++) {
        const cell = shapes.get(`${i},${j}`);
        if (!cell) continue;
        for (const kind of ['areas', 'buildings', 'roads']) for (const item of cell[kind]) out[kind].add(item);
      }
    }
    return { areas: [...out.areas], buildings: [...out.buildings], roads: [...out.roads] };
  }

  function buildTile(tile) {
    // Buildings go in the group of the cell their first corner is in.
    const cells = new Map();
    for (const b of tile.data.buildings) {
      const key = `${Math.floor(b.outer[0].x / GROUP)},${Math.floor(b.outer[0].z / GROUP)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(b);
    }
    tile.groups = [];
    tile.solids = [];
    for (const [key, buildings] of cells) {
      const group = buildGroup(buildings);
      if (!group) continue;
      group.mesh.name = `buildings ${key}`;
      scene.add(group.mesh);
      tile.groups.push(group);
      groups.add(group);
      for (const s of group.solids) {
        tile.solids.push(s);
        solids.add(s);
      }
    }
  }

  function buildGroup(buildings) {
    const built = buildBuildings(buildings, heightAt);
    if (!built.solids.length) return null;
    const bounds = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
    for (const s of built.solids) {
      bounds.x0 = Math.min(bounds.x0, s.min.x);
      bounds.z0 = Math.min(bounds.z0, s.min.z);
      bounds.x1 = Math.max(bounds.x1, s.max.x);
      bounds.z1 = Math.max(bounds.z1, s.max.z);
    }
    // Roof vertices map into the group's box for the roof imagery: (u, v, layer = -1 for none).
    const count = built.positions.length / 3;
    const roofMap = new Float32Array(count * 3);
    const roofVertices = [];
    for (let i = 0; i < count; i++) {
      roofMap[i * 3 + 2] = -1;
      if (built.facade[i * 4 + 3] < 0.5 || built.normals[i * 3 + 1] < 0.5) continue;
      roofMap[i * 3] = (built.positions[i * 3] - bounds.x0) / (bounds.x1 - bounds.x0);
      roofMap[i * 3 + 1] = (built.positions[i * 3 + 2] - bounds.z0) / (bounds.z1 - bounds.z0);
      roofVertices.push(i);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(built.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(built.normals, 3));
    geometry.setAttribute('facade', new BufferAttribute(built.facade, 4));
    geometry.setAttribute('tint', new BufferAttribute(built.tint, 3));
    geometry.setAttribute('seed', new BufferAttribute(built.seed, 1));
    geometry.setAttribute('roofMap', new BufferAttribute(roofMap, 3));
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, facadeMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { mesh, bounds, roofVertices, layer: -1, solids: built.solids };
  }

  function dropTile(key, tile) {
    tiles.delete(key);
    for (const group of tile.groups ?? []) {
      scene.remove(group.mesh);
      group.mesh.geometry.dispose();
      group.disposed = true;
      roofs.release(group);
      groups.delete(group);
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
    // Ground map of a terrain chunk (the square [x0, x0 + size]^2): its RGBA bytes and a texture
    // (see city/ground.js), and the road field on the same grid (city/roads.js). Kept until the
    // chunk is unloaded (releaseGround).
    groundFor(x0, z0, size) {
      const key = `${x0},${z0}`;
      let ground = grounds.get(key);
      if (!ground) {
        groundCtx ??= new OffscreenCanvas(GROUND_RES, GROUND_RES).getContext('2d', { willReadFrequently: true });
        const pixels = rasterizeGround(groundCtx, shapesIn(x0, z0, x0 + size, z0 + size), x0, z0, size);
        const texture = new DataTexture(new Uint8Array(pixels.buffer.slice(0)), GROUND_RES, GROUND_RES);
        // (Data textures default to nearest filtering, which shows every texel as a block.)
        texture.magFilter = LinearFilter;
        texture.minFilter = LinearMipmapLinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = 4;
        texture.needsUpdate = true;
        const segments = this.segmentsIn(x0, z0, x0 + size, z0 + size);
        const field = new Float32Array(4);
        const half = new Uint16Array(GROUND_RES * GROUND_RES * 4);
        const step = size / GROUND_RES;
        for (let j = 0; j < GROUND_RES; j++) {
          for (let i = 0; i < GROUND_RES; i++) {
            roadAt(segments, x0 + (i + 0.5) * step, z0 + (j + 0.5) * step, field);
            const o = (j * GROUND_RES + i) * 4;
            for (let c = 0; c < 4; c++) half[o + c] = DataUtils.toHalfFloat(field[c]);
          }
        }
        const roadMap = new DataTexture(half, GROUND_RES, GROUND_RES, RGBAFormat, HalfFloatType);
        roadMap.magFilter = LinearFilter;
        roadMap.minFilter = LinearMipmapLinearFilter;
        roadMap.generateMipmaps = true;
        roadMap.needsUpdate = true;
        ground = { pixels, texture, roadMap, x0, z0, size };
        grounds.set(key, ground);
      }
      return ground;
    },
    releaseGround(x0, z0) {
      const key = `${x0},${z0}`;
      grounds.get(key)?.texture.dispose();
      grounds.get(key)?.roadMap.dispose();
      grounds.delete(key);
    },
    // Trees of a terrain chunk, from its ground map.
    treesFor(x0, z0, size, seed) {
      const ground = this.groundFor(x0, z0, size);
      return placeTrees(ground.pixels, heightAt, x0, z0, size, seed);
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
      if (frame % 10 === 0) roofs.update(groups, target);
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
      let roofImagery = 0;
      for (const g of groups) if (g.layer >= 0) roofImagery++;
      return { tiles: tiles.size, buildings: solids.size, colliders, groups: groups.size, roofImagery };
    },
  };
}
