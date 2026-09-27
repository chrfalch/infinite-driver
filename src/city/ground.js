// Procedural ground for real places: the OSM landuse, landcover and water areas, building
// footprints and roads under a terrain chunk are filled into a small ground map (GROUND_RES^2,
// 0.5 m per texel), which the ground shader (render/city-ground.js) turns into lawn, forest floor,
// paving, water or worn ground, and which places the chunk's trees.
//
// Each texel's RGB encodes the surface mix: water is white, and the rest of each channel is one
// surface (R lawn, G forest floor, B paving); black is worn ground where OSM says nothing. This
// survives the blending at borders (canvas anti-aliasing, texture filtering): decode with
// water = min(r, g, b), lawn = r - water, forest = g - water, paving = b - water.
import { mulberry32 } from '../terrain/height.js';

export const GROUND_RES = 128;

const LAWN = [255, 0, 0];
const FOREST = [0, 255, 0];
const PAVING = [0, 0, 255];
const WATER = [255, 255, 255];
const GARDENS = [165, 0, 90]; // residential: gardens and drives
const CAMPUS = [120, 0, 135]; // schools, hospitals: lawns and yards

const LANDUSE = {
  residential: GARDENS,
  suburb: GARDENS,
  neighbourhood: GARDENS,
  quarter: GARDENS,
  commercial: PAVING,
  retail: PAVING,
  industrial: PAVING,
  railway: PAVING,
  bus_station: PAVING,
  garages: PAVING,
  military: PAVING,
  construction: PAVING,
  cemetery: LAWN,
  park: LAWN,
  pitch: LAWN,
  playground: LAWN,
  stadium: LAWN,
  zoo: LAWN,
  school: CAMPUS,
  university: CAMPUS,
  college: CAMPUS,
  kindergarten: CAMPUS,
  hospital: CAMPUS,
  library: CAMPUS,
};
const LANDCOVER = { wood: FOREST, grass: LAWN, farmland: LAWN, wetland: [128, 180, 0], sand: PAVING, rock: PAVING, ice: WATER };

export function areaFill(area) {
  if (area.layer === 'water') return WATER;
  if (area.layer === 'landcover') return LANDCOVER[area.cls] ?? null;
  return LANDUSE[area.cls] ?? null;
}

const rgb = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;

function path(ctx, rings) {
  ctx.beginPath();
  for (const ring of rings) {
    ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)));
    ctx.closePath();
  }
}

// Fills the ground map of the square [x0, x0 + size]^2 into a 2D canvas context of GROUND_RES^2
// and returns its RGBA bytes (row 0 is the north edge, z0).
export function rasterizeGround(ctx, { areas, buildings, roads }, x0, z0, size) {
  const k = GROUND_RES / size;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = 'rgb(0, 0, 0)';
  ctx.fillRect(0, 0, GROUND_RES, GROUND_RES);
  ctx.setTransform(k, 0, 0, k, -x0 * k, -z0 * k);
  // Landuse first, then the land cover on it, then water over both.
  const order = { landuse: 0, landcover: 1, water: 2 };
  for (const area of [...areas].sort((a, b) => order[a.layer] - order[b.layer])) {
    const fill = areaFill(area);
    if (!fill) continue;
    ctx.fillStyle = rgb(fill);
    path(ctx, area.rings);
    ctx.fill('evenodd');
  }
  // Under buildings and roads it is paving: nothing grows there.
  ctx.fillStyle = rgb(PAVING);
  for (const b of buildings) {
    path(ctx, [b.outer, ...b.holes]);
    ctx.fill('evenodd');
  }
  ctx.strokeStyle = rgb(PAVING);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // A little narrower than the painted road, so the paving never shows past its edge.
  for (const road of roads) {
    ctx.lineWidth = Math.max(0.5, road.half * 2 - 0.6);
    ctx.beginPath();
    road.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)));
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, GROUND_RES, GROUND_RES).data;
}

// Surface mix at texel (i, j) of a ground map.
export function surfaceAt(pixels, i, j) {
  const o = (Math.min(GROUND_RES - 1, Math.max(0, j)) * GROUND_RES + Math.min(GROUND_RES - 1, Math.max(0, i))) * 4;
  const r = pixels[o] / 255;
  const g = pixels[o + 1] / 255;
  const b = pixels[o + 2] / 255;
  const water = Math.min(r, g, b);
  return { lawn: r - water, forest: g - water, paving: b - water, water };
}

const CELL = 4; // m, jittered candidate grid for trees

// Trees for the chunk square from its ground map: dense in forest, a few in parks and gardens,
// none on paving (roads, buildings, squares) or water. Same format as terrain/vegetation.js.
export function placeTrees(pixels, heightAt, x0, z0, size, seed) {
  const rand = mulberry32(seed);
  const plants = [];
  const n = Math.round(size / CELL);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i + 0.15 + rand() * 0.7) * CELL;
      const z = z0 + (j + 0.15 + rand() * 0.7) * CELL;
      const roll = rand();
      const grow = rand();
      const turn = rand() * Math.PI * 2;
      const shade = rand();
      // The texel and its neighbours (1 m around): no trunk at a road's or building's edge.
      // Gardens are a third paving, so only mostly paved texels count.
      const ti = Math.floor(((x - x0) / size) * GROUND_RES);
      const tj = Math.floor(((z - z0) / size) * GROUND_RES);
      const s = surfaceAt(pixels, ti, tj);
      let paved = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) paved = Math.max(paved, surfaceAt(pixels, ti + di, tj + dj).paving);
      if (paved > 0.6 || s.water > 0.1) continue;
      const chance = s.forest * 0.55 + s.lawn * 0.05;
      if (roll >= chance) continue;
      plants.push({ kind: 'tree', x, y: heightAt(x, z), z, height: 6 + grow * 7, turn, shade });
    }
  }
  return plants;
}
