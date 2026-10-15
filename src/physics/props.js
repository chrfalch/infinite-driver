// Rapier bodies for the sunny town's props (terrain/props.js) around the car: dynamic, and asleep
// until something hits them (the yard kit's fences, hedges, lamps and the like are fixed). They come and go with their chunks (props knocked over come
// back where they were once the car has driven away and returned). The same on the main thread
// (main-thread physics) and in the physics worker.
//
// moved() lists the props that are awake, as [cx, cz, index, x, y, z, qx, qy, qz, qw] per prop
// (chunk, the prop's place in its chunk's list, its pose), for drawing.
import { CHUNK_SIZE, chunkKey } from '../terrain/chunk.js';
import { CONE, CRATE, generateProps, propHalfHeight } from '../terrain/props.js';
import { YARD_BY_NAME } from '../terrain/yard.js';
import { GROUP, groups } from '../tire/soft-tire.js';

export const PROP_RADIUS = 2; // chunks around the car (as render/props-mesh.js)
export const PROP_STRIDE = 10;

export function createPropPhysics(rapier, world, heightAt) {
  const chunks = new Map();
  // Props are part of the world for the car's chassis and rims (which only collide with it).
  const membership = groups(GROUP.WORLD, GROUP.WORLD | GROUP.RIM | GROUP.CHASSIS);

  function add(cx, cz) {
    const bodies = generateProps(heightAt, cx, cz).map((p) => {
      const yard = YARD_BY_NAME.get(p.kind);
      const half = propHalfHeight(p.kind);
      const desc = (yard?.body === 'fixed' ? rapier.RigidBodyDesc.fixed() : rapier.RigidBodyDesc.dynamic())
        .setTranslation(p.x, p.y + half + 0.01, p.z)
        .setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) })
        .setLinearDamping(0.05)
        .setAngularDamping(0.2)
        .setCanSleep(true)
        .setSleeping(true);
      const body = world.createRigidBody(desc);
      const collider = yard
        ? yardCollider(rapier, yard)
        : p.kind === 'crate'
          ? rapier.ColliderDesc.cuboid(CRATE / 2, CRATE / 2, CRATE / 2).setDensity(28).setFriction(0.7)
          : rapier.ColliderDesc.cone(CONE.height / 2, CONE.radius).setDensity(110).setFriction(0.8).setRestitution(0.2);
      world.createCollider(collider.setCollisionGroups(membership), body);
      return body;
    });
    chunks.set(chunkKey(cx, cz), { cx, cz, bodies });
  }

  // A yard prop's collider: its box or cylinder (around its middle), with its mass if loose.
  function yardCollider(rapier, k) {
    const desc = k.shape === 'cylinder' ? rapier.ColliderDesc.cylinder(k.h / 2, Math.max(k.w, k.d) / 2) : rapier.ColliderDesc.cuboid(k.w / 2, k.h / 2, k.d / 2);
    if (k.body !== 'fixed') desc.setMass(k.mass);
    return desc.setFriction(0.7);
  }

  function remove(key, c) {
    for (const b of c.bodies) world.removeRigidBody(b);
    chunks.delete(key);
  }

  // Keeps the props of the chunks around (x, z), dropping those well away.
  function update(x, z) {
    const ccx = Math.floor(x / CHUNK_SIZE);
    const ccz = Math.floor(z / CHUNK_SIZE);
    for (const [key, c] of chunks) if (Math.abs(c.cx - ccx) > PROP_RADIUS + 1 || Math.abs(c.cz - ccz) > PROP_RADIUS + 1) remove(key, c);
    for (let dz = -PROP_RADIUS; dz <= PROP_RADIUS; dz++) {
      for (let dx = -PROP_RADIUS; dx <= PROP_RADIUS; dx++) if (!chunks.has(chunkKey(ccx + dx, ccz + dz))) add(ccx + dx, ccz + dz);
    }
  }

  function moved() {
    const out = [];
    for (const c of chunks.values()) {
      c.bodies.forEach((b, i) => {
        if (b.isSleeping() || b.isFixed()) return;
        const p = b.translation();
        const q = b.rotation();
        out.push(c.cx, c.cz, i, p.x, p.y, p.z, q.x, q.y, q.z, q.w);
      });
    }
    return new Float32Array(out);
  }

  return { update, moved };
}
