import { Color, IcosahedronGeometry, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three/webgpu';

const GRAVITY = 9.81;
const DRAG = 1.2; // 1/s, clumps slow down in the air
const SETTLE_TIME = 1.6; // s a landed clump stays before it crumbles away

const material = new MeshStandardMaterial({ roughness: 1, metalness: 0, flatShading: true });
const m4 = new Matrix4();
const q = new Quaternion();
const v3 = new Vector3();
const s3 = new Vector3();

// Soil thrown by the tyres: a pool of small clumps with gravity, drag, and one bounce. When a
// clump lands it settles, shrinks away, and hands its soil back to the ground (onLand), so digging
// at the tyre and piling up where it lands balance out.
export class SoilParticles {
  constructor(scene, { capacity = 2500 } = {}) {
    this.capacity = capacity;
    this.mesh = new InstancedMesh(new IcosahedronGeometry(1, 0), material, capacity);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = 'soil spray';
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
    this.color = new Float32Array(capacity * 3);
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
  }

  update(dt, surfaceAt, onLand) {
    const tmp = new Color();
    for (let i = this.count - 1; i >= 0; i--) {
      const o = i * 3;
      this.age[i] += dt;
      if (this.landed[i] >= 0) {
        this.landed[i] += dt;
        if (this.landed[i] > SETTLE_TIME || this.age[i] > 12) this.remove(i);
        continue;
      }
      this.vel[o + 1] -= GRAVITY * dt;
      const k = Math.max(0, 1 - DRAG * dt);
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
      const shrink = this.landed[i] >= 0 ? Math.max(0, 1 - this.landed[i] / SETTLE_TIME) : 1;
      const s = this.size[i] * shrink;
      const tumble = this.landed[i] >= 0 ? 0 : this.age[i];
      q.setFromAxisAngle(v3.set(this.spin[i * 2], 1, this.spin[i * 2 + 1]).normalize(), tumble * 8);
      m4.compose(v3.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]), q, s3.set(s, s * 0.7, s));
      this.mesh.setMatrixAt(i, m4);
      tmp.setRGB(this.color[o], this.color[o + 1], this.color[o + 2]);
      this.mesh.setColorAt(i, tmp);
    }
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    this.count = 0;
    this.mesh.count = 0;
  }
}
