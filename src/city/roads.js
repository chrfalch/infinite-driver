// Road surfaces for real places: OSM centre lines (city/vector-tiles.js) become asphalt, kerbs,
// sidewalks and a centre line, painted on the terrain per vertex. The road attribute of a terrain
// vertex is (carEdge, carCentre, pathEdge, carHalf):
//   carEdge   = distance to the nearest car road's edge (m, negative on the road),
//   carCentre = distance to that road's centre line (m), carHalf = its half width (m),
//   pathEdge  = distance to the nearest footpath's edge (m, negative on the path).
// Car roads and paths are kept apart so each is a smooth distance field: a single "nearest road"
// would jump between a street and the footpath beside it from one vertex to the next, and the
// blend across each triangle would show as saw teeth along the sidewalk.
import { ROAD_KIND } from './vector-tiles.js';

const REACH = 4; // m past a road's edge that still counts (sidewalks)
// Edge and centre distance where no road is near. Kept just past REACH (not a huge number) so the
// values blend linearly between vertices and the sidewalk's outer edge is not jagged.
export const NO_ROAD = REACH + 1;
export const BUCKET = 64; // m, spatial index cells

// Segments of the roads, bucketed by the BUCKET-sized cells they come near.
export function indexRoads(roads, buckets = new Map()) {
  for (const road of roads) {
    const reach = road.half + REACH;
    for (let i = 0; i + 1 < road.points.length; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      const seg = { ax: a.x, az: a.z, bx: b.x, bz: b.z, half: road.half, kind: road.kind };
      const i0 = Math.floor((Math.min(a.x, b.x) - reach) / BUCKET);
      const i1 = Math.floor((Math.max(a.x, b.x) + reach) / BUCKET);
      const j0 = Math.floor((Math.min(a.z, b.z) - reach) / BUCKET);
      const j1 = Math.floor((Math.max(a.z, b.z) + reach) / BUCKET);
      for (let j = j0; j <= j1; j++) {
        for (let k = i0; k <= i1; k++) {
          const key = `${k},${j}`;
          let list = buckets.get(key);
          if (!list) buckets.set(key, (list = []));
          list.push(seg);
        }
      }
    }
  }
  return buckets;
}

function segmentDistance(s, x, z) {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - s.ax) * dx + (z - s.az) * dz) / len2)) : 0;
  return Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
}

// Road attribute at (x, z) from the segments in `segments`, written to out[offset..offset+3].
export function roadAt(segments, x, z, out, offset = 0) {
  let carEdge = Infinity;
  let carCentre = Infinity;
  let carHalf = 0;
  let pathEdge = Infinity;
  for (const s of segments) {
    const d = segmentDistance(s, x, z);
    const e = d - s.half;
    if (s.kind === ROAD_KIND.CAR) {
      if (e < carEdge) {
        carEdge = e;
        carCentre = d;
        carHalf = s.half;
      }
    } else if (e < pathEdge) pathEdge = e;
  }
  // Far away the distances stop at NO_ROAD, so they still blend linearly between vertices.
  out[offset] = Math.min(carEdge, NO_ROAD);
  out[offset + 1] = Math.min(carCentre, NO_ROAD + carHalf);
  out[offset + 2] = Math.min(pathEdge, NO_ROAD);
  out[offset + 3] = carHalf;
  return out;
}
