import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Box3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { YARD_KIT } from '../src/terrain/yard-kit.js';
import { createHeightField } from '../src/terrain/height.js';
import { buildingsAround, insideBuilding } from '../src/terrain/buildings.js';
import { generateProps } from '../src/terrain/props.js';
import { yardProps } from '../src/terrain/yard.js';
import { KERB, ROAD_HALF_WIDTH } from '../src/terrain/town.js';

async function loadKit() {
  const glb = readFileSync(new URL('../public/models/yard-kit.glb', import.meta.url));
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  return (await new GLTFLoader().parseAsync(buffer, '')).scene;
}

describe('yard kit', () => {
  it('has a model per manifest entry, standing on the ground in the middle of its footprint at its listed size', async () => {
    const scene = await loadKit();
    for (const k of YARD_KIT) {
      // A mesh, or a group of one per material (the lamp's glowing glass).
      const model = scene.getObjectByName(k.name);
      expect(model, k.name).toBeDefined();
      const { min, max } = new Box3().setFromObject(model);
      // glTF frame: x along the street, y up, z toward the street.
      expect(min.y).toBeCloseTo(0, 2);
      expect(max.x - min.x).toBeCloseTo(k.w, 1);
      expect(max.y - min.y).toBeCloseTo(k.h, 1);
      expect(max.z - min.z).toBeCloseTo(k.d, 1);
      expect(Math.abs(min.x + max.x)).toBeLessThan(0.02);
      expect(Math.abs(min.z + max.z)).toBeLessThan(0.02);
      model.traverse((o) => {
        if (o.isMesh) expect(o.geometry.attributes.color, k.name).toBeDefined();
      });
    }
  });

  it('lists loose props with a mass and fixed ones without', () => {
    for (const k of YARD_KIT) {
      expect(['loose', 'fixed']).toContain(k.body);
      expect(['box', 'cylinder']).toContain(k.shape);
      if (k.body === 'loose') expect(k.mass).toBeGreaterThan(0);
      else expect(k.mass).toBe(0);
      expect(k.tris).toBeLessThan(2500);
    }
  });

  it('stands its props in front of the sunny town\'s houses: off the road and the retaining walls, out of the buildings', () => {
    const town = createHeightField({ mode: 'daytown' });
    const kinds = new Set();
    let n = 0;
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        const around = buildingsAround(town, cx, cz);
        for (const p of yardProps(town, cx, cz)) {
          const k = YARD_KIT.find((kk) => kk.name === p.kind);
          expect(k).toBeDefined();
          const s = town.sample(p.x, p.z);
          expect(s.dist).toBeGreaterThan(ROAD_HALF_WIDTH);
          expect(s.dist < KERB + 0.35 || s.dist > KERB + 1.2).toBe(true);
          expect(insideBuilding(around, p.x, p.z)).toBe(false);
          expect(Math.abs(p.y - town(p.x, p.z))).toBeLessThan(0.7);
          kinds.add(p.kind);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(400);
    // Most of the kit is used.
    expect(kinds.size).toBeGreaterThan(14);
    // The same every time, and part of the chunk's props; none outside town.
    expect(yardProps(createHeightField({ mode: 'daytown' }), 1, -1)).toEqual(yardProps(town, 1, -1));
    expect(generateProps(town, 1, -1).filter((p) => p.kind.startsWith('Yard_'))).toEqual(yardProps(town, 1, -1));
    expect(yardProps(createHeightField({ mode: 'canyon' }), 0, 0)).toEqual([]);
  });
});
