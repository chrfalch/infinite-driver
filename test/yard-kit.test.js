import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Box3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { YARD_KIT } from '../src/terrain/yard-kit.js';

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
});
