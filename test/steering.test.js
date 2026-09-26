import { describe, expect, it } from 'vitest';
import { steeringGeometry, steeringJointAngles } from '../src/render/car-mesh.js';

describe('steering linkage', () => {
  it('bends the shaft at two moderate universal joints', () => {
    const { upper, lower } = steeringJointAngles(steeringGeometry());
    console.log('steering joint angles (deg): upper', upper.toFixed(1), 'lower', lower.toFixed(1));
    for (const a of [upper, lower]) {
      expect(a).toBeGreaterThan(3); // visibly a joint
      expect(a).toBeLessThan(30); // within what a real steering u-joint handles smoothly
    }
  });
});
