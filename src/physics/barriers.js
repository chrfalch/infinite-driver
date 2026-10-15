// Rapier colliders for the stadium's barriers (terrain/stadium.js heightAt.barrierBoxes): the
// striped rails along the lanes and the arena's concrete wall. All fixed, all made once (the arena
// is small), with rounded edges and little friction so a car glances off and scrapes along.
// The same on the main thread (main-thread physics) and in the physics worker.
import { GROUP, groups } from '../tire/soft-tire.js';

const ROUND = 0.08; // m rounding of the edges

export function createBarrierPhysics(rapier, world, heightAt) {
  // Part of the world for the car's chassis and rims (which only collide with it), as the props.
  const membership = groups(GROUP.WORLD, GROUP.WORLD | GROUP.RIM | GROUP.CHASSIS);
  const body = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  for (const b of heightAt.barrierBoxes) {
    const half = (b.top - b.bottom) / 2;
    const desc = rapier.ColliderDesc.roundCuboid(b.length / 2 - ROUND, half - ROUND, b.thick / 2 - ROUND, ROUND)
      .setTranslation(b.x, b.bottom + half, b.z)
      .setRotation({ x: 0, y: Math.sin(b.yaw / 2), z: 0, w: Math.cos(b.yaw / 2) })
      .setFriction(b.kind === 'rail' ? 0.25 : 0.4)
      .setRestitution(0.15)
      .setCollisionGroups(membership);
    world.createCollider(desc, body);
  }
  return body;
}
