// Water thrown up by the cars: drops and streaks (fast, falling, stretched along the way they fly)
// and mist (slow, soft puffs that swell and fade). Each is a pool of camera-facing quads; the CPU
// moves them and writes their matrices, like the soil spray (render/soil-particles.js). A drop that
// falls back into the water strikes it (onWater), so spray leaves its own rings.
import { Color, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardNodeMaterial, PlaneGeometry, Vector3 } from 'three/webgpu';
import { float, instancedBufferAttribute, smoothstep, uv, vec2 } from 'three/tsl';

const GRAVITY = 9.81;
const m4 = new Matrix4();
const ax = new Vector3();
const ay = new Vector3();
const az = new Vector3();
const toCam = new Vector3();
const viewDir = new Vector3();

const DROP_GLOW = new Color('#101a1c');
const MIST_GLOW = new Color('#1a2224');

export class WaterParticles {
  // `kind`: 'drops' (stretched along their flight, fall fast, die in the water) or 'mist' (round,
  // swell, hang in the air and fade).
  constructor(scene, { capacity, kind, name }) {
    this.capacity = capacity;
    this.kind = kind;
    const drops = kind === 'drops';
    // Lit by the sun, with a faint glow of their own so a drop against the light is not black.
    const material = new MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 0.25, metalness: 0 });
    material.color = new Color(drops ? '#e4f1f4' : '#f2f7f8');
    material.emissive = (drops ? DROP_GLOW : MIST_GLOW).clone();
    this.alpha = new Float32Array(capacity);
    this.alphaAttr = new InstancedBufferAttribute(this.alpha, 1);
    const alpha = instancedBufferAttribute(this.alphaAttr);
    // A drop is a soft-edged streak; mist a soft round puff, thin at its rim.
    const d = uv().sub(0.5).mul(2);
    const r = drops ? vec2(d.x, d.y.mul(0.6)).length() : d.length();
    material.opacityNode = float(1).sub(smoothstep(drops ? 0.45 : 0.1, 1, r)).mul(alpha);
    this.material = material;
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // One invisible quad until the first drop, so its shader is built while the game loads rather
    // than with a hitch the first time a car drives into the water.
    this.mesh.count = 1;
    this.mesh.setMatrixAt(0, m4.makeScale(1e-4, 1e-4, 1e-4));
    this.warming = true;
    this.mesh.name = name;
    this.mesh.renderOrder = 2; // after the water
    scene.add(this.mesh);
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.opacity = new Float32Array(capacity);
    this.count = 0;
  }

  emit(x, y, z, vx, vy, vz, size, life, opacity = 1) {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.size[i] = size;
    this.age[i] = 0;
    this.life[i] = life;
    this.opacity[i] = opacity;
    return true;
  }

  remove(i) {
    const last = --this.count;
    if (i === last) return;
    this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.size[i] = this.size[last];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.opacity[i] = this.opacity[last];
  }

  // `waterAt(x, z)`: the water's surface there; `groundAt(x, z)`: the ground's. `onWater(x, z,
  // size, speed)`: a drop fell into the water.
  update(dt, camera, waterAt, groundAt, onWater) {
    const drops = this.kind === 'drops';
    const drag = drops ? 0.35 : 2.2;
    const gravity = drops ? GRAVITY : 0.6;
    for (let i = this.count - 1; i >= 0; i--) {
      const o = i * 3;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.remove(i);
        continue;
      }
      this.vel[o + 1] -= gravity * dt;
      const k = Math.max(0, 1 - drag * dt);
      this.vel[o] *= k;
      this.vel[o + 1] *= k;
      this.vel[o + 2] *= k;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (drops && this.vel[o + 1] < 0) {
        const x = this.pos[o];
        const z = this.pos[o + 2];
        const water = waterAt(x, z);
        const ground = groundAt(x, z);
        if (this.pos[o + 1] < Math.max(water, ground)) {
          if (water > ground) onWater?.(x, z, this.size[i], -this.vel[o + 1]);
          this.remove(i);
        }
      }
    }
    // Camera-facing quads: a drop's long side along its flight (a streak in the frame's blur),
    // mist square.
    // Toward the camera: from each quad to it, or the one direction of the overhead (orthographic) view.
    const cam = camera.position;
    const ortho = camera.isOrthographicCamera;
    if (ortho) camera.getWorldDirection(viewDir).negate();
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      const t = this.age[i] / this.life[i];
      const px = this.pos[o];
      const py = this.pos[o + 1];
      const pz = this.pos[o + 2];
      if (ortho) toCam.copy(viewDir);
      else toCam.set(cam.x - px, cam.y - py, cam.z - pz).normalize();
      let width;
      let length;
      if (drops) {
        ay.set(this.vel[o], this.vel[o + 1], this.vel[o + 2]);
        const speed = ay.length();
        if (speed > 0.05) ay.multiplyScalar(1 / speed);
        else ay.set(0, 1, 0);
        width = this.size[i];
        length = this.size[i] + Math.min(0.5, speed * 0.03);
        this.alpha[i] = this.opacity[i] * Math.min(1, (1 - t) * 4);
      } else {
        ay.set(0, 1, 0);
        width = length = this.size[i] * (1 + t * 2.5);
        this.alpha[i] = this.opacity[i] * Math.min(1, t * 8) * (1 - t) * (1 - t);
      }
      ax.crossVectors(ay, toCam);
      if (ax.lengthSq() < 1e-6) ax.set(1, 0, 0);
      ax.normalize();
      az.crossVectors(ax, ay).normalize();
      if (!drops) ay.crossVectors(az, ax);
      m4.set(ax.x * width, ay.x * length, az.x, px, ax.y * width, ay.y * length, az.y, py, ax.z * width, ay.z * length, az.z, pz, 0, 0, 0, 1);
      this.mesh.setMatrixAt(i, m4);
    }
    if (!this.count) {
      if (!this.warming) this.mesh.count = 0;
      return;
    }
    this.warming = false;
    this.mesh.count = this.count;
    const { instanceMatrix } = this.mesh;
    instanceMatrix.clearUpdateRanges();
    instanceMatrix.addUpdateRange(0, this.count * 16);
    instanceMatrix.needsUpdate = true;
    this.alphaAttr.clearUpdateRanges();
    this.alphaAttr.addUpdateRange(0, this.count);
    this.alphaAttr.needsUpdate = true;
  }

  // Night dims the spray's own faint glow.
  setGlow(k) {
    this.material.emissive.copy(this.kind === 'drops' ? DROP_GLOW : MIST_GLOW).multiplyScalar(k);
  }

  clear() {
    this.count = 0;
    this.mesh.count = 0;
  }
}

export function createWaterSpray(scene, { low = false } = {}) {
  return {
    drops: new WaterParticles(scene, { capacity: low ? 1200 : 4000, kind: 'drops', name: 'water drops' }),
    mist: new WaterParticles(scene, { capacity: low ? 120 : 400, kind: 'mist', name: 'water mist' }),
  };
}
