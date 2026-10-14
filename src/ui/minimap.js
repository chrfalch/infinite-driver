// Round minimap in the bottom left corner: the ground around the car from above (shaded relief,
// the road or river bed, the snowfield's lake and forest), turned so the car always points up,
// with the car as an arrow in the middle, a fading dark trail behind it and N on the rim.
//
// The ground is sampled from the height field into a square tile around the car, a few rows per
// frame so building it never stalls a frame; the tile is redrawn around the car before it drives
// out of it. Each frame only draws that tile, rotated, into the round canvas.
//
// In the sunny town the fun places are marked on top (terrain/fun.js), upright: stunt parks as
// orange stars, street jumps as yellow triangles, river gap jumps as blue badges; a park or gap
// just off the map sits on its rim, pointing the way.
//
// Where the car has been is tinted blue: cells of VISIT_CELL m within VISIT_RADIUS of its path,
// kept for the session and painted into a layer over the tile.
//
// In the towns the buildings are drawn on top of the tile, crisp at any zoom (their footprints,
// turned to their streets); they are placed a chunk's worth per frame once the tile is done.
import { funPlaces } from '../terrain/fun.js';
import { generateBuildings } from '../terrain/buildings.js';
import { CHUNK_SIZE } from '../terrain/chunk.js';

export const VIEW_RADIUS = 140; // m, from the middle of the map to its rim
export const TILE_HALF = 280; // m, half the tile's side
export const TILE_PX = 224; // tile pixels per side (2.5 m each)
const REBUILD_AT = TILE_HALF - VIEW_RADIUS - 30; // m from the tile's centre
const BUILD_BUDGET = 2; // ms of sampling per frame
const TRAIL_STEP = 4; // m between trail points
const TRAIL_POINTS = 120;
const VISIT_CELL = 4; // m
const VISIT_RADIUS = 10; // m either side of the car's path
const VISITED = [64, 92, 228]; // RGB: a deeper blue than the lakes

// Map colours per world (RGB 0..255): the ground, the road (or river bed), and how strongly the
// relief is shaded.
const PALETTES = {
  canyon: { ground: [201, 138, 92], high: [176, 98, 66], road: [243, 231, 205], edge: [128, 92, 70], relief: 1.1 },
  river: { ground: [164, 152, 112], high: [140, 128, 92], road: [236, 218, 170], edge: [118, 104, 76], relief: 1 },
  snow: { ground: [243, 246, 250], high: [222, 230, 240], road: [132, 132, 134], edge: [190, 198, 210], relief: 0.8 },
  // The town at night: dark lawns and hills, the streets a little lighter.
  town: { ground: [44, 62, 46], high: [70, 76, 80], road: [120, 122, 128], edge: [26, 32, 30], relief: 0.9 },
  // The sunny town: green lawns and hills, grey streets.
  daytown: { ground: [128, 168, 104], high: [150, 150, 140], road: [96, 98, 104], edge: [70, 96, 62], relief: 0.9 },
  plain: { ground: [180, 173, 132], high: [150, 150, 108], road: [236, 226, 200], edge: [120, 110, 90], relief: 1 },
};
const LAKE = [160, 194, 216];
const FOREST = [104, 132, 110];
const ROAD_HALF = { canyon: 3.2, river: 4, snow: 3.2, town: 4.2, daytown: 4.2 }; // m, drawn at least two pixels wide

export function paletteFor(heightAt) {
  return PALETTES[heightAt.world] ?? PALETTES.plain;
}

// The angle (radians) to turn the map by so the car's forward direction (fx, fz in world x/z)
// points up. The map draws world +x to the right and +z down (north, -z, is up when unturned).
export function headingUpAngle(fx, fz) {
  return -Math.PI / 2 - Math.atan2(fz, fx);
}

// The car's forward axis (chassis +x) in world space, from its orientation.
export function forwardOf({ x, y, z, w }) {
  return { x: 1 - 2 * (y * y + z * z), y: 2 * (x * y + w * z), z: 2 * (x * z - w * y) };
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Builds one tile's pixels around (cx, cz), row by row. `step(budgetMs)` samples rows until the
// budget runs out and returns true once the tile is complete; `pixels` is then RGBA.
export function createTileBuilder(heightAt, cx, cz, { half = TILE_HALF, px = TILE_PX, now = () => performance.now() } = {}) {
  const palette = paletteFor(heightAt);
  const cell = (2 * half) / px;
  const heights = new Float32Array(px * px);
  const kind = new Float32Array(px * px * 4); // road, its edge, lake, forest (0..1) per pixel
  const verge = new Float32Array(px * px); // near the road (0..1): its banks and cuttings are too fine to shade
  const pixels = new Uint8ClampedArray(px * px * 4);
  const roadHalf = Math.max(ROAD_HALF[heightAt.world] ?? 3, cell);
  let row = 0;
  let done = false;

  const sampleRow = (j) => {
    const z = cz - half + (j + 0.5) * cell;
    for (let i = 0; i < px; i++) {
      const x = cx - half + (i + 0.5) * cell;
      const k = j * px + i;
      heights[k] = heightAt(x, z);
      const d = heightAt.roadDistance ? heightAt.roadDistance(x, z) : Infinity;
      // Coverage from the distance, anti-aliased over a pixel, so the road does not stair-step when
      // the tile is scaled up and turned.
      kind[k * 4] = 1 - smooth(roadHalf - cell * 0.5, roadHalf + cell * 0.5, d);
      kind[k * 4 + 1] = 1 - smooth(roadHalf + cell * 0.3, roadHalf + cell * 1.3, d);
      verge[k] = 1 - smooth(roadHalf + cell, roadHalf + 4 * cell, d);
      kind[k * 4 + 2] = heightAt.lakeInside ? smooth(-cell * 0.5, cell * 0.5, heightAt.lakeInside(x, z)) : 0;
      kind[k * 4 + 3] = heightAt.forestAt?.(x, z) ?? 0;
    }
  };

  // Colours from the heights once they are all in: elevation tint, light from the north-west.
  const shade = () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of heights) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    const span = Math.max(4, hi - lo);
    const { ground, high, road, edge, relief } = palette;
    for (let j = 0; j < px; j++) {
      for (let i = 0; i < px; i++) {
        const k = j * px + i;
        const hx = (heights[j * px + Math.min(px - 1, i + 1)] - heights[j * px + Math.max(0, i - 1)]) / (2 * cell);
        const hz = (heights[Math.min(px - 1, j + 1) * px + i] - heights[Math.max(0, j - 1) * px + i]) / (2 * cell);
        // Lit from the north-west (-x, -z) and from above: faces sloping up towards the light are brighter.
        const light = Math.min(1.25, Math.max(0.55, 1 + ((hx + hz) * 0.7071 * relief * (1 - verge[k])) / Math.hypot(1, hx, hz)));
        const e = (heights[k] - lo) / span;
        let r = ground[0] + (high[0] - ground[0]) * e;
        let g = ground[1] + (high[1] - ground[1]) * e;
        let b = ground[2] + (high[2] - ground[2]) * e;
        // The forest stops sharply (clear of the road, say): averaged over the pixels around, so
        // its edges do not stair-step.
        let forest = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++)
            forest += kind[(Math.min(px - 1, Math.max(0, j + dj)) * px + Math.min(px - 1, Math.max(0, i + di))) * 4 + 3];
        forest /= 9;
        r += (FOREST[0] - r) * forest * 0.7;
        g += (FOREST[1] - g) * forest * 0.7;
        b += (FOREST[2] - b) * forest * 0.7;
        r *= light;
        g *= light;
        b *= light;
        const lake = kind[k * 4 + 2];
        r += (LAKE[0] - r) * lake;
        g += (LAKE[1] - g) * lake;
        b += (LAKE[2] - b) * lake;
        // The road with a darker edge either side, so it reads on light ground too.
        const on = kind[k * 4];
        const rim = kind[k * 4 + 1] * 0.6;
        r += (edge[0] - r) * rim;
        g += (edge[1] - g) * rim;
        b += (edge[2] - b) * rim;
        r += (road[0] - r) * on;
        g += (road[1] - g) * on;
        b += (road[2] - b) * on;
        pixels[k * 4] = r;
        pixels[k * 4 + 1] = g;
        pixels[k * 4 + 2] = b;
        pixels[k * 4 + 3] = 255;
      }
    }
  };

  return {
    cx,
    cz,
    half,
    px,
    pixels,
    get done() {
      return done;
    },
    step(budgetMs = BUILD_BUDGET) {
      if (done) return true;
      const start = now();
      while (row < px) {
        sampleRow(row++);
        if (now() - start > budgetMs) break;
      }
      if (row === px) {
        shade();
        done = true;
      }
      return done;
    },
  };
}

// One fun place's marker at (x, y), `r` about its radius.
function drawPlace(ctx, kind, x, y, r, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.2, r * 0.28);
  ctx.strokeStyle = 'rgba(31, 29, 25, 0.85)';
  if (kind === 'jump') {
    // A small yellow warning triangle.
    const a = r * 0.75;
    ctx.beginPath();
    ctx.moveTo(0, -a);
    ctx.lineTo(a * 0.95, a * 0.7);
    ctx.lineTo(-a * 0.95, a * 0.7);
    ctx.closePath();
    ctx.fillStyle = '#f5c518';
    ctx.stroke();
    ctx.fill();
  } else {
    // A round badge: an orange one with a star for a stunt park, a blue one with two chevrons
    // (up and over) for a river gap.
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = kind === 'park' ? '#ef7d22' : '#2f8fd0';
    ctx.stroke();
    ctx.fill();
    ctx.fillStyle = ctx.strokeStyle = '#fff6e2';
    if (kind === 'park') {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const t = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? r * 0.32 : r * 0.7;
        ctx.lineTo(Math.cos(t) * rr, Math.sin(t) * rr);
      }
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.lineWidth = Math.max(1.2, r * 0.22);
      ctx.lineCap = 'round';
      for (const dy of [-0.18, 0.22]) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.45, (dy + 0.2) * r);
        ctx.lineTo(0, (dy - 0.22) * r);
        ctx.lineTo(r * 0.45, (dy + 0.2) * r);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

// The buildings of the chunks under a tile, a chunk per step (they take a few ms each to place):
// step(budgetMs) returns them all once done, null until then.
export function tileBuildings(heightAt, cx, cz, half, now = () => performance.now()) {
  if (!heightAt.town) return { step: () => [] };
  const chunks = [];
  for (let i = Math.floor((cx - half) / CHUNK_SIZE); i <= Math.floor((cx + half) / CHUNK_SIZE); i++) {
    for (let j = Math.floor((cz - half) / CHUNK_SIZE); j <= Math.floor((cz + half) / CHUNK_SIZE); j++) chunks.push([i, j]);
  }
  const out = [];
  let k = 0;
  return {
    step(budgetMs = 2) {
      const start = now();
      while (k < chunks.length) {
        for (const rock of generateBuildings(heightAt, chunks[k][0], chunks[k][1])) out.push(rock.building);
        k++;
        if (now() - start > budgetMs) break;
      }
      return k < chunks.length ? null : out;
    },
  };
}

// Draws the buildings within `reach` m of (x, z), in world metres (the map's transform applied).
function drawBuildings(ctx, buildings, x, z, reach, night, lineWidth) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = lineWidth;
  for (const b of buildings) {
    if (Math.abs(b.x - x) > reach || Math.abs(b.z - z) > reach) continue;
    if (b.kit === 'Kit_Fountain') {
      // A fountain's paved plaza.
      ctx.beginPath();
      ctx.arc(b.x, b.z, 8, 0, Math.PI * 2);
      ctx.fillStyle = night ? 'rgb(96, 100, 106)' : 'rgb(214, 208, 192)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(b.x, b.z, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgb(86, 160, 196)';
      ctx.fill();
      continue;
    }
    const corner = (a, c) => [b.x + b.ux * a * b.w * 0.5 + b.nx * c * b.d * 0.5, b.z + b.uz * a * b.w * 0.5 + b.nz * c * b.d * 0.5];
    ctx.beginPath();
    for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) ctx.lineTo(...corner(a, c));
    ctx.closePath();
    ctx.fillStyle = night ? 'rgb(132, 120, 108)' : 'rgb(196, 112, 82)';
    ctx.strokeStyle = night ? 'rgb(40, 38, 36)' : 'rgb(118, 62, 46)';
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export function createMinimap(heightAt) {
  const root = document.createElement('div');
  root.className = 'minimap';
  root.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  root.append(canvas);
  document.body.append(root);
  const ctx = canvas.getContext('2d');
  const palette = paletteFor(heightAt);
  const background = `rgb(${palette.ground.join(',')})`;

  let tile = null; // { canvas, cx, cz, half }
  let building = null;
  let places = []; // fun places around the tile
  let finding = null;
  let housing = null; // the tile's buildings, being placed
  let buildings = [];
  const visited = new Set(); // 'ix,iz' cells the car has been near
  let visits = null; // { canvas, ctx, cx, cz, half }: the visited cells over the current tile
  let lastVisit = null;
  const cellKey = (ix, iz) => `${ix},${iz}`;
  const paintVisit = (ix, iz) => {
    if (!visits) return;
    const n = visits.canvas.width;
    const px = Math.floor(((ix + 0.5) * VISIT_CELL - (visits.cx - visits.half)) / VISIT_CELL);
    const pz = Math.floor(((iz + 0.5) * VISIT_CELL - (visits.cz - visits.half)) / VISIT_CELL);
    if (px >= 0 && pz >= 0 && px < n && pz < n) visits.ctx.fillRect(px, pz, 1, 1);
  };
  // A layer for the tile around (cx, cz), with every cell visited so far.
  const startVisits = (cx, cz, half) => {
    const c = document.createElement('canvas');
    c.width = c.height = Math.round((2 * half) / VISIT_CELL);
    const vctx = c.getContext('2d');
    vctx.fillStyle = `rgb(${VISITED.join(',')})`;
    visits = { canvas: c, ctx: vctx, cx: Math.round(cx / VISIT_CELL) * VISIT_CELL, cz: Math.round(cz / VISIT_CELL) * VISIT_CELL, half };
    for (const key of visited) {
      const [ix, iz] = key.split(',').map(Number);
      paintVisit(ix, iz);
    }
  };
  const visit = (x, z) => {
    const r = Math.ceil(VISIT_RADIUS / VISIT_CELL);
    const ix0 = Math.floor(x / VISIT_CELL);
    const iz0 = Math.floor(z / VISIT_CELL);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const ix = ix0 + dx;
        const iz = iz0 + dz;
        if (Math.hypot((ix + 0.5) * VISIT_CELL - x, (iz + 0.5) * VISIT_CELL - z) > VISIT_RADIUS) continue;
        const key = cellKey(ix, iz);
        if (visited.has(key)) continue;
        visited.add(key);
        paintVisit(ix, iz);
      }
    }
  };
  const trail = [];
  let angle = null; // the map's turn (radians); snaps to the car's heading on the first frame

  const startTile = (x, z) => {
    building = createTileBuilder(heightAt, x, z);
    finding = funPlaces(heightAt, x, z, TILE_HALF);
    housing = tileBuildings(heightAt, x, z, TILE_HALF);
  };
  const finishTile = () => {
    const c = document.createElement('canvas');
    c.width = c.height = building.px;
    c.getContext('2d').putImageData(new ImageData(building.pixels, building.px, building.px), 0, 0);
    tile = { canvas: c, cx: building.cx, cz: building.cz, half: building.half };
    startVisits(tile.cx, tile.cz, tile.half);
    building = null;
  };

  // `position`, `rotation`: the car body's world position and orientation (quaternion).
  const update = (position, rotation) => {
    const { x, z } = position;
    const forward = forwardOf(rotation);
    // A new tile around the car before it reaches the old one's edge (the old one stays up meanwhile).
    if (!building && (!tile || Math.max(Math.abs(x - tile.cx), Math.abs(z - tile.cz)) > REBUILD_AT)) startTile(x, z);
    if (building?.step()) finishTile();
    else if (!building && housing) {
      const found = housing.step(2);
      if (found) {
        buildings = found;
        housing = null;
      }
    } else if (!building && finding) {
      const found = finding.step(1);
      if (found) {
        places = found;
        finding = null;
      }
    }

    if (!lastVisit || Math.hypot(x - lastVisit.x, z - lastVisit.z) > 2) {
      visit(x, z);
      lastVisit = { x, z };
    }

    const last = trail[trail.length - 1];
    if (!last || Math.hypot(x - last.x, z - last.z) > TRAIL_STEP) {
      // A respawn jumps the car: the old trail no longer leads to it.
      if (last && Math.hypot(x - last.x, z - last.z) > 40) trail.length = 0;
      trail.push({ x, z });
      if (trail.length > TRAIL_POINTS) trail.shift();
    }

    // Size the canvas to its CSS box (it changes with the layout) at the screen's pixel ratio.
    const size = root.clientWidth;
    if (!size) return;
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const backing = Math.round(size * dpr);
    if (canvas.width !== backing) canvas.width = canvas.height = backing;

    // Turn smoothly, so a jittery heading at a standstill does not shake the map.
    const fl = Math.hypot(forward.x, forward.z);
    if (fl > 0.2) {
      const target = headingUpAngle(forward.x, forward.z);
      angle = angle === null ? target : angle + Math.atan2(Math.sin(target - angle), Math.cos(target - angle)) * 0.25;
    }

    angle ??= 0;
    const R = size / 2;
    const scale = R / VIEW_RADIUS; // CSS px per metre
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size, size);
    ctx.translate(R, R);
    ctx.rotate(angle);
    ctx.scale(scale, scale);
    ctx.translate(-x, -z);
    if (tile) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tile.canvas, tile.cx - tile.half, tile.cz - tile.half, tile.half * 2, tile.half * 2);
    }
    drawBuildings(ctx, buildings, x, z, VIEW_RADIUS * 1.45, heightAt.world === 'town', 1.2 / scale);
    if (visits) {
      ctx.globalAlpha = 0.42;
      ctx.drawImage(visits.canvas, visits.cx - visits.half, visits.cz - visits.half, visits.half * 2, visits.half * 2);
      ctx.globalAlpha = 1;
    }
    if (trail.length > 1) {
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(3, size * 0.022) / scale;
      for (let i = 1; i < trail.length; i++) {
        ctx.strokeStyle = `rgba(31, 29, 25, ${0.15 + (0.6 * i) / trail.length})`;
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].z);
        ctx.lineTo(i === trail.length - 1 ? x : trail[i].x, i === trail.length - 1 ? z : trail[i].z);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Soft vignette towards the rim.
    const vignette = ctx.createRadialGradient(R, R, R * 0.7, R, R, R);
    vignette.addColorStop(0, 'rgba(31, 29, 25, 0)');
    vignette.addColorStop(1, 'rgba(31, 29, 25, 0.28)');
    ctx.fillStyle = vignette;
    ctx.beginPath();
    ctx.arc(R, R, R, 0, Math.PI * 2);
    ctx.fill();

    // Fun places, upright; parks and gaps off the map on its rim.
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R, 0, Math.PI * 2);
    ctx.clip();
    const icon = Math.max(5, size * 0.045);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const place of places) {
      const dx = place.x - x;
      const dz = place.z - z;
      let sx = (dx * cos - dz * sin) * scale;
      let sy = (dx * sin + dz * cos) * scale;
      const d = Math.hypot(sx, sy);
      const rim = R - icon * 1.4;
      let off = false;
      if (d > rim) {
        if (place.kind === 'jump' || d > R * 2.2) continue;
        sx *= rim / d;
        sy *= rim / d;
        off = true;
      }
      drawPlace(ctx, place.kind, R + sx, R + sy, off ? icon * 0.8 : icon, off ? 0.75 : 1);
    }
    ctx.restore();

    // The car: an arrow pointing up, in the HUD's needle orange.
    const a = Math.max(7, size * 0.06);
    ctx.save();
    ctx.translate(R, R);
    ctx.beginPath();
    ctx.moveTo(0, -a);
    ctx.lineTo(a * 0.72, a * 0.8);
    ctx.lineTo(0, a * 0.42);
    ctx.lineTo(-a * 0.72, a * 0.8);
    ctx.closePath();
    ctx.fillStyle = '#e8743f';
    ctx.strokeStyle = '#fff6e2';
    ctx.lineWidth = Math.max(1.5, a * 0.22);
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fill();

    // N on the rim, where north (-z) is after turning.
    const n = angle - Math.PI / 2;
    const nr = R - Math.max(9, size * 0.075);
    const nx = Math.cos(n) * nr;
    const ny = Math.sin(n) * nr;
    const badge = Math.max(7.5, size * 0.062);
    ctx.beginPath();
    ctx.arc(nx, ny, badge, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(31, 29, 25, 0.78)';
    ctx.fill();
    ctx.fillStyle = '#fff6e2';
    ctx.font = `600 ${Math.round(badge * 1.25)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + badge * 0.06);
    ctx.restore();
  };

  return {
    root,
    update,
    get tile() {
      return tile;
    },
    get visited() {
      return visited;
    },
    get places() {
      return places;
    },
  };
}
