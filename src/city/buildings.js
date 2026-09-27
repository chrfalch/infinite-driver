// Building geometry from footprints (city/vector-tiles.js): walls straight up from the terrain and
// a flat roof. The same triangles are drawn and used as the building's collider, so what the car
// hits is exactly what is on screen.
//
// Per-vertex attributes for the facade shader (render/facade.js):
//   facade = (u, v, wall height, roof): u runs along the footprint (m), v up the wall from the
//            ground (m); roof is 1 on the roof.
//   tint   = wall colour; seed = per-building random number (window layout, glass tint).
import { Color, ShapeUtils, Vector2 } from 'three/webgpu';

// Oslo facade colours: ochre, cream, terracotta, brick, pale yellow, salmon, greys.
const PALETTE = ['#d8b27a', '#e6dac0', '#b8674a', '#8f4d3d', '#e2cf92', '#d69c80', '#c8c5be', '#e8e4dc', '#a9a49a', '#c7a57f'].map(
  (c) => new Color(c),
);
const colour = new Color();

function hash(x, z) {
  let h = (Math.imul(Math.round(x * 10), 374761393) + Math.imul(Math.round(z * 10), 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const area = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
};

// Growable float/int arrays.
class Buffer {
  constructor(Type, size = 1024) {
    this.Type = Type;
    this.data = new Type(size);
    this.length = 0;
  }
  push(...values) {
    if (this.length + values.length > this.data.length) {
      const next = new this.Type(Math.max(this.data.length * 2, this.length + values.length));
      next.set(this.data);
      this.data = next;
    }
    for (const v of values) this.data[this.length++] = v;
  }
  array() {
    return this.data.slice(0, this.length);
  }
}

// Builds every building in `buildings`. heightAt(x, z) is the terrain. Returns merged render arrays
// and, per building, its collider triangles and bounding box.
export function buildBuildings(buildings, heightAt) {
  const position = new Buffer(Float32Array);
  const normal = new Buffer(Float32Array);
  const facade = new Buffer(Float32Array);
  const tint = new Buffer(Float32Array);
  const seed = new Buffer(Float32Array);
  const solids = [];
  // Every wall quad, for the facade photo bake (render/facade-bake.js): its 6 vertices from
  // `first`, its base line a-b, bottom and top heights, and its outward normal.
  const walls = [];

  for (const b of buildings) {
    const first = position.length / 3;
    // Ground level: the lowest terrain under the footprint, so no wall floats above a slope.
    let ground = Infinity;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of b.outer) {
      ground = Math.min(ground, heightAt(p.x, p.z));
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    ground = Math.min(ground, heightAt(cx, cz));
    const rnd = hash(cx, cz);
    const top = ground + b.height;
    // Building parts that start higher up (bridges, overhangs) have a floor; the rest go a
    // little into the ground so slopes do not show a gap under the wall.
    const bottom = b.minHeight > 0 ? ground + b.minHeight : ground - 1.5;
    if (top - bottom < 0.5) continue;
    if (b.colour) colour.set(b.colour);
    else colour.copy(PALETTE[Math.floor(rnd * PALETTE.length) % PALETTE.length]);
    const tr = colour.r;
    const tg = colour.g;
    const tb = colour.b;

    const vertex = (x, y, z, nx, ny, nz, u, v, roof) => {
      position.push(x, y, z);
      normal.push(nx, ny, nz);
      facade.push(u, v, top - ground, roof);
      tint.push(tr, tg, tb);
      seed.push(rnd);
    };

    // Walls: one quad per footprint edge, facing away from the building.
    const rings = [[b.outer, b.outerWalls, true], ...b.holes.map((h, i) => [h, b.holeWalls[i], false])];
    for (const [ring, hasWall, isOuter] of rings) {
      // Outer rings with positive area (and holes with negative area) have the building on
      // the right of each edge; the others run the other way round.
      const side = area(ring) > 0 === isOuter ? 1 : -1;
      let u = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-3) continue;
        if (hasWall[i]) {
          const nx = (side * dz) / len;
          const nz = (-side * dx) / len;
          const v0 = bottom - ground;
          const v1 = top - ground;
          const a0 = [p.x, bottom, p.z, nx, 0, nz, u, v0, 0];
          const b0 = [q.x, bottom, q.z, nx, 0, nz, u + len, v0, 0];
          const a1 = [p.x, top, p.z, nx, 0, nz, u, v1, 0];
          const b1 = [q.x, top, q.z, nx, 0, nz, u + len, v1, 0];
          // Counter-clockwise seen from outside: (a1 - a0) x (b0 - a0) = h * (dz, 0, -dx),
          // which is along the normal when side is 1.
          walls.push({ first: position.length / 3, ax: p.x, az: p.z, bx: q.x, bz: q.z, bottom, top, nx, nz, length: len });
          for (const v of side > 0 ? [a0, a1, b0, b0, a1, b1] : [a0, b0, a1, b0, b1, a1]) vertex(...v);
        }
        u += len;
      }
    }

    // Flat roof (and a floor for raised parts), triangulated with its holes.
    const outer = area(b.outer) > 0 ? b.outer : [...b.outer].reverse();
    const contour = outer.map((p) => new Vector2(p.x, p.z));
    const holes = b.holes.map((h) => (area(h) < 0 ? h : [...h].reverse()).map((p) => new Vector2(p.x, p.z)));
    const all = [...contour, ...holes.flat()];
    let faces = [];
    try {
      faces = ShapeUtils.triangulateShape(contour, holes);
    } catch {
      faces = [];
    }
    for (const face of faces) {
      const [a, c, d] = face.map((k) => all[k]);
      // Up-facing when counter-clockwise seen from above (+y): (c - a) x (d - a) has +y.
      const up = (d.x - a.x) * (c.y - a.y) - (c.x - a.x) * (d.y - a.y) > 0;
      const tri = up ? [a, c, d] : [a, d, c];
      for (const p of tri) vertex(p.x, top, p.y, 0, 1, 0, p.x, p.y, 1);
      if (b.minHeight > 0) for (const p of [...tri].reverse()) vertex(p.x, bottom, p.y, 0, -1, 0, p.x, p.y, 1);
    }

    const count = position.length / 3 - first;
    if (!count) continue;
    solids.push({
      first,
      count,
      min: { x: minX, y: bottom, z: minZ },
      max: { x: maxX, y: top, z: maxZ },
    });
  }

  const positions = position.array();
  // Collider triangles are slices of the render positions.
  for (const s of solids) {
    s.vertices = positions.subarray(s.first * 3, (s.first + s.count) * 3);
    s.indices = Uint32Array.from({ length: s.count }, (_, i) => i);
  }
  return {
    positions,
    normals: normal.array(),
    facade: facade.array(),
    tint: tint.array(),
    seed: seed.array(),
    solids,
    walls,
  };
}
