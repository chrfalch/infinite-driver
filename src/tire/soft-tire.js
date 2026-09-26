import { TIRE } from './config.js';

// Collision groups: the tyre touches the world but not its own rim or the car.
export const GROUP = { WORLD: 0x0001, RIM: 0x0002, TIRE: 0x0004, CHASSIS: 0x0008 };
export const groups = (member, filter) => (member << 16) | filter;

// Torus around the local z axis (the axle), with an elliptical tube: half-width across, half-height radially.
export function torusMesh(tire = TIRE, { mirror = false } = {}) {
  const nu = Math.round(tire.segmentsAround);
  const nv = Math.round(tire.segmentsAcross);
  const major = (tire.outerRadius + tire.rimRadius) / 2;
  const radial = (tire.outerRadius - tire.rimRadius) / 2;
  const across = tire.width / 2;
  const vertices = new Float32Array(nu * nv * 3);
  for (let i = 0; i < nu; i++) {
    const u = (i / nu) * Math.PI * 2;
    for (let j = 0; j < nv; j++) {
      const v = (j / nv) * Math.PI * 2;
      const r = major + radial * Math.cos(v);
      vertices.set([r * Math.cos(u), r * Math.sin(u), (mirror ? -across : across) * Math.sin(v)], (i * nv + j) * 3);
    }
  }
  const indices = new Uint32Array(nu * nv * 6);
  let k = 0;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * nv + j;
      const b = ((i + 1) % nu) * nv + j;
      const c = ((i + 1) % nu) * nv + ((j + 1) % nv);
      const d = i * nv + ((j + 1) % nv);
      // Outward winding, so the enclosed volume is positive. The diagonal alternates in a
      // checkerboard so the mesh has no handedness (one-way diagonals make the tyre steer).
      const tris = (i + j) % 2 === 0 ? [a, b, c, a, c, d] : [a, b, d, b, c, d];
      // A mirrored tyre (right side of the car) flips the winding to stay outward.
      if (mirror) for (let t = 0; t < 6; t += 3) [tris[t + 1], tris[t + 2]] = [tris[t + 2], tris[t + 1]];
      indices.set(tris, k);
      k += 6;
    }
  }
  // The bead: the inner rings of each cross-section, which sit on the rim.
  const bead = [];
  const inner = Math.round(nv / 2);
  const spread = Math.max(0, Math.round(tire.beadRings ?? 0));
  for (let i = 0; i < nu; i++) {
    for (let d = -spread; d <= spread; d++) bead.push(i * nv + ((inner + d + nv) % nv));
  }
  return { vertices, indices, bead, nu, nv };
}

export function tireMaterial(RAPIER, tire = TIRE) {
  const m = RAPIER.SoftBodyMaterial.uniform(tire.carcassStiffness, tire.damping);
  m.edgeSoftness = { naturalFrequency: tire.carcassStiffness, dampingRatio: tire.damping };
  m.bendSoftness = { naturalFrequency: tire.sidewallStiffness, dampingRatio: tire.damping };
  m.volumeSoftness = { naturalFrequency: tire.airStiffness, dampingRatio: tire.damping };
  m.shapeMatchingSoftness = { naturalFrequency: tire.shapeMemory, dampingRatio: tire.damping };
  return m;
}

// Transforms local points by a rigid pose (position + quaternion).
function transform(points, p, q) {
  const out = new Float32Array(points.length);
  const { x: qx, y: qy, z: qz, w: qw } = q;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    // v' = v + 2w(q×v) + 2q×(q×v)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    out[i] = x + qw * tx + (qy * tz - qz * ty) + p.x;
    out[i + 1] = y + qw * ty + (qz * tx - qx * tz) + p.y;
    out[i + 2] = z + qw * tz + (qx * ty - qy * tx) + p.z;
  }
  return out;
}

// Builds a soft tyre around `hub` (a rigid body whose local z is the axle) and pins its bead to it.
export function createSoftTire(RAPIER, world, hub, tire = TIRE, { mirror = false } = {}) {
  const mesh = torusMesh(tire, { mirror });
  const vertices = transform(mesh.vertices, hub.translation(), hub.rotation());
  const desc = RAPIER.SoftBodyDesc.trimesh(vertices, mesh.indices)
    .setMass(tire.rubberMass)
    .setMaterial(tireMaterial(RAPIER, tire))
    .setVolumeFactor(tire.inflation)
    .setAdditionalSolverIterations(Math.round(tire.substeps ?? 0))
    .setAdditionalPgsIterations(Math.round(tire.pgsIterations))
    .setSurfaceCollider(
      RAPIER.ColliderDesc.ball(0.01)
        .setFriction(tire.friction)
        .setCollisionGroups(groups(GROUP.TIRE, GROUP.WORLD)),
    );
  const soft = world.createSoftBody(desc);
  for (const i of mesh.bead) soft.attachParticle(i, hub);
  return { soft, mesh };
}

// Applies settings that do not change the mesh.
export function updateSoftTire(RAPIER, soft, tire = TIRE) {
  soft.setMaterial(tireMaterial(RAPIER, tire));
  soft.setVolumeFactor(tire.inflation);
}

// Settings that need the tyre rebuilt.
export const TIRE_REBUILD_KEYS = [
  'outerRadius',
  'rimRadius',
  'width',
  'segmentsAround',
  'segmentsAcross',
  'rubberMass',
  'friction',
  'beadRings',
  'substeps',
  'pgsIterations',
];
