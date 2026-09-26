import { describe, expect, it } from 'vitest';
import { steeringGeometry, steeringJointAngles } from '../src/render/car-mesh.js';

describe('steering linkage to the rack (independent suspension)', () => {
  it('bends the shaft at two moderate universal joints', () => {
    const { upper, lower } = steeringJointAngles(steeringGeometry({ independent: true }));
    for (const a of [upper, lower]) {
      expect(a).toBeGreaterThan(3);
      expect(a).toBeLessThan(30);
    }
  });
});
