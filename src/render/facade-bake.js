// Facade photos: the real walls from Google's photorealistic 3D tiles, baked onto the OSM
// buildings near the car (?facades=google, needs VITE_GOOGLE_MAPS_KEY). The buildings keep their
// clean geometry and exact colliders; only their walls' colour comes from the photos.
//
// A hidden scene holds the 3D tiles, loaded at full detail only in a sphere around the group
// being baked (LoadRegionPlugin, no camera needed). Each wall is then drawn from the front by an
// orthographic camera that sees only a thin slab around the wall plane (1.5 m in front, 3 m
// behind), which leaves out most street trees, cars and neighbouring buildings. The walls of a
// group are packed into one atlas (city/atlas.js), a layer of a layered render target shared by
// the FACADE_LAYERS groups nearest the car.
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { GLTFExtensionsPlugin, LoadRegionPlugin, ReorientationPlugin, SphereRegion, TileCompressionPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import {
  Color,
  Group,
  LinearFilter,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  Raycaster,
  RenderTarget,
  Scene,
  Sphere,
  SRGBColorSpace,
  Vector3,
} from 'three/webgpu';
import { packWalls } from '../city/atlas.js';

export const FACADE_SIZE = 2048;
export const FACADE_LAYERS = 4;
const NEAR = 220; // m: groups within this get photos
const WALLS_PER_FRAME = 8; // each costs three raycasts and a render
const MIN_WALL = 1.5; // m: shorter walls keep the procedural look
const SLAB_FRONT = 1; // m in front of the photographed facade that is still drawn
const SLAB_BACK = 2.5; // m behind it

export const facadeTarget = new RenderTarget(FACADE_SIZE, FACADE_SIZE, { depth: FACADE_LAYERS, depthBuffer: true });
facadeTarget.texture.isArrayTexture = true;
facadeTarget.texture.colorSpace = SRGBColorSpace;
facadeTarget.texture.magFilter = LinearFilter;
facadeTarget.texture.minFilter = LinearFilter;
facadeTarget.texture.generateMipmaps = false;

const MEASURE_PER_FRAME = 12; // buildings whose height is measured per frame
const HEIGHT_TOLERANCE = 2.5; // m: OSM wall heights closer than this to the photos are kept

function insideRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

const GAP_COLOUR = new Color('#8a8a86'); // where a wall's photo has holes
const clearColor = new Color();

export function createFacadeBaker({ key, place, renderer, heightAt }) {
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true }));
  const draco = new DRACOLoader();
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.registerPlugin(new TileCompressionPlugin());
  const rad = Math.PI / 180;
  tiles.registerPlugin(new ReorientationPlugin({ lat: place.lat * rad, lon: place.lon * rad, height: 0 }));
  const regions = new LoadRegionPlugin();
  tiles.registerPlugin(regions);
  const region = new SphereRegion({ errorTarget: 1 });
  // Photographed light is in the textures: unlit.
  tiles.addEventListener('load-model', ({ scene: model }) => {
    model.traverse((child) => {
      if (!child.isMesh) return;
      const old = child.material;
      child.material = new MeshBasicNodeMaterial({ map: old.map, side: 2 });
      old.dispose();
    });
  });
  tiles.addEventListener('dispose-model', ({ scene: model }) => {
    model.traverse((child) => child.isMesh && child.material.dispose());
  });

  // No background: a scene background clears the whole target at the start of every render,
  // which would wipe the walls drawn before. The layer is cleared once per group instead.
  const scene = new Scene();
  const holder = new Group();
  holder.rotation.y = Math.PI; // the plugin's +x west, +z north -> the game's +x east, +z south
  holder.add(tiles.group);
  scene.add(holder);

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  const raycaster = new Raycaster();
  raycaster.firstHitOnly = true;
  const owners = new Array(FACADE_LAYERS).fill(null);
  let job = null; // { group, layer, stage, rects, next }
  let calibrated = false;
  // A batch of loads has finished since the current job started.
  tiles.addEventListener('tiles-load-end', () => {
    if (job) job.loadEnded = true;
  });

  // Gaps between the terrain and the detailed tiles' surface over a grid across the box, and the
  // share of the grid that detailed tiles cover (the bake waits until most of it is covered).
  function survey(b) {
    const gaps = [];
    const n = 6;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = b.x0 + ((i + 0.5) / n) * (b.x1 - b.x0);
        const z = b.z0 + ((j + 0.5) / n) * (b.z1 - b.z0);
        raycaster.set(new Vector3(x, 3000, z), new Vector3(0, -1, 0));
        const hit = raycaster.intersectObject(tiles.group, true)[0];
        if (hit && hit.object.userData.tile?.geometricError <= 4) gaps.push(heightAt(x, z) - hit.point.y);
      }
    }
    return { gaps, coverage: gaps.length / (n * n) };
  }

  // Height of the tiles over the terrain. In a city most of the grid lands on roofs (where the
  // gap is a building's height too low), so the ground is taken from the upper quarter of the
  // gaps, not the median.
  function calibrate(gaps) {
    gaps.sort((a, c) => a - c);
    const gap = gaps[Math.floor(gaps.length * 0.75)];
    if (Math.abs(gap) > 150) return false;
    holder.position.y += gap;
    holder.updateMatrixWorld(true);
    return true;
  }

  // A building's wall and roof heights as photographed, over the lowest ground under it (the
  // same ground city/buildings.js builds on): the eaves are the median roof hit 1.5 m inside the
  // middle of its longest edges, the ridge a high percentile of hits on a grid inside it (so a
  // chimney or a tower does not count). Null when too few hits.
  const INSIDE = 1.5;
  const down = new Vector3(0, -1, 0);
  function roofHit(x, z) {
    raycaster.set(from.set(x, 3000, z), down);
    return raycaster.intersectObject(tiles.group, true)[0]?.point.y ?? null;
  }
  function measureHeight(b) {
    const ring = b.outer;
    let ground = Infinity;
    let area = 0;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      ground = Math.min(ground, heightAt(p.x, p.z));
      area += p.x * q.z - q.x * p.z;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const side = area > 0 ? 1 : -1; // as in city/buildings.js: outward normal = side * (dz, -dx)
    const edges = ring
      .map((p, i) => ({ p, q: ring[(i + 1) % ring.length] }))
      .map((e) => ({ ...e, len: Math.hypot(e.q.x - e.p.x, e.q.z - e.p.z) }))
      .filter((e) => e.len > INSIDE * 3)
      .sort((a, c) => c.len - a.len)
      .slice(0, 6);
    const eaves = [];
    for (const { p, q, len } of edges) {
      const x = (p.x + q.x) / 2 - (side * (q.z - p.z) * INSIDE) / len;
      const z = (p.z + q.z) / 2 + (side * (q.x - p.x) * INSIDE) / len;
      if (!insideRing(ring, x, z)) continue;
      const y = roofHit(x, z);
      if (y !== null) eaves.push(y - ground);
    }
    if (eaves.length < 2) return null;
    eaves.sort((a, c) => a - c);
    const eave = eaves[Math.floor(eaves.length / 2)];
    const tops = [];
    const n = 4;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = minX + ((i + 0.5) / n) * (maxX - minX);
        const z = minZ + ((j + 0.5) / n) * (maxZ - minZ);
        if (!insideRing(ring, x, z)) continue;
        const y = roofHit(x, z);
        if (y !== null) tops.push(y - ground);
      }
    }
    tops.sort((a, c) => a - c);
    const ridge = tops.length >= 3 ? tops[Math.floor(tops.length * 0.8)] : eave;
    return { eave, ridge };
  }

  // Only the walls whose photo was found use the layer.
  function setLayer(group, layer) {
    group.facadeLayer = layer;
    const attr = group.mesh.geometry.getAttribute('wallMap');
    for (const w of group.walls) {
      const l = layer >= 0 && group.bakedWalls?.has(w) ? layer : -1;
      for (let k = 0; k < 6; k++) attr.array[(w.first + k) * 3 + 2] = l;
    }
    attr.needsUpdate = true;
  }

  // Atlas coordinates of a wall's 6 vertices, from what the front camera sees: image x runs
  // along `right` (the camera's right), image y down from the wall's top.
  function mapWall(group, w, rect) {
    const attr = group.mesh.geometry.getAttribute('wallMap');
    const pos = group.mesh.geometry.getAttribute('position');
    const rx = w.nz;
    const rz = -w.nx;
    const cx = (w.ax + w.bx) / 2;
    const cz = (w.az + w.bz) / 2;
    for (let k = 0; k < 6; k++) {
      const i = w.first + k;
      const along = (pos.getX(i) - cx) * rx + (pos.getZ(i) - cz) * rz; // -len/2 .. len/2
      const u = (along / w.length + 0.5) * rect.w + rect.x;
      const v = ((w.top - pos.getY(i)) / (w.top - w.bottom)) * rect.h + rect.y;
      attr.array[i * 3] = u / FACADE_SIZE;
      attr.array[i * 3 + 1] = v / FACADE_SIZE;
    }
    attr.needsUpdate = true;
  }

  // Draws a wall's photo into its atlas rectangle; false when the photo's facade is not found.
  function renderWall(w, rect) {
    if (w.length < MIN_WALL) return false;
    const offset = facadeOffset(w);
    if (offset === null) return false;
    const cx = (w.ax + w.bx) / 2 + w.nx * offset;
    const cz = (w.az + w.bz) / 2 + w.nz * offset;
    const cy = (w.bottom + w.top) / 2;
    const d = 20;
    camera.left = -w.length / 2;
    camera.right = w.length / 2;
    camera.top = (w.top - w.bottom) / 2;
    camera.bottom = -(w.top - w.bottom) / 2;
    camera.near = d - SLAB_FRONT;
    camera.far = d + SLAB_BACK;
    camera.position.set(cx + w.nx * d, cy, cz + w.nz * d);
    camera.up.set(0, 1, 0);
    camera.lookAt(cx, cy, cz);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    // A render target uses its own viewport and scissor (WebGPU: from the top-left corner).
    facadeTarget.viewport.set(rect.x, rect.y, rect.w, rect.h);
    facadeTarget.scissor.set(rect.x, rect.y, rect.w, rect.h);
    facadeTarget.scissorTest = true;
    renderer.render(scene, camera);
    return true;
  }

  function nearest(groups, target) {
    const dist = (g) => Math.hypot(Math.max(g.bounds.x0 - target.x, 0, target.x - g.bounds.x1), Math.max(g.bounds.z0 - target.z, 0, target.z - g.bounds.z1));
    let best = null;
    let bestD = NEAR;
    for (const g of groups) {
      if (g.facadeLayer >= 0 || g.facadeFailed || !g.walls.length) continue;
      const d = dist(g);
      if (d < bestD) [best, bestD] = [g, d];
    }
    if (!best) return null;
    let layer = owners.indexOf(null);
    if (layer < 0) {
      let far = bestD;
      owners.forEach((g, i) => {
        const d = g.disposed ? Infinity : dist(g);
        if (d > far) [far, layer] = [d, i];
      });
      if (layer < 0) return null;
      if (!owners[layer].disposed) setLayer(owners[layer], -1);
    }
    owners[layer] = best;
    return { group: best, layer };
  }

  // Where the photographed facade is, as a distance along the wall's normal from our wall's
  // plane (positive: in front of it): the median of three rays at mid-height, cast back from
  // SEARCH metres in front. OSM footprints and the 3D tiles differ by a metre or two. Null when
  // fewer than two rays find a surface (the wall keeps its procedural look).
  const SEARCH = 4;
  const from = new Vector3();
  const back = new Vector3();
  function facadeOffset(w) {
    const found = [];
    back.set(-w.nx, 0, -w.nz);
    raycaster.far = SEARCH * 2;
    for (const t of [0.25, 0.5, 0.75]) {
      from.set(w.ax + (w.bx - w.ax) * t + w.nx * SEARCH, w.bottom + (w.top - w.bottom) * 0.55, w.az + (w.bz - w.az) * t + w.nz * SEARCH);
      raycaster.set(from, back);
      const hit = raycaster.intersectObject(tiles.group, true)[0];
      if (hit) found.push(SEARCH - hit.distance);
    }
    raycaster.far = Infinity;
    if (found.length < 2) return null;
    found.sort((a, b) => a - b);
    return found[Math.floor(found.length / 2)];
  }

  return {
    tiles,
    scene,
    get busy() {
      return Boolean(job);
    },
    // Bakes a little each frame: pick a group, load the tiles around it, measure its buildings'
    // heights, then draw its walls. rebuild(group, heights) is city/city.js rebuildGroup.
    update(groups, target, rebuild) {
      if (!job) {
        const next = nearest(groups, target);
        if (!next) return;
        const b = next.group.bounds;
        const centre = new Vector3((b.x0 + b.x1) / 2, heightAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2), (b.z0 + b.z1) / 2);
        const radius = Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2 + 15;
        region.sphere = new Sphere(new Vector3(), radius);
        if (!regions.hasRegion(region)) regions.addRegion(region);
        job = { ...next, rects: null, next: 0, stage: 'loading', started: performance.now(), quiet: 0, loadEnded: false, centre, baked: new Set(), heights: new Map(), measured: 0 };
      }
      if (job.stage === 'loading') {
        // The region is in the tiles' own frame, which is only set once the root tileset has
        // loaded (and moves with the height calibration), so it is placed again every frame.
        holder.updateMatrixWorld(true);
        region.sphere.center.copy(tiles.group.worldToLocal(job.centre.clone()));
      }
      tiles.update();
      if (job.stage === 'loading') {
        const s = tiles.stats;
        job.quiet = s.downloading || s.parsing || s.queued ? 0 : job.quiet + 1;
        // Ready when loads have settled and detailed tiles cover most of the group; give up
        // after 40 s.
        const late = performance.now() - job.started > 40000;
        if ((!job.loadEnded || job.quiet < 10) && !late) return;
        const { gaps, coverage } = survey(job.group.bounds);
        if (coverage < 0.6 && !late) {
          job.loadEnded = false;
          return;
        }
        if (!calibrated && gaps.length >= 6) calibrated = calibrate(gaps);
        if (!calibrated) {
          job.group.facadeFailed = true;
          owners[job.layer] = null;
          job = null;
          return;
        }
        job.stage = 'measuring';
      }
      // Real heights from the photos where OSM's are off (untagged buildings default to a
      // couple of storeys), then the group is rebuilt with them and its walls packed.
      if (job.stage === 'measuring') {
        const list = job.group.buildings;
        const end = Math.min(list.length, job.measured + MEASURE_PER_FRAME);
        for (; job.measured < end; job.measured++) {
          const b = list[job.measured];
          if (b.minHeight > 0) continue;
          const m = measureHeight(b);
          if (m === null || m.eave < 2.5 || m.eave > 200) continue;
          // A roof rising 1.5 m or more over the eaves (but not more than the building is wide)
          // is pitched.
          const width = Math.min(...['x', 'z'].map((k) => Math.max(...b.outer.map((p) => p[k])) - Math.min(...b.outer.map((p) => p[k]))));
          const roof = m.ridge - m.eave;
          const roofHeight = roof > 1.5 && roof < width * 0.8 ? roof : 0;
          if (Math.abs(m.eave - b.height) > HEIGHT_TOLERANCE || roofHeight) {
            job.heights.set(b, { height: Math.abs(m.eave - b.height) > HEIGHT_TOLERANCE ? m.eave : b.height, roofHeight });
          }
        }
        if (job.measured < list.length) return;
        if (job.heights.size) rebuild(job.group, job.heights);
        const packed = packWalls(job.group.walls, FACADE_SIZE, { minDensity: 2, maxDensity: 14 });
        if (!packed) {
          job.group.facadeFailed = true;
          owners[job.layer] = null;
          job = null;
          return;
        }
        job.rects = packed.rects;
        job.stage = 'drawing';
        return;
      }
      // Draw a batch of walls into the group's layer.
      const current = renderer.getRenderTarget();
      renderer.setRenderTarget(facadeTarget, job.layer);
      if (job.next === 0) {
        facadeTarget.viewport.set(0, 0, FACADE_SIZE, FACADE_SIZE);
        facadeTarget.scissorTest = false;
        renderer.getClearColor(clearColor);
        const alpha = renderer.getClearAlpha();
        renderer.setClearColor(GAP_COLOUR, 1);
        renderer.clear();
        renderer.setClearColor(clearColor, alpha);
      }
      const walls = job.group.walls;
      const end = Math.min(walls.length, job.next + WALLS_PER_FRAME);
      for (; job.next < end; job.next++) if (renderWall(walls[job.next], job.rects[job.next])) job.baked.add(walls[job.next]);
      renderer.setRenderTarget(current);
      if (job.next >= walls.length) {
        walls.forEach((w, i) => mapWall(job.group, w, job.rects[i]));
        job.group.bakedWalls = job.baked;
        setLayer(job.group, job.layer);
        job = null;
      }
    },
    release(group) {
      const i = owners.indexOf(group);
      if (i >= 0) owners[i] = null;
      if (job?.group === group) job = null;
    },
  };
}
