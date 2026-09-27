// OpenStreetMap buildings and roads for real places, from OpenFreeMap's vector tiles (the
// OpenMapTiles schema, zoom 14: about 1.2 km per tile at Oslo's latitude, 4096 units per tile side,
// so about 30 cm precision).
//
// In these tiles, touching buildings of the same height are merged into one multi-polygon, and
// polygons run a little past the tile edge (a buffer) so neighbouring tiles overlap. Every ring is
// clipped to the tile square here, and the ring edges that lie on the square are marked, so a
// building split across two tiles gets no walls along the cut.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { TILE_SIZE } from '../geo/projection.js';

export const CITY_ZOOM = 14;
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

let tileUrl = null;
async function urlFor(x, y) {
  tileUrl ??= fetch(TILEJSON_URL, { mode: 'cors' })
    .then((r) => r.json())
    .then((json) => json.tiles[0]);
  return (await tileUrl).replace('{z}', CITY_ZOOM).replace('{x}', x).replace('{y}', y);
}

// Road half widths (m) by OpenMapTiles class; paths are for walking and cycling.
export const ROAD_HALF_WIDTH = {
  motorway: 6.5,
  trunk: 5.5,
  primary: 5,
  secondary: 4.5,
  tertiary: 4,
  minor: 3.2,
  service: 2.2,
  track: 1.6,
  raceway: 5,
  busway: 3.2,
  path: 1.2,
  pier: 2,
};
// Roads that cars use get asphalt, sidewalks and a centre line; the rest is light paving.
const CAR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'raceway', 'busway']);
export const ROAD_KIND = { CAR: 1, PATH: 2 };

// Sutherland-Hodgman clip of a ring (tile units) to [0, size]^2. Concave rings stay in one piece,
// with extra edges along the square where the ring left it.
export function clipRing(ring, size) {
  let out = ring;
  const edges = [
    [(p) => p[0] >= 0, (p, q) => -p[0] / (q[0] - p[0])],
    [(p) => p[0] <= size, (p, q) => (size - p[0]) / (q[0] - p[0])],
    [(p) => p[1] >= 0, (p, q) => -p[1] / (q[1] - p[1])],
    [(p) => p[1] <= size, (p, q) => (size - p[1]) / (q[1] - p[1])],
  ];
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[i];
      const q = input[(i + 1) % input.length];
      const pin = inside(p);
      const qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const t = cut(p, q);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    if (out.length < 3) return [];
  }
  return out;
}

// True when the edge a-b runs along a side of the tile square.
export function onTileEdge(a, b, size) {
  const eps = 1e-6;
  return (
    (Math.abs(a[0]) < eps && Math.abs(b[0]) < eps) ||
    (Math.abs(a[0] - size) < eps && Math.abs(b[0] - size) < eps) ||
    (Math.abs(a[1]) < eps && Math.abs(b[1]) < eps) ||
    (Math.abs(a[1] - size) < eps && Math.abs(b[1] - size) < eps)
  );
}

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

// Buildings, roads and ground areas of one tile in world metres ({ x, z }), from a decoded
// VectorTile. toWorld(u, v) maps tile units to world metres.
export function readCityTile(tile, toWorld) {
  const buildings = [];
  const roads = [];
  // Ground areas (landuse, landcover, water): every ring of a polygon feature, unclipped; they
  // are only filled (city/ground.js), so the overlap between neighbouring tiles does no harm.
  const areas = [];
  for (const layer of ['landuse', 'landcover', 'water']) {
    const l = tile.layers[layer];
    if (!l) continue;
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i);
      if (f.type !== 3) continue;
      const rings = f.loadGeometry().map((ring) => ring.map((p) => toWorld(p.x, p.y)));
      areas.push({ layer, cls: f.properties.class, subclass: f.properties.subclass ?? null, rings });
    }
  }
  const layer = tile.layers.building;
  if (layer) {
    const size = layer.extent;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      // hide_3d: an outline whose building:part pieces are drawn instead.
      if (f.properties.hide_3d) continue;
      const height = Number(f.properties.render_height) || 8;
      const minHeight = Number(f.properties.render_min_height) || 0;
      const colour = f.properties.colour ?? null;
      // MVT rings: exterior rings have positive area in tile units (y down), holes negative;
      // each exterior ring is followed by its holes.
      let current = null;
      for (const raw of f.loadGeometry()) {
        const ring = raw.map((p) => [p.x, p.y]);
        if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
        const area = ringArea(ring);
        const clipped = clipRing(ring, size);
        if (clipped.length < 3 || Math.abs(ringArea(clipped)) < 4) {
          if (area > 0) current = null;
          continue;
        }
        const walls = clipped.map((p, k) => !onTileEdge(p, clipped[(k + 1) % clipped.length], size));
        const points = clipped.map(([u, v]) => toWorld(u, v));
        if (area > 0) {
          current = { outer: points, outerWalls: walls, holes: [], holeWalls: [], height, minHeight, colour };
          buildings.push(current);
        } else if (current) {
          current.holes.push(points);
          current.holeWalls.push(walls);
        }
      }
    }
  }
  const transport = tile.layers.transportation;
  if (transport) {
    for (let i = 0; i < transport.length; i++) {
      const f = transport.feature(i);
      const cls = String(f.properties.class ?? '').replace('_construction', '');
      const half = ROAD_HALF_WIDTH[cls];
      if (!half || f.properties.brunnel === 'tunnel' || f.type !== 2) continue;
      // Pedestrian streets and squares are wide paths.
      const sub = f.properties.subclass;
      const wide = sub === 'pedestrian' ? 3 : half;
      const kind = CAR_ROADS.has(cls) ? ROAD_KIND.CAR : ROAD_KIND.PATH;
      for (const line of f.loadGeometry()) {
        if (line.length < 2) continue;
        roads.push({ points: line.map((p) => toWorld(p.x, p.y)), half: wide, kind, cls, oneway: Boolean(f.properties.oneway) });
      }
    }
  }
  return { buildings, roads, areas };
}

// Downloads and reads the city tile (tx, ty) for a projection (geo/projection.js).
export async function loadCityTile(projection, tx, ty) {
  const response = await fetch(await urlFor(tx, ty), { mode: 'cors' });
  if (!response.ok) return { buildings: [], roads: [], areas: [] };
  const tile = new VectorTile(new PbfReader(new Uint8Array(await response.arrayBuffer())));
  const extent = tile.layers.building?.extent ?? tile.layers.transportation?.extent ?? 4096;
  const scale = TILE_SIZE / extent;
  const toWorld = (u, v) => projection.fromPixel(tx * TILE_SIZE + u * scale, ty * TILE_SIZE + v * scale, CITY_ZOOM);
  return readCityTile(tile, toWorld);
}
