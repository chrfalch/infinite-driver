// The snowfield's snow at every 12.5 cm cell (the deformation's grid), in 16 m tiles: the height
// (ground plus snow), how firm it is, how much deeper it packs, the signed distance from the road's
// centre line and how far inside the lake's shore. The snow surface (render/snow-surface.js) needs
// all five for each cell it shows, and sampling the procedural snow for the strips a recentre
// brings in took about 25 ms every 4 m driven. The chunk worker samples the tiles ahead of the car
// (see connectSnowTiles in systems/terrain.js); a cell whose tile is not in yet is sampled here.
import { DEFORM_CELL } from './deformation.js';

const SHIFT = 7;
const TILE = 1 << SHIFT; // cells per side (16 m)
const MASK = TILE - 1;
export const SNOW_FIELDS = 5; // height, firm, packDepth, roadSide, lake
const MARGIN = 1; // tiles kept and fetched beyond the area asked for

const tileKey = (tx, tz) => `${tx},${tz}`;

// The five fields of the cell at (x, z) m into out[o .. o + 4].
export function sampleSnowCell(heightAt, x, z, out, o = 0) {
  const s = heightAt.snowAt(x, z);
  out[o] = heightAt.groundBelowSnow ? heightAt.groundBelowSnow(x, z) + s.depth : heightAt(x, z);
  out[o + 1] = s.firm;
  out[o + 2] = s.packDepth;
  out[o + 3] = heightAt.roadSide(x, z);
  out[o + 4] = s.lake;
}

// Tile (tx, tz): cells [tx * 128, tx * 128 + 128) by [tz * 128, …), row by row, five fields each.
export function sampleSnowTile(heightAt, tx, tz, cell = DEFORM_CELL) {
  const data = new Float32Array(TILE * TILE * SNOW_FIELDS);
  for (let r = 0; r < TILE; r++) {
    for (let c = 0; c < TILE; c++) sampleSnowCell(heightAt, ((tx << SHIFT) + c) * cell, ((tz << SHIFT) + r) * cell, data, (r * TILE + c) * SNOW_FIELDS);
  }
  return data;
}

export class SnowTiles {
  constructor(heightAt, cell = DEFORM_CELL) {
    this.heightAt = heightAt;
    this.size = cell; // m per cell
    this.tiles = new Map();
    this.requested = new Set();
    // Asks for a tile (systems/terrain.js points it at the chunk worker); without one every cell
    // is sampled here.
    this.request = null;
    this.lastTx = NaN;
    this.lastTz = NaN;
    this.last = undefined;
  }

  // The five fields of cell (ix, iz) into out[o .. o + 4].
  cell(ix, iz, out, o = 0) {
    const tx = ix >> SHIFT;
    const tz = iz >> SHIFT;
    if (tx !== this.lastTx || tz !== this.lastTz) {
      this.lastTx = tx;
      this.lastTz = tz;
      this.last = this.tiles.get(tileKey(tx, tz));
    }
    const t = this.last;
    if (!t) return sampleSnowCell(this.heightAt, ix * this.size, iz * this.size, out, o);
    const k = (((iz & MASK) << SHIFT) | (ix & MASK)) * SNOW_FIELDS;
    for (let f = 0; f < SNOW_FIELDS; f++) out[o + f] = t[k + f];
  }

  // Fetches the tiles over cells [ix0, ix1] x [iz0, iz1] and a tile round them, and lets go of
  // the ones further out.
  want(ix0, iz0, ix1, iz1) {
    if (!this.request) return;
    const tx0 = (ix0 >> SHIFT) - MARGIN;
    const tz0 = (iz0 >> SHIFT) - MARGIN;
    const tx1 = (ix1 >> SHIFT) + MARGIN;
    const tz1 = (iz1 >> SHIFT) + MARGIN;
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = tileKey(tx, tz);
        if (this.tiles.has(key) || this.requested.has(key)) continue;
        this.requested.add(key);
        this.request(tx, tz);
      }
    }
    for (const key of this.tiles.keys()) {
      const [tx, tz] = key.split(',').map(Number);
      if (tx < tx0 - 1 || tx > tx1 + 1 || tz < tz0 - 1 || tz > tz1 + 1) this.tiles.delete(key);
    }
    this.lastTx = NaN;
  }

  // A tile from the worker.
  receive(tx, tz, data) {
    const key = tileKey(tx, tz);
    this.requested.delete(key);
    this.tiles.set(key, data);
    this.lastTx = NaN;
  }
}
