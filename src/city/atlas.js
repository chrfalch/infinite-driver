// Packs a building group's walls into one square atlas for the facade photo bake: each wall gets a
// rectangle of (length x height) at a common density (pixels per metre), as high as fits.
// Shelf packing: walls sorted by height, placed left to right in rows.
const PAD = 2; // px between rectangles, so filtering never mixes two walls

function shelfPack(walls, size, density) {
  const order = walls.map((w, i) => i).sort((a, b) => walls[b].top - walls[b].bottom - (walls[a].top - walls[a].bottom));
  const rects = new Array(walls.length);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const i of order) {
    const w = Math.max(1, Math.ceil(walls[i].length * density));
    const h = Math.max(1, Math.ceil((walls[i].top - walls[i].bottom) * density));
    if (w + PAD > size) return null;
    if (x + w + PAD > size) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    if (y + h + PAD > size) return null;
    rects[i] = { x: x + PAD / 2, y: y + PAD / 2, w, h };
    x += w + PAD;
    rowHeight = Math.max(rowHeight, h + PAD);
  }
  return rects;
}

// Returns { density, rects } with rects[i] = { x, y, w, h } in atlas pixels (y down from the top),
// or null when even the lowest density does not fit.
export function packWalls(walls, size, { minDensity = 1, maxDensity = 16 } = {}) {
  if (!walls.length) return { density: maxDensity, rects: [] };
  let lo = minDensity;
  let hi = maxDensity;
  let best = shelfPack(walls, size, lo);
  if (!best) return null;
  let bestDensity = lo;
  for (let k = 0; k < 12; k++) {
    const mid = (lo + hi) / 2;
    const rects = shelfPack(walls, size, mid);
    if (rects) {
      best = rects;
      bestDensity = mid;
      lo = mid;
    } else hi = mid;
  }
  return { density: bestDensity, rects: best };
}
