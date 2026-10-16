// Waves on the water near the car (the town's river and ponds, the stadium's water holes): a height
// field on a 25 cm grid, 40 m across, that follows the car in 4 m steps. The water follows the wave
// equation at the speed of shallow water, sqrt(g * depth), so ripples slow down in the shallows and
// stop at the bank (dry cells hold still and reflect them), and an absorbing band at the edge of the
// patch lets them leave. Wheels and the body push the water where they move (`push`), splashes and
// falling drops strike it (`impulse`), and churned water leaves foam that fades (`foam`).
//
// Each frame the patch goes to the GPU as one float texture, per cell (height, foam, dh/dx, dh/dz),
// for the water's normals and its foam (render/water.js). Nothing is stepped or uploaded while the
// water near the car is calm and the car is away from it.

export const WAVE_CELL = 0.25; // m
export const WAVE_N = 160; // cells per side (40 m)
const RECENTRE = 4; // m the car may get from the patch centre before it moves (a whole number of cells and metres)
const STEP = 1 / 60; // s
const MAX_STEPS = 3; // per frame, so a hitch does not run the sim for long
const GRAVITY = 9.81;
const MAX_SPEED = 3.2; // m/s, wave speed cap (deep water; keeps c dt / dx well under 0.5)
const DAMPING = 0.35; // 1/s, everywhere
const EDGE = 3; // m, the absorbing band at the edge of the patch
const EDGE_DAMPING = 6; // 1/s at the very edge
const FOAM_LIFE = 3.5; // s for foam to fade to a third
const PUSH_GAIN = 0.6; // share of a moving push's depth change that heaves the water
const CALM = 2e-4; // m, waves below this are flat
const IDLE_FRAMES = 30; // calm frames before the sim sleeps

export class WaterWaves {
  // `depthAt(x, z)`: water depth there, m (negative on dry land).
  constructor(depthAt, { n = WAVE_N, cell = WAVE_CELL } = {}) {
    this.depthAt = depthAt;
    this.n = n;
    this.cell = cell;
    this.size = n * cell;
    const cells = n * n;
    this.h = new Float32Array(cells); // m, surface height above the still water level
    this.v = new Float32Array(cells); // m/s, its vertical speed
    this.f = new Float32Array(cells); // foam, 0..1
    this.c2 = new Float32Array(cells); // (wave speed * dt / cell)², 0 on dry land
    this.damp = new Float32Array(cells); // per-step multiplier on v from the shallows
    this.src = new Float32Array(cells); // pushes this frame
    this.srcPrev = new Float32Array(cells); // and last frame
    this.texData = new Float32Array(cells * 4);
    // World position of cell (0, 0)'s corner; set on the first move.
    this.origin = { x: NaN, y: NaN };
    this.edge = new Float32Array(cells);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const d = Math.min(ix + 0.5, iz + 0.5, n - ix - 0.5, n - iz - 0.5) * cell;
        const t = Math.max(0, 1 - d / EDGE);
        this.edge[iz * n + ix] = Math.exp(-(DAMPING + EDGE_DAMPING * t * t) * STEP); // stays with the patch, not the water
      }
    }
    this.carry = 0;
    this.idle = IDLE_FRAMES;
    this.wet = false; // any water in the patch at all
    this.active = false; // anything to step or show
    this.version = 0; // bumped when the texture data changes
    this.onMove = null;
  }

  // Index of the cell under (x, z), or -1 outside the patch.
  index(x, z) {
    const ix = Math.floor((x - this.origin.x) / this.cell);
    const iz = Math.floor((z - this.origin.y) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) return -1;
    return iz * this.n + ix;
  }

  // The wave height at (x, z), m above the still water (0 outside the patch).
  heightAt(x, z) {
    const i = this.index(x, z);
    return i < 0 ? 0 : this.h[i];
  }

  // Keep the patch around (x, z). Returns true when it moved.
  follow(x, z) {
    const half = this.size / 2;
    const ox = this.origin.x;
    const oz = this.origin.y;
    if (Math.abs(x - (ox + half)) <= RECENTRE && Math.abs(z - (oz + half)) <= RECENTRE) return false;
    const nx = Math.round((x - half) / RECENTRE) * RECENTRE;
    const nz = Math.round((z - half) / RECENTRE) * RECENTRE;
    if (Number.isNaN(ox)) {
      this.origin.x = nx;
      this.origin.y = nz;
      this.fillWaterDepth(0, 0, this.n, this.n);
    } else {
      this.shift(Math.round((nx - ox) / this.cell), Math.round((nz - oz) / this.cell));
    }
    this.onMove?.(this.origin);
    return true;
  }

  // Moves the patch by (dx, dz) cells: what stays in it keeps its waves, new cells are calm.
  shift(dx, dz) {
    const { n } = this;
    const fields = [this.h, this.v, this.f, this.c2, this.damp, this.src, this.srcPrev];
    this.origin.x += dx * this.cell;
    this.origin.y += dz * this.cell;
    if (Math.abs(dx) >= n || Math.abs(dz) >= n) {
      for (const a of fields) a.fill(0);
      this.fillWaterDepth(0, 0, n, n);
      return;
    }
    // Row by row in the order that does not overwrite rows still to be read.
    const rows = dz >= 0 ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
    for (const a of fields) {
      for (const iz of rows) {
        const from = iz + dz;
        const row = a.subarray(iz * n, iz * n + n);
        if (from < 0 || from >= n) {
          row.fill(0);
          continue;
        }
        const src = a.subarray(from * n, from * n + n);
        if (dx >= 0) {
          if (from === iz) row.copyWithin(0, dx);
          else row.set(src.subarray(dx));
          row.fill(0, n - dx);
        } else {
          if (from === iz) row.copyWithin(-dx, 0, n + dx);
          else row.set(src.subarray(0, n + dx), -dx);
          row.fill(0, 0, -dx);
        }
      }
    }
    // The depths of the cells that came in.
    if (dx > 0) this.fillWaterDepth(n - dx, 0, n, n);
    if (dx < 0) this.fillWaterDepth(0, 0, -dx, n);
    if (dz > 0) this.fillWaterDepth(0, n - dz, n, n);
    if (dz < 0) this.fillWaterDepth(0, 0, n, -dz);
    this.wet = this.c2.some((c) => c > 0);
  }

  // Wave speed and damping for cells [x0, x1) x [z0, z1), from the water depth sampled at whole
  // metres (the terrain changes slowly; one sample per 16 cells) and blended between them.
  fillWaterDepth(x0, z0, x1, z1) {
    const { n, cell, origin } = this;
    const step = Math.max(1, Math.round(1 / cell));
    const gx0 = Math.floor(x0 / step);
    const gz0 = Math.floor(z0 / step);
    const gx1 = Math.ceil(x1 / step);
    const gz1 = Math.ceil(z1 / step);
    const gw = gx1 - gx0 + 1;
    const corners = new Float32Array(gw * (gz1 - gz0 + 1));
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) corners[(gz - gz0) * gw + (gx - gx0)] = this.depthAt(origin.x + gx * step * cell, origin.y + gz * step * cell);
    }
    const k = (STEP / cell) ** 2;
    for (let iz = z0; iz < z1; iz++) {
      for (let ix = x0; ix < x1; ix++) {
        const fx = (ix + 0.5) / step - gx0;
        const fz = (iz + 0.5) / step - gz0;
        const cx = Math.min(gw - 2, Math.floor(fx));
        const cz = Math.min(gz1 - gz0 - 1, Math.floor(fz));
        const tx = fx - cx;
        const tz = fz - cz;
        const a = corners[cz * gw + cx] + (corners[cz * gw + cx + 1] - corners[cz * gw + cx]) * tx;
        const b = corners[(cz + 1) * gw + cx] + (corners[(cz + 1) * gw + cx + 1] - corners[(cz + 1) * gw + cx]) * tx;
        const depth = a + (b - a) * tz;
        const i = iz * n + ix;
        if (depth <= 0.02) {
          this.c2[i] = 0;
          this.h[i] = 0;
          this.v[i] = 0;
          this.damp[i] = 0;
        } else {
          const c = Math.min(MAX_SPEED, Math.sqrt(GRAVITY * depth));
          this.c2[i] = c * c * k;
          // Shallow water drags on its waves.
          this.damp[i] = Math.exp(-Math.max(0, 0.15 - depth) * 20 * STEP);
        }
      }
    }
    if (x0 === 0 && z0 === 0 && x1 === n && z1 === n) this.wet = this.c2.some((c) => c > 0);
  }

  // Rasterises a smooth disc of `amount` at (x, z), radius r, into `target` (max, or add).
  disc(target, x, z, r, amount, add) {
    const { n, cell, origin } = this;
    const cx = (x - origin.x) / cell;
    const cz = (z - origin.y) / cell;
    const rc = r / cell;
    const x0 = Math.max(0, Math.floor(cx - rc));
    const x1 = Math.min(n - 1, Math.ceil(cx + rc));
    const z0 = Math.max(0, Math.floor(cz - rc));
    const z1 = Math.min(n - 1, Math.ceil(cz + rc));
    let hit = false;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const i = iz * n + ix;
        if (this.c2[i] === 0) continue;
        const dx = ix + 0.5 - cx;
        const dz = iz + 0.5 - cz;
        const t = 1 - (dx * dx + dz * dz) / (rc * rc);
        if (t <= 0) continue;
        const w = amount * t * t;
        if (add) target[i] += w;
        else if (w > target[i]) target[i] = w;
        hit = true;
      }
    }
    return hit;
  }

  // Something `depth` m deep in the water at (x, z), `r` m across its middle: where it moves to,
  // the water heaves up ahead of it, and falls behind.
  push(x, z, r, depth) {
    if (this.disc(this.src, x, z, r, depth, false)) this.wake();
  }

  // A blow to the water: `speed` m/s (negative pushes it down, a ring spreads out).
  impulse(x, z, r, speed) {
    if (this.disc(this.v, x, z, r, speed, true)) this.wake();
  }

  // Churned water whitens.
  foam(x, z, r, amount) {
    this.disc(this.f, x, z, r, amount, true);
  }

  wake() {
    this.idle = 0;
    this.active = true;
  }

  update(dt) {
    if (!this.wet || !this.active) {
      this.src.fill(0);
      return false;
    }
    const { n, h, v, c2, damp, edge, src, srcPrev, f } = this;
    // The pushes: the depth change since last frame heaves the water.
    let pushed = false;
    for (let i = 0; i < h.length; i++) {
      const d = src[i] - srcPrev[i];
      if (d !== 0) {
        h[i] += d * PUSH_GAIN;
        pushed = true;
      }
    }
    this.srcPrev.set(src);
    src.fill(0);

    this.carry = Math.min(this.carry + dt, MAX_STEPS * STEP);
    let peak = 0;
    while (this.carry >= STEP) {
      this.carry -= STEP;
      for (let iz = 1; iz < n - 1; iz++) {
        for (let ix = 1, i = iz * n + 1; ix < n - 1; ix++, i++) {
          const k = c2[i];
          if (k === 0) continue;
          // Dry neighbours are walls: they reflect (their height mirrors this cell's).
          const hl = c2[i - 1] ? h[i - 1] : h[i];
          const hr = c2[i + 1] ? h[i + 1] : h[i];
          const hd = c2[i - n] ? h[i - n] : h[i];
          const hu = c2[i + n] ? h[i + n] : h[i];
          v[i] = (v[i] + (k / STEP) * (hl + hr + hd + hu - 4 * h[i])) * damp[i] * edge[i];
        }
      }
      for (let i = 0; i < h.length; i++) {
        h[i] += v[i] * STEP;
        const a = Math.abs(h[i]);
        if (a > peak) peak = a;
      }
    }
    // Foam fades, and the steepest water whitens a little on its own.
    const fade = Math.exp(-dt / FOAM_LIFE);
    let foamy = false;
    for (let i = 0; i < f.length; i++) {
      if (f[i] > 0) {
        f[i] = Math.min(1, f[i]) * fade;
        if (f[i] < 0.004) f[i] = 0;
        else foamy = true;
      }
    }
    this.idle = peak < CALM && !pushed && !foamy ? this.idle + 1 : 0;
    if (this.idle > IDLE_FRAMES) {
      // Settle exactly flat, and stop.
      h.fill(0);
      v.fill(0);
      this.active = false;
    }
    this.pack();
    return true;
  }

  // (height, foam, dh/dx, dh/dz) per cell for the GPU.
  pack() {
    const { n, h, f, texData, cell } = this;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const o = i * 4;
        texData[o] = h[i];
        texData[o + 1] = f[i];
        texData[o + 2] = ((ix < n - 1 ? h[i + 1] : h[i]) - (ix > 0 ? h[i - 1] : h[i])) / (2 * cell);
        texData[o + 3] = ((iz < n - 1 ? h[i + n] : h[i]) - (iz > 0 ? h[i - n] : h[i])) / (2 * cell);
      }
    }
    this.version++;
  }
}
