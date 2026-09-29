// Persistent ground deformation (ruts and berms) as height offsets on a fine world grid.
// Stored in square tiles that are created on first touch, so memory follows where you drive.

export const DEFORM_CELL = 0.125; // metres
const SHIFT = 7;
const TILE = 1 << SHIFT; // cells per tile side (16 m)
const MASK = TILE - 1;
const BIAS = 32768;

// Numeric tile key; valid for |tile index| < 32768 (about 520 km from the origin).
const tileKey = (tx, tz) => (tx + BIAS) * 65536 + (tz + BIAS);

export class GroundDeformation {
  constructor(cell = DEFORM_CELL) {
    this.cell = cell;
    this.tiles = new Map();
    this.version = 0;
    // Last tile looked up (may be undefined when that tile does not exist yet).
    this.lastTx = NaN;
    this.lastTz = NaN;
    this.lastTile = undefined;
    // Cells changed since `dirtyStart` (see changedSince).
    this.dirtyStart = 0;
    this.dirtyAll = false;
    this.dirtyX0 = Infinity;
    this.dirtyZ0 = Infinity;
    this.dirtyX1 = -Infinity;
    this.dirtyZ1 = -Infinity;
    // Sharing with a physics worker: new tiles live in SharedArrayBuffers (when the page is
    // cross-origin isolated) and are announced through onTile(key, tile); clear() calls onClear().
    this.shared = typeof SharedArrayBuffer !== 'undefined' && !!globalThis.crossOriginIsolated;
    this.onTile = null;
    this.onClear = null;
  }

  // Worker side: use a tile the main thread created (same memory, so its edits show up here).
  adoptTile(key, tile) {
    this.tiles.set(key, tile);
    this.lastTx = this.lastTz = NaN;
    this.lastTile = undefined;
  }

  // Worker side: the main thread's version and the cells it changed since the last call (null:
  // treat everything as changed), so changedSince() here reports them.
  markChanged(version, rect) {
    if (version === this.version) return;
    this.version = version;
    if (!rect) this.dirtyAll = true;
    else if (rect.x0 <= rect.x1) {
      this.dirtyX0 = Math.min(this.dirtyX0, rect.x0);
      this.dirtyZ0 = Math.min(this.dirtyZ0, rect.z0);
      this.dirtyX1 = Math.max(this.dirtyX1, rect.x1);
      this.dirtyZ1 = Math.max(this.dirtyZ1, rect.z1);
    }
  }

  tile(tx, tz, create) {
    if (tx === this.lastTx && tz === this.lastTz && (this.lastTile || !create)) return this.lastTile;
    const key = tileKey(tx, tz);
    let t = this.tiles.get(key);
    if (!t && create) {
      t = this.shared ? new Float32Array(new SharedArrayBuffer(TILE * TILE * 4)) : new Float32Array(TILE * TILE);
      this.tiles.set(key, t);
      this.onTile?.(key, t);
    }
    this.lastTx = tx;
    this.lastTz = tz;
    this.lastTile = t;
    return t;
  }

  // Offset at integer cell (ix, iz).
  cellValue(ix, iz) {
    const t = this.tile(ix >> SHIFT, iz >> SHIFT, false);
    return t ? t[((iz & MASK) << SHIFT) | (ix & MASK)] : 0;
  }

  addCell(ix, iz, delta) {
    const t = this.tile(ix >> SHIFT, iz >> SHIFT, true);
    t[((iz & MASK) << SHIFT) | (ix & MASK)] += delta;
    this.version++;
    if (ix < this.dirtyX0) this.dirtyX0 = ix;
    if (ix > this.dirtyX1) this.dirtyX1 = ix;
    if (iz < this.dirtyZ0) this.dirtyZ0 = iz;
    if (iz > this.dirtyZ1) this.dirtyZ1 = iz;
  }

  // Bilinear offset at a world position.
  at(x, z) {
    const gx = x / this.cell;
    const gz = z / this.cell;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const lx = ix & MASK;
    const lz = iz & MASK;
    let a, b, c, d;
    if (lx !== MASK && lz !== MASK) {
      // All four cells in one tile.
      const t = this.tile(ix >> SHIFT, iz >> SHIFT, false);
      if (!t) return 0;
      const o = (lz << SHIFT) | lx;
      a = t[o];
      b = t[o + 1];
      c = t[o + TILE];
      d = t[o + TILE + 1];
    } else {
      a = this.cellValue(ix, iz);
      b = this.cellValue(ix + 1, iz);
      c = this.cellValue(ix, iz + 1);
      d = this.cellValue(ix + 1, iz + 1);
    }
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

  // Adds the offsets of the cell rectangle [ix0, ix0 + nx) x [iz0, iz0 + nz) into `out`, where
  // cell (ix0 + c, iz0 + r) goes to out[offset + r * stride + c]. Reads each tile once per row.
  accumulate(ix0, iz0, nx, nz, out, stride = nx, offset = 0) {
    const ix1 = ix0 + nx;
    for (let r = 0; r < nz; r++) {
      const iz = iz0 + r;
      const tz = iz >> SHIFT;
      const row = (iz & MASK) << SHIFT;
      const o = offset + r * stride - ix0;
      for (let ix = ix0; ix < ix1; ) {
        const tx = ix >> SHIFT;
        const end = Math.min(ix1, (tx + 1) << SHIFT);
        const t = this.tile(tx, tz, false);
        if (t) for (let i = ix; i < end; i++) out[o + i] += t[row | (i & MASK)];
        ix = end;
      }
    }
  }

  // Cell rectangle { x0, z0, x1, z1 } (inclusive) that covers every change made after `version`,
  // or null when that is no longer known (treat everything as changed). Returns an empty
  // rectangle (x0 > x1) when nothing changed. Designed for one main consumer: each call restarts
  // the tracked rectangle, so a second consumer with an older version gets null.
  changedSince(version) {
    let result;
    if (version === this.version) result = { x0: 1, z0: 1, x1: 0, z1: 0 };
    else if (this.dirtyAll || version < this.dirtyStart || version > this.version) result = null;
    else result = { x0: this.dirtyX0, z0: this.dirtyZ0, x1: this.dirtyX1, z1: this.dirtyZ1 };
    this.dirtyStart = this.version;
    this.dirtyAll = false;
    this.dirtyX0 = this.dirtyZ0 = Infinity;
    this.dirtyX1 = this.dirtyZ1 = -Infinity;
    return result;
  }

  clear() {
    this.onClear?.();
    this.tiles.clear();
    this.lastTx = this.lastTz = NaN;
    this.lastTile = undefined;
    this.version++;
    this.dirtyAll = true;
  }
}

// Compacts soil under tyre particles. `contacts` is a list of { x, z, depth } where depth is how
// far the tread is below the (already deformed) surface. Each cell deepens toward a softness-
// dependent limit, and a share of the displaced soil is pushed up beside the tyre as berms.
// Snow (terrain/snow.js) packs by pressure instead: a cell under the tread packs down until it
// bears the tread's pressure, from nothing for fresh snow to `snow.bearing` kPa for a rut
// `snow.packDepth` deep (bearing grows with the square of the rut depth). A soft tyre presses on
// the ground with about its air pressure (the patch grows with the load), so aired-down tyres
// float higher on snow, as they do for real. A parked car sinks into its ruts, then stops.
export function compactSoil(deformation, contacts, { softness, dt, right, bermOffset, maxRut = 0.22, snow = null, pressureKpa = 100 }) {
  if ((!snow && softness <= 0) || contacts.length === 0) return;
  const limit = snow ? snow.packDepth : maxRut * softness;
  const rate = Math.min(1, (snow ? snow.packRate : 6 * softness) * dt);
  const bermShare = snow ? snow.bermShare : 0.18;
  // Deepest press per cell, so many particles on one cell do not stack up.
  const cells = new Map();
  const cell = deformation.cell;
  for (const c of contacts) {
    if (c.depth <= 0) continue;
    const ix = Math.round(c.x / cell);
    const iz = Math.round(c.z / cell);
    const key = ix * 73856093 + iz;
    const prev = cells.get(key);
    if (!prev) cells.set(key, { ix, iz, x: c.x, z: c.z, depth: c.depth });
    else if (c.depth > prev.depth) {
      prev.x = c.x;
      prev.z = c.z;
      prev.depth = c.depth;
    }
  }
  for (const c of cells.values()) {
    const current = -deformation.cellValue(c.ix, c.iz);
    let dig;
    if (snow) {
      // Treads only just touching (the patch's edge) press less.
      const target = limit * Math.min(1, Math.sqrt(pressureKpa / snow.bearing)) * Math.min(1, c.depth / 0.01);
      dig = (target - current) * rate;
    } else dig = c.depth * rate * Math.max(0, 1 - current / limit);
    if (dig <= 1e-5) continue;
    deformation.addCell(c.ix, c.iz, -dig);
    // About a third of the soil ends up in low ridges on both sides.
    const berm = dig * bermShare;
    deformation.add(c.x + right.x * bermOffset, c.z + right.z * bermOffset, berm);
    deformation.add(c.x - right.x * bermOffset, c.z - right.z * bermOffset, berm);
  }
}
