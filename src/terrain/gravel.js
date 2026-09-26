// Gravel: small stones on a 9 cm grid, one per cell at a hashed position and size, each a low
// dome. The GPU tyres feel it as ground height (so the tread reacts to every stone) and the
// terrain shader draws the same stones, so what you see is what the tyre rolls over.
//
// Three copies of the same maths: JavaScript (reference and tests), WGSL (tyre solver) and TSL
// (terrain shader). Keep them in step.
import { Fn, If, float, fract, fwidth, int, max, mix, normalize, positionWorld, sqrt, uint, vec2, vec3 } from 'three/tsl';

export const GRAVEL_CELL = 0.09; // m between stone centres
const SQUASH = 0.7; // dome height / radius
// Stones rise above the ground mesh; this share of the full height is taken off everywhere so
// the average surface stays at the mesh.
const SINK = 0.35;

function hash(ix, iz) {
  let h = (Math.imul(ix >>> 0, 73856093) ^ Math.imul(iz >>> 0, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Stone of cell (ix, iz): centre offset within the cell (0..1) and radius (m).
function stone(h) {
  return {
    ox: 0.15 + 0.7 * ((h & 1023) / 1023),
    oz: 0.15 + 0.7 * (((h >>> 10) & 1023) / 1023),
    r: GRAVEL_CELL * (0.3 + 0.25 * (((h >>> 20) & 1023) / 1023)),
  };
}

// Height (m) of the gravel above the ground mesh at full amount (scale by the gravel setting).
export function gravelHeight(x, z) {
  const cx = Math.floor(x / GRAVEL_CELL);
  const cz = Math.floor(z / GRAVEL_CELL);
  let best = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const s = stone(hash(cx + dx, cz + dz));
      const px = (cx + dx + s.ox) * GRAVEL_CELL - x;
      const pz = (cz + dz + s.oz) * GRAVEL_CELL - z;
      best = Math.max(best, Math.sqrt(Math.max(0, s.r * s.r - px * px - pz * pz)) * SQUASH);
    }
  }
  return best - SINK * GRAVEL_CELL * 0.55 * SQUASH;
}

// WGSL bodies for the tyre solver (TypeGPU functions): gravelHash(ix: i32, iz: i32) -> u32 and
// gravelHeight(x: f32, z: f32) -> f32, which calls gravelHash.
export const GRAVEL_HASH_WGSL = /* wgsl */ `(ix, iz) {
  var h = (u32(ix) * 73856093u) ^ (u32(iz) * 19349663u);
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  return h ^ (h >> 16u);
}`;
export const GRAVEL_HEIGHT_WGSL = /* wgsl */ `(x, z) {
  let cell = ${GRAVEL_CELL};
  let cx = i32(floor(x / cell));
  let cz = i32(floor(z / cell));
  var best = 0.0;
  for (var dz = -1; dz <= 1; dz++) {
    for (var dx = -1; dx <= 1; dx++) {
      let h = gravelHash(cx + dx, cz + dz);
      let ox = 0.15 + 0.7 * (f32(h & 1023u) / 1023.0);
      let oz = 0.15 + 0.7 * (f32((h >> 10u) & 1023u) / 1023.0);
      let r = cell * (0.3 + 0.25 * (f32((h >> 20u) & 1023u) / 1023.0));
      let px = (f32(cx + dx) + ox) * cell - x;
      let pz = (f32(cz + dz) + oz) * cell - z;
      best = max(best, sqrt(max(0.0, r * r - px * px - pz * pz)) * ${SQUASH});
    }
  }
  return best - ${SINK * GRAVEL_CELL * 0.55 * SQUASH};
}`;

// TSL: a colour factor for the terrain. Each stone is lit as a dome from the sun's direction and
// gets its own tint (warm or grey, light or dark); the gaps between stones are darker. Fades to
// plain ground where a stone is smaller than a few pixels, so the far view does not shimmer.
const SUN = normalize(vec3(-35, 45, -25)); // matches the sun offset in systems/camera.js
export const gravelShade = Fn(() => {
  const p = positionWorld.xz;
  const cell = float(GRAVEL_CELL);
  const c = p.div(cell).floor();
  const best = float(0).toVar();
  const light = float(0).toVar();
  const tint = float(0).toVar();
  const grey = float(0).toVar();
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const n = c.add(vec2(dx, dz));
      let h = uint(int(n.x)).mul(uint(73856093)).bitXor(uint(int(n.y)).mul(uint(19349663)));
      h = h.bitXor(h.shiftRight(uint(16))).mul(uint(0x45d9f3b));
      h = h.bitXor(h.shiftRight(uint(16))).mul(uint(0x45d9f3b));
      h = h.bitXor(h.shiftRight(uint(16)));
      const ox = float(h.bitAnd(uint(1023))).div(1023).mul(0.7).add(0.15);
      const oz = float(h.shiftRight(uint(10)).bitAnd(uint(1023))).div(1023).mul(0.7).add(0.15);
      const r = float(h.shiftRight(uint(20)).bitAnd(uint(1023))).div(1023).mul(0.25).add(0.3).mul(cell);
      const d = p.sub(n.add(vec2(ox, oz)).mul(cell));
      const top = sqrt(max(r.mul(r).sub(d.dot(d)), 0));
      const height = top.mul(SQUASH);
      If(height.greaterThan(best), () => {
        best.assign(height);
        // Dome normal (flattened like the stone), lit by the sun.
        light.assign(max(normalize(vec3(d.x, top.div(SQUASH), d.y)).dot(SUN), 0));
        tint.assign(fract(ox.mul(13.7).add(oz.mul(7.3))));
        grey.assign(fract(ox.mul(5.1).add(oz.mul(11.9))));
      });
    }
  }
  const inStone = best.greaterThan(0).select(float(1), float(0));
  const base = mix(vec3(1.08, 1.0, 0.9), vec3(0.92, 0.94, 0.97), grey).mul(mix(float(0.8), float(1.15), tint));
  const stoneColor = base.mul(light.mul(0.7).add(0.45));
  const color = mix(vec3(0.7, 0.68, 0.64), stoneColor, inStone);
  // Pixel footprint in cells: fade out the pattern below about 3 pixels per stone.
  const fade = float(1).sub(fwidth(p.x).div(cell).mul(3).clamp(0, 1));
  return mix(vec3(0.93), color, fade);
});
