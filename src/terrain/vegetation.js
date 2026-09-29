// Deterministic bushes and small trees for one terrain chunk (canyon mode only). Lush along the
// road verges and on the valley floor, sparse on the foothills, none on the road or steep rock.
import { CHUNK_SIZE } from './chunk.js';
import { mulberry32 } from './height.js';
import { ROAD_HALF_WIDTH } from './canyon.js';
import { ROCK_REACH } from './riverbed.js';

const CELL = 3; // m, jittered candidate grid

function chunkSeed(cx, cz) {
  let h = 0x9e3779b9 ^ Math.imul(cx, 0x27d4eb2d) ^ Math.imul(cz, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

export function generatePlants(heightAt, cx, cz) {
  if (heightAt.forestAt) return generateSpruces(heightAt, cx, cz);
  if (!heightAt.sample) return [];
  if (heightAt.world === 'river') return generateRiverPlants(heightAt, cx, cz);
  const rand = mulberry32(chunkSeed(cx, cz));
  const plants = [];
  const n = CHUNK_SIZE / CELL;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (cx * n + i + 0.1 + rand() * 0.8) * CELL;
      const z = (cz * n + j + 0.1 + rand() * 0.8) * CELL;
      const roll = rand();
      const kindRoll = rand();
      const size = rand();
      const turn = rand() * Math.PI * 2;
      const shade = rand();
      // Cheap reject before sampling the terrain.
      if (roll > 0.5) continue;
      const s = heightAt.sample(x, z);
      if (s.dist < ROAD_HALF_WIDTH + 1.2) continue;
      const slope = Math.abs(heightAt(x + 0.8, z) - heightAt(x - 0.8, z)) / 1.6 + Math.abs(heightAt(x, z + 0.8) - heightAt(x, z - 0.8)) / 1.6;
      if (slope > 0.75) continue;
      let pBush;
      let pTree;
      if (s.dist < 11) [pBush, pTree] = [0.42, s.dist > 6 ? 0.05 : 0];
      else if (s.dist < 40) [pBush, pTree] = [0.1, 0.02];
      else [pBush, pTree] = [slope < 0.5 ? 0.05 : 0, 0.006];
      if (roll < pTree && kindRoll < 0.9) {
        plants.push({ kind: 'tree', x, y: s.h, z, height: 2.2 + size * 2.2, turn, shade });
      } else if (roll < pTree + pBush) {
        // Bushes are bigger and greener near the road.
        const lush = s.dist < 11 ? 1 : 0.6;
        plants.push({ kind: 'bush', x, y: s.h, z, size: (0.45 + size * 0.85) * lush, turn, shade });
      }
    }
  }
  return plants;
}

// Dry river: open gum forest from the banks outward (tall pale-trunked eucalypts), shrubs along the
// bank tops, nothing in the bed. Gum trees are 'tree' plants (solid trunks) with `gum` set; their
// trunks are thinner for their height than the canyon's junipers.
function generateRiverPlants(heightAt, cx, cz) {
  const rand = mulberry32(chunkSeed(cx, cz) ^ 0x5bd1e995);
  const plants = [];
  const n = CHUNK_SIZE / CELL;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (cx * n + i + 0.1 + rand() * 0.8) * CELL;
      const z = (cz * n + j + 0.1 + rand() * 0.8) * CELL;
      const roll = rand();
      const size = rand();
      const turn = rand() * Math.PI * 2;
      const shade = rand();
      if (roll > 0.3) continue;
      const dist = heightAt.roadDistance(x, z);
      if (dist < ROCK_REACH) continue; // the bed's rock sheet and its walls
      const slope = Math.abs(heightAt(x + 0.8, z) - heightAt(x - 0.8, z)) / 1.6 + Math.abs(heightAt(x, z + 0.8) - heightAt(x, z - 0.8)) / 1.6;
      if (slope > 0.7) continue;
      let pBush;
      let pTree;
      // Trees keep back from the bed (they would hide the car in the top-down view); shrubs line it.
      if (dist < 10) [pBush, pTree] = [0.14, 0];
      else if (dist < 14) [pBush, pTree] = [0.1, 0.04];
      else if (dist < 32) [pBush, pTree] = [0.08, 0.1];
      else if (dist < 90) [pBush, pTree] = [0.05, 0.05];
      else [pBush, pTree] = [0.03, 0.015];
      const y = heightAt(x, z);
      if (roll < pTree) {
        const height = 6 + size * 6;
        plants.push({ kind: 'tree', gum: true, x, y, z, height, trunk: 0.022 * height, turn, shade });
      } else if (roll < pTree + pBush) {
        plants.push({ kind: 'bush', grey: true, x, y, z, size: 0.4 + size * 0.7, turn, shade });
      }
    }
  }
  return plants;
}

// Snowfield: snow-laden spruce in the forest patches (heightAt.forestAt), tall and close together
// inside, thinning to single trees at the edges. Spruces are 'tree' plants (solid trunks) with
// `spruce` set. Candidates on a 2.5 m jittered grid.
function generateSpruces(heightAt, cx, cz) {
  const cell = 2.5;
  const rand = mulberry32(chunkSeed(cx, cz) ^ 0x2c1b3c6d);
  const plants = [];
  const n = Math.round(CHUNK_SIZE / cell);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (cx * n + i + 0.1 + rand() * 0.8) * cell;
      const z = (cz * n + j + 0.1 + rand() * 0.8) * cell;
      const roll = rand();
      const size = rand();
      const turn = rand() * Math.PI * 2;
      const shade = rand();
      const density = heightAt.forestAt(x, z);
      // Open forest (about one tree per 35 m² at its densest), so the car stays in view between them.
      if (roll > density * 0.18) continue;
      // Taller in the middle of a patch.
      const height = 3.5 + 5 * density * (0.6 + 0.4 * size);
      plants.push({ kind: 'tree', spruce: true, x, y: heightAt(x, z), z, height, trunk: 0.02 * height, turn, shade });
    }
  }
  return plants;
}
