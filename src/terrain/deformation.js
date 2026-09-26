// Persistent ground deformation (ruts and berms) as height offsets on a fine world grid.
// Stored in square tiles that are created on first touch, so memory follows where you drive.

export const DEFORM_CELL = 0.125; // metres
const TILE = 128; // cells per tile side (16 m)

export class GroundDeformation {
  constructor(cell = DEFORM_CELL) {
    this.cell = cell;
    this.tiles = new Map();
    this.version = 0;
  }

  tile(tx, tz, create) {
    const key = `${tx},${tz}`;
    let t = this.tiles.get(key);
    if (!t && create) {
      t = new Float32Array(TILE * TILE);
      this.tiles.set(key, t);
    }
    return t;
  }

  // Offset at integer cell (ix, iz).
  cellValue(ix, iz) {
    const tx = Math.floor(ix / TILE);
    const tz = Math.floor(iz / TILE);
    const t = this.tile(tx, tz, false);
    if (!t) return 0;
    return t[(iz - tz * TILE) * TILE + (ix - tx * TILE)];
  }

  addCell(ix, iz, delta) {
    const tx = Math.floor(ix / TILE);
    const tz = Math.floor(iz / TILE);
    const t = this.tile(tx, tz, true);
    t[(iz - tz * TILE) * TILE + (ix - tx * TILE)] += delta;
    this.version++;
  }

  // Bilinear offset at a world position.
  at(x, z) {
    const gx = x / this.cell;
    const gz = z / this.cell;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const a = this.cellValue(ix, iz);
    const b = this.cellValue(ix + 1, iz);
    const c = this.cellValue(ix, iz + 1);
    const d = this.cellValue(ix + 1, iz + 1);
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  }

  // Spreads a height change over the four cells around (x, z).
  add(x, z, delta) {
    const gx = x / this.cell;
    const gz = z / this.cell;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    this.addCell(ix, iz, delta * (1 - fx) * (1 - fz));
    this.addCell(ix + 1, iz, delta * fx * (1 - fz));
    this.addCell(ix, iz + 1, delta * (1 - fx) * fz);
    this.addCell(ix + 1, iz + 1, delta * fx * fz);
  }

  clear() {
    this.tiles.clear();
    this.version++;
  }
}

// Compacts soil under tyre particles. `contacts` is a list of { x, z, depth } where depth is how
// far the tread is below the (already deformed) surface. Each cell deepens toward a softness-
// dependent limit, and a share of the displaced soil is pushed up beside the tyre as berms.
export function compactSoil(deformation, contacts, { softness, dt, right, bermOffset, maxRut = 0.22 }) {
  if (softness <= 0 || contacts.length === 0) return;
  const limit = maxRut * softness;
  const rate = Math.min(1, 6 * softness * dt);
  // Deepest press per cell, so many particles on one cell do not stack up.
  const cells = new Map();
  const cell = deformation.cell;
  for (const c of contacts) {
    if (c.depth <= 0) continue;
    const ix = Math.round(c.x / cell);
    const iz = Math.round(c.z / cell);
    const key = ix * 73856093 + iz;
    const prev = cells.get(key);
    if (!prev || c.depth > prev.depth) cells.set(key, { ix, iz, x: c.x, z: c.z, depth: c.depth });
  }
  for (const c of cells.values()) {
    const current = -deformation.cellValue(c.ix, c.iz);
    const room = Math.max(0, 1 - current / limit);
    const dig = c.depth * rate * room;
    if (dig <= 1e-5) continue;
    deformation.addCell(c.ix, c.iz, -dig);
    // About a third of the soil ends up in low ridges on both sides.
    const berm = dig * 0.18;
    deformation.add(c.x + right.x * bermOffset, c.z + right.z * bermOffset, berm);
    deformation.add(c.x - right.x * bermOffset, c.z - right.z * bermOffset, berm);
  }
}
