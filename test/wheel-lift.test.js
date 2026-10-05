import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three/webgpu';
import { wheelLift } from '../src/systems/views.js';

// A world whose ground is `surfaceAt`, and a GPU-tyred car whose tyre 0 has the given particles
// (x, y, z, clearance), drawn moved by `offset`.
function setup(surfaceAt, particles, offset) {
  const world = { get: () => ({ surfaceAt }) };
  const positions = new Float32Array(particles.flat());
  const vehicle = { drawOffset: offset, controller: { gpu: { solver: { positions, perTire: particles.length } } } };
  return { world, vehicle };
}

describe('wheel height correction for the drawing offset', () => {
  const touching = [[0, 0.02, 0, 0.02], [0.1, 0.02, 0, 0.01], [0, 0.5, 0, 0.1]];

  it('cancels the chassis bounce for a tyre on the ground', () => {
    const { world, vehicle } = setup(() => 0, touching, new Matrix4().makeTranslation(0, 0.015, 0));
    expect(wheelLift(world, vehicle, 0)).toBeCloseTo(-0.015, 6);
  });

  it('follows the ground where the tyre is drawn', () => {
    // A 10 % slope up along x, and the tyre drawn 0.2 m further on (no change in height).
    const { world, vehicle } = setup((x) => 0.1 * x, touching, new Matrix4().makeTranslation(0.2, 0, 0));
    expect(wheelLift(world, vehicle, 0)).toBeCloseTo(0.02, 6);
  });

  it('leaves a wheel in the air to move with the chassis', () => {
    const inAir = touching.map(([x, y, z]) => [x, y + 0.3, z, 0.1]);
    const { world, vehicle } = setup(() => 0, inAir, new Matrix4().makeTranslation(0, 0.015, 0));
    expect(wheelLift(world, vehicle, 0)).toBe(0);
  });
});
