// Dust the cars raise on dry ground: soft, camera-facing puffs that swell, drift back from the
// wheels, rise a little and thin out over a few seconds, tinted by the ground they came off. A pool
// of quads the CPU moves, like the water mist (render/water-spray.js); each puff's own colour,
// opacity and a seed for its ragged edge go to the GPU per instance.
import { Color, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, PlaneGeometry, Vector3 } from 'three/webgpu';
import { float, fract, instancedBufferAttribute, sin, smoothstep, uniform, uv, vec3 } from 'three/tsl';

const m4 = new Matrix4();
const ax = new Vector3();
const ay = new Vector3();
const az = new Vector3();
const toCam = new Vector3();
const viewDir = new Vector3();
const WHITE = new Color(1, 1, 1);

export class DustClouds {
  constructor(scene, { capacity = 700, name = 'dust' } = {}) {
    this.capacity = capacity;
    // Unlit (dust glows with the light scattered through it), so the colour carries the light.
    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    this.alpha = new Float32Array(capacity * 2); // opacity, seed
    this.alphaAttr = new InstancedBufferAttribute(this.alpha, 2);
    const puff = instancedBufferAttribute(this.alphaAttr);
    // A soft round puff with a ragged, billowing rim: the radius pushed in and out by a few lobes
    // turned by the puff's seed, and thinner in the middle of its rim than its core.
    const d = uv().sub(0.5).mul(2);
    const angle = d.y.atan(d.x);
    const seed = puff.y.mul(6.2832);
    const lobes = sin(angle.mul(3).add(seed)).mul(0.12).add(sin(angle.mul(5).sub(seed.mul(1.7))).mul(0.08));
    const r = d.length().mul(float(1).add(lobes));
    const grain = fract(sin(d.x.mul(91.7).add(d.y.mul(47.3)).add(seed)).mul(43758.5)).mul(0.15).add(0.85);
    material.opacityNode = float(1).sub(smoothstep(0.15, 1, r)).pow(1.5).mul(grain).mul(puff.x);
    // Lit from above: the top of a puff a little brighter than its underside; dimmed with the
    // daylight (setLight), since it has no lighting of its own.
    this.light = uniform(1);
    material.colorNode = vec3(1).mul(d.y.mul(-0.12).add(1)).mul(this.light);
    this.material = material;
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, WHITE);
    // One invisible quad until the first puff, so its shader is built while the game loads.
    this.mesh.count = 1;
    this.mesh.setMatrixAt(0, m4.makeScale(1e-4, 1e-4, 1e-4));
    this.warming = true;
    this.mesh.name = name;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.opacity = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);
    this.color = this.mesh.instanceColor.array;
    this.count = 0;
    // A light breeze the dust drifts on (m/s).
    this.wind = { x: 0.5, z: 0.25 };
  }

  // A puff at (x, y, z) moving at v, `size` m across at first and `grow` times that at the end of
  // its `life` s, at most `opacity` thick, in `color` (linear).
  emit(x, y, z, vx, vy, vz, size, grow, life, opacity, color) {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.size[i] = size;
    this.grow[i] = grow;
    this.age[i] = 0;
    this.life[i] = life;
    this.opacity[i] = opacity;
    this.seed[i] = Math.random();
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
    this.size[i] = this.size[last];
    this.grow[i] = this.grow[last];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.opacity[i] = this.opacity[last];
    this.seed[i] = this.seed[last];
    this.colorsChanged = true;
  }

  // `groundAt(x, z)`: the ground's height, so a puff never sinks into it. `focus` ({ x, y, z } or
  // null): the player's car, which the dust thins in front of so the camera keeps it in sight.
  update(dt, camera, groundAt, focus = null) {
    const drag = 1.6;
    const k = Math.max(0, 1 - drag * dt);
    for (let i = this.count - 1; i >= 0; i--) {
      const o = i * 3;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.remove(i);
        continue;
      }
      // Slows to the breeze, and warm dust rises slowly.
      this.vel[o] = this.wind.x + (this.vel[o] - this.wind.x) * k;
      this.vel[o + 1] = 0.25 + (this.vel[o + 1] - 0.25) * k;
      this.vel[o + 2] = this.wind.z + (this.vel[o + 2] - this.wind.z) * k;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      const floor = groundAt(this.pos[o], this.pos[o + 2]) + this.size[i] * 0.3;
      if (this.pos[o + 1] < floor) {
        this.pos[o + 1] = floor;
        if (this.vel[o + 1] < 0) this.vel[o + 1] = 0;
      }
    }
    const cam = camera.position;
    const ortho = camera.isOrthographicCamera;
    if (ortho) camera.getWorldDirection(viewDir).negate();
    // The line from the camera to the car (the overhead view looks straight down its own axis).
    const lx = focus ? (ortho ? -viewDir.x * 100 : focus.x - cam.x) : 0;
    const ly = focus ? (ortho ? -viewDir.y * 100 : focus.y - cam.y) : 0;
    const lz = focus ? (ortho ? -viewDir.z * 100 : focus.z - cam.z) : 0;
    const ll = lx * lx + ly * ly + lz * lz || 1;
    const ox = focus ? (ortho ? focus.x + viewDir.x * 100 : cam.x) : 0;
    const oy = focus ? (ortho ? focus.y + viewDir.y * 100 : cam.y) : 0;
    const oz = focus ? (ortho ? focus.z + viewDir.z * 100 : cam.z) : 0;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      const t = this.age[i] / this.life[i];
      const px = this.pos[o];
      const py = this.pos[o + 1];
      const pz = this.pos[o + 2];
      if (ortho) toCam.copy(viewDir);
      else toCam.set(cam.x - px, cam.y - py, cam.z - pz).normalize();
      // Swells fast at first, then slowly; thick soon after it is raised, thinning to nothing.
      const s = this.size[i] * (1 + (this.grow[i] - 1) * Math.sqrt(t));
      // (Thin as it leaves the wheel, so the car stays in view through its own dust; thickest
      // a second or so behind it. And thinned close to the camera, so a chase view is not blinded.)
      const camDist = ortho ? 99 : Math.hypot(cam.x - px, cam.y - py, cam.z - pz);
      const near = Math.min(1, Math.max(0, (camDist - 3) / 12));
      // In the way of the car: thinned by how near the camera's line to it the puff's middle is,
      // counting its size.
      let clear = 1;
      if (focus) {
        const rx = px - ox;
        const ry = py - oy;
        const rz = pz - oz;
        const along = Math.min(1, Math.max(0, (rx * lx + ry * ly + rz * lz) / ll));
        const off = Math.hypot(rx - lx * along, ry - ly * along, rz - lz * along) - s * 0.35;
        if (along < 1) clear = 0.3 + 0.7 * Math.min(1, Math.max(0, off / 1.6));
      }
      this.alpha[i * 2] = this.opacity[i] * Math.min(1, t * 3.5) * (1 - t) * (1 - t) * near * clear;
      this.alpha[i * 2 + 1] = this.seed[i];
      ay.set(0, 1, 0);
      ax.crossVectors(ay, toCam);
      if (ax.lengthSq() < 1e-6) ax.set(1, 0, 0);
      ax.normalize();
      az.crossVectors(ax, ay).normalize();
      ay.crossVectors(az, ax);
      m4.set(ax.x * s, ay.x * s, az.x, px, ax.y * s, ay.y * s, az.y, py, ax.z * s, ay.z * s, az.z, pz, 0, 0, 0, 1);
      this.mesh.setMatrixAt(i, m4);
    }
    if (!this.count) {
      if (!this.warming) this.mesh.count = 0;
      return;
    }
    this.warming = false;
    this.mesh.count = this.count;
    const { instanceMatrix, instanceColor } = this.mesh;
    instanceMatrix.clearUpdateRanges();
    instanceMatrix.addUpdateRange(0, this.count * 16);
    instanceMatrix.needsUpdate = true;
    this.alphaAttr.clearUpdateRanges();
    this.alphaAttr.addUpdateRange(0, this.count * 2);
    this.alphaAttr.needsUpdate = true;
    if (this.colorsChanged) {
      instanceColor.clearUpdateRanges();
      instanceColor.addUpdateRange(0, this.count * 3);
      instanceColor.needsUpdate = true;
      this.colorsChanged = false;
    }
  }

  // 1 by day, down toward 0 in the dark.
  setLight(k) {
    this.light.value = k;
  }

  clear() {
    this.count = 0;
    this.mesh.count = 0;
  }
}
