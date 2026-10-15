import { Color, IcosahedronGeometry, InstancedMesh, OctahedronGeometry, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three/webgpu';

const GRAVITY = 9.81;
const DRAG = 1.2; // 1/s, clumps slow down in the air (powder snow: more, see `drag`)
const SETTLE_TIME = 1.6; // s a landed clump stays before it crumbles away

const material = new MeshStandardMaterial({ roughness: 1, metalness: 0, flatShading: true });
// Powder snow scatters light through itself: no dark faces or self-shadowing.
const POWDER_GLOW = new Color('#b8c2cc');
const powderMaterial = new MeshStandardMaterial({ roughness: 1, metalness: 0, flatShading: true, emissive: POWDER_GLOW });
// How strongly the powder glows (1 by day; the time of day dims it at night).
export function setPowderGlow(k) {
  powderMaterial.emissive.copy(POWDER_GLOW).multiplyScalar(k);
}
const m4 = new Matrix4();
const q = new Quaternion();
const v3 = new Vector3();
const s3 = new Vector3();

// Soil thrown by the tyres: a pool of small clumps with gravity, drag, and one bounce. When a
// clump lands it settles, shrinks away, and hands its soil back to the ground (onLand), so digging
// at the tyre and piling up where it lands balance out. Fine grains (sand, dust) use the same pool
// with a cheaper shape, no shadows, and a quick settle (createFineParticles).
export class SoilParticles {
  constructor(scene, { capacity = 2500, drag = DRAG, powder = false, settle = SETTLE_TIME, geometry = null, shadows = true, name = 'soil spray' } = {}) {
    this.capacity = capacity;
    this.drag = drag;
    this.settle = settle;
    this.mesh = new InstancedMesh(geometry ?? new IcosahedronGeometry(1, 0), powder ? powderMaterial : material, capacity);
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = !powder;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = name;
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, new Color(1, 1, 1));
    scene.add(this.mesh);
    // Structure of arrays for the live clumps, packed in [0, count).
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.landed = new Float32Array(capacity); // seconds since settling, or -1 in flight
    this.bounced = new Uint8Array(capacity);
    this.spin = new Float32Array(capacity * 2);
    // Colours are written into the instance colours as clumps are thrown, and move with them.
    this.color = this.mesh.instanceColor.array;
    this.count = 0;
  }

  emit(x, y, z, vx, vy, vz, size, color) {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.size[i] = size;
    this.age[i] = 0;
    this.landed[i] = -1;
    this.bounced[i] = 0;
    this.spin.set([Math.random() * 6, Math.random() * 6], i * 2);
    this.color.set([color.r, color.g, color.b], i * 3);
    this.colorsChanged = true;
    return true;
  }

  remove(i) {
    const last = --this.count;
    if (i === last) return;
    this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.color.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.spin.copyWithin(i * 2, last * 2, last * 2 + 2);
    this.size[i] = this.size[last];
    this.age[i] = this.age[last];
    this.landed[i] = this.landed[last];
    this.bounced[i] = this.bounced[last];
    this.colorsChanged = true;
  }

  update(dt, surfaceAt, onLand) {
    for (let i = this.count - 1; i >= 0; i--) {
      const o = i * 3;
      this.age[i] += dt;
      if (this.landed[i] >= 0) {
        this.landed[i] += dt;
        if (this.landed[i] > this.settle || this.age[i] > 12) this.remove(i);
        continue;
      }
      this.vel[o + 1] -= GRAVITY * dt;
      const k = Math.max(0, 1 - this.drag * dt);
      this.vel[o] *= k;
      this.vel[o + 1] *= k;
      this.vel[o + 2] *= k;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      const ground = surfaceAt(this.pos[o], this.pos[o + 2]) + this.size[i] * 0.5;
      if (this.pos[o + 1] < ground) {
        this.pos[o + 1] = ground;
        const speed = Math.hypot(this.vel[o], this.vel[o + 1], this.vel[o + 2]);
        if (this.bounced[i] || speed < 1.5) {
          this.landed[i] = 0;
          onLand?.(this.pos[o], this.pos[o + 2], this.size[i]);
        } else {
          this.bounced[i] = 1;
          this.vel[o + 1] *= -0.25;
          this.vel[o] *= 0.4;
          this.vel[o + 2] *= 0.4;
        }
      }
    }
    // Write instances: clumps tumble in flight and crumble once settled.
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      const shrink = this.landed[i] >= 0 ? Math.max(0, 1 - this.landed[i] / this.settle) : 1;
      const s = this.size[i] * shrink;
      const tumble = this.landed[i] >= 0 ? 0 : this.age[i];
      q.setFromAxisAngle(v3.set(this.spin[i * 2], 1, this.spin[i * 2 + 1]).normalize(), tumble * 8);
      m4.compose(v3.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]), q, s3.set(s, s * 0.7, s));
      this.mesh.setMatrixAt(i, m4);
    }
    this.mesh.count = this.count;
    // Only the live clumps go to the GPU (the pools hold up to 8000).
    const { instanceMatrix, instanceColor } = this.mesh;
    if (!this.count) return;
    instanceMatrix.clearUpdateRanges();
    instanceMatrix.addUpdateRange(0, this.count * 16);
    instanceMatrix.needsUpdate = true;
    if (this.colorsChanged) {
      instanceColor.clearUpdateRanges();
      instanceColor.addUpdateRange(0, this.count * 3);
      instanceColor.needsUpdate = true;
      this.colorsChanged = false;
    }
  }

  clear() {
    this.count = 0;
    this.mesh.count = 0;
  }
}

// Sand and dust kicked up with the clumps: many tiny grains that hang in the air a little longer
// and vanish soon after they land (too fine to pile up visibly).
export function createFineParticles(scene) {
  return new SoilParticles(scene, { capacity: 8000, drag: 2.2, settle: 0.5, geometry: new OctahedronGeometry(1, 0), shadows: false, name: 'soil fines' });
}
