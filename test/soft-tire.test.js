import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TIRE } from '../src/tire/config.js';
import { GROUP, createSoftTire, groups, torusMesh } from '../src/tire/soft-tire.js';

beforeAll(async () => {
  await RAPIER.init();
});

// One tyre on a hub that can only move in the x-y plane and spin about z.
function rig(tire, load) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 120;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setCollisionGroups(groups(GROUP.WORLD, 0xffff)),
  );
  const hub = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.6, 0).enabledTranslations(true, true, false).enabledRotations(false, false, true),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(0.1, tire.rimRadius - 0.02)
      .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 })
      .setMass(load)
      .setCollisionGroups(groups(GROUP.RIM, GROUP.WORLD)),
    hub,
  );
  const { soft } = createSoftTire(RAPIER, world, hub, tire);
  for (let i = 0; i < 360; i++) world.step();
  return { world, hub, soft };
}

describe('soft tyre', () => {
  it('builds a closed torus with outward winding and a pinned bead', () => {
    const m = torusMesh(DEFAULT_TIRE);
    expect(m.vertices.length / 3).toBe(DEFAULT_TIRE.segmentsAround * DEFAULT_TIRE.segmentsAcross);
    expect(m.bead.length).toBe(DEFAULT_TIRE.segmentsAround * (2 * DEFAULT_TIRE.beadRings + 1));
  });

  it('carries a quarter of the car with a plausible deflection and does not creep', () => {
    const unloaded = rig(DEFAULT_TIRE, 5).hub.translation().y;
    const { hub } = rig(DEFAULT_TIRE, 450);
    const deflection = unloaded - hub.translation().y;
    console.log('deflection under 450 kg (m)', deflection.toFixed(3), 'creep (m)', hub.translation().x.toFixed(3));
    expect(deflection).toBeGreaterThan(0.02);
    expect(deflection).toBeLessThan(0.12);
    expect(Math.abs(hub.translation().x)).toBeLessThan(0.3);
  });

  it('rides higher with more air', () => {
    const low = rig({ ...DEFAULT_TIRE, inflation: 0.92 }, 450).hub.translation().y;
    const high = rig({ ...DEFAULT_TIRE, inflation: 1.1 }, 450).hub.translation().y;
    console.log('hub height at inflation 0.92 vs 1.10', low.toFixed(3), high.toFixed(3));
    expect(high).toBeGreaterThan(low + 0.03);
  });

  it('settles to the same height after drops from different heights', () => {
    const heights = [0.6, 1.5].map((y) => {
      const r = rig(DEFAULT_TIRE, 450);
      r.hub.setTranslation({ x: 0, y, z: 0 }, true);
      r.hub.setLinvel({ x: 0, y: 0, z: 0 }, true);
      let sum = 0;
      for (let i = 0; i < 720; i++) {
        r.world.step();
        if (i >= 600) sum += r.hub.translation().y;
      }
      return sum / 120;
    });
    console.log('settled after drops', heights.map((h) => h.toFixed(3)).join(' '));
    expect(Math.abs(heights[0] - heights[1])).toBeLessThan(0.02);
  });
});
