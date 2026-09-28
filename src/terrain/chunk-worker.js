// Chunk worker: builds a terrain chunk's data off the main thread. That is the heights, the ground
// mesh's vertex data, the rocks and their mesh data, the plants, and the dry river's rock sheet.
// The main thread only turns the arrays into meshes. Everything comes from seeded functions, so
// the result is the same as building the chunk on the main thread (see systems/terrain.js).
import { chunkMeshData } from '../render/terrain-mesh.js';
import { rocksMeshData } from '../render/rock-mesh.js';
import { sampleChunk } from './chunk.js';
import { createHeightField } from './height.js';
import { generateRocks } from './rocks.js';
import { generatePlants } from './vegetation.js';
import { rockSheetData } from './rock-sheet.js';

let heightAt = null;
let rockCount = 70;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    heightAt = createHeightField({ mode: msg.mode });
    rockCount = msg.rockCount;
    return;
  }
  if (msg.type !== 'chunk') return;
  try {
    const { cx, cz } = msg;
    const heights = sampleChunk(heightAt, cx, cz);
    const mesh = chunkMeshData(heightAt, heights, cx, cz);
    const rocks = generateRocks(heightAt, cx, cz, { count: rockCount });
    const rocksMesh = rocksMeshData(rocks);
    const plants = generatePlants(heightAt, cx, cz);
    const sheet = rockSheetData(heightAt, cx, cz);
    const transfer = [heights.buffer, ...Object.values(mesh).map((a) => a.buffer)];
    if (sheet) transfer.push(sheet.positions.buffer, sheet.normals.buffer, sheet.colors.buffer);
    if (rocksMesh) transfer.push(rocksMesh.positions.buffer, rocksMesh.colors.buffer, rocksMesh.normals.buffer);
    postMessage({ type: 'chunk', cx, cz, heights, mesh, rocks, rocksMesh, plants, sheet }, transfer);
  } catch (error) {
    postMessage({ type: 'error', cx: msg.cx, cz: msg.cz, message: String(error?.stack ?? error) });
  }
};
