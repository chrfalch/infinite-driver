// Chunk worker: builds a terrain chunk's data off the main thread. That is the heights, the ground
// mesh's vertex data, the rocks and their mesh data, the plants, and the dry river's rock sheet
// and pebbles.
// The main thread only turns the arrays into meshes. Everything comes from seeded functions, so
// the result is the same as building the chunk on the main thread (see systems/terrain.js).
import { chunkMeshData } from '../render/terrain-mesh.js';
import { rocksMeshData } from '../render/rock-mesh.js';
import { sampleChunk } from './chunk.js';
import { createHeightField } from './height.js';
import { generatePebbles, generateRocks } from './rocks.js';
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
  // Just the dry river's rock sheet and pebbles, for a chunk the main thread built itself (they
  // cost ~90 ms).
  if (msg.type === 'sheet') {
    const sheet = rockSheetData(heightAt, msg.cx, msg.cz);
    const pebbles = generatePebbles(heightAt, msg.cx, msg.cz);
    const transfer = sheet ? [sheet.positions.buffer, sheet.normals.buffer, sheet.colors.buffer, sheet.indices.buffer] : [];
    if (pebbles) transfer.push(pebbles.buffer);
    postMessage({ type: 'sheet', cx: msg.cx, cz: msg.cz, sheet, pebbles }, transfer);
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
    const pebbles = generatePebbles(heightAt, cx, cz);
    const transfer = [heights.buffer, ...Object.values(mesh).map((a) => a.buffer)];
    if (sheet) transfer.push(sheet.positions.buffer, sheet.normals.buffer, sheet.colors.buffer, sheet.indices.buffer);
    if (rocksMesh) transfer.push(rocksMesh.positions.buffer, rocksMesh.colors.buffer, rocksMesh.normals.buffer);
    if (pebbles) transfer.push(pebbles.buffer);
    postMessage({ type: 'chunk', cx, cz, heights, mesh, rocks, rocksMesh, plants, sheet, pebbles }, transfer);
  } catch (error) {
    postMessage({ type: 'error', cx: msg.cx, cz: msg.cz, message: String(error?.stack ?? error) });
  }
};
