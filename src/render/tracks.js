import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MeshStandardMaterial } from 'three/webgpu';
import { terrainColorAt } from './terrain-mesh.js';

const SPACING = 0.12; // metres between track segments
const MAX_GAP = 1.2; // a longer jump (airborne, respawn) starts a new track
const LIFT = 0.006; // above the ground, against z-fighting
const QUADS = 5; // floor, then inner and outer slope of the berm on each side
const CREST = 0.07; // berm crest distance outside the track edge
const FOOT = 0.17; // berm foot distance outside the track edge

const material = new MeshStandardMaterial({
  vertexColors: true,
  roughness: 1,
  metalness: 0,
  // Winding depends on the direction of travel, so draw both faces.
  side: DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});

// Tyre tracks: one ring buffer of segments per wheel. Each segment is a darker, compressed-soil
// floor with a tread stripe, and low berms of pushed-aside soil along both edges whose height comes
// from the ground deformation. The oldest quarter of each ring fades back into the ground.
export class TireTracks {
  constructor(scene, { wheels = 4, segments = 1500, deformation = null } = {}) {
    this.wheels = wheels;
    this.segments = segments;
    this.deformation = deformation;
    const total = wheels * segments;
    this.positions = new Float32Array(total * QUADS * 4 * 3);
    this.colors = new Float32Array(total * QUADS * 4 * 3);
    // Per segment: last left/right, current left/right (x, z), outward axle (x, z), ground y at both ends.
    this.geo = new Float32Array(total * 12);
    this.base = new Float32Array(total * 3);
    this.strength = new Float32Array(total);
    this.used = new Uint8Array(total);
    const index = new Uint32Array(total * QUADS * 6);
    for (let q = 0; q < total * QUADS; q++) index.set([q * 4, q * 4 + 2, q * 4 + 1, q * 4 + 1, q * 4 + 2, q * 4 + 3], q * 6);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new BufferAttribute(this.colors, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    this.mesh = new Mesh(geometry, material);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'tyre tracks';
    scene.add(this.mesh);
    this.state = Array.from({ length: wheels }, () => ({ last: null, head: 0, count: 0, stripe: 0 }));
    this.dirty = false;
    this.fadeTimer = 0;
    this.tmp = new Color();
  }

  // Records a contact point for a wheel. `right` is the unit axle direction in the ground plane.
  add(wheel, heightAt, point, right, width, strength) {
    const s = this.state[wheel];
    const half = width / 2;
    const y = heightAt(point.x, point.z);
    const cur = { x: point.x, z: point.z, y, lx: point.x - right.x * half, lz: point.z - right.z * half, rx: point.x + right.x * half, rz: point.z + right.z * half };
    if (s.last) {
      const d = Math.hypot(point.x - s.last.x, point.z - s.last.z);
      if (d < SPACING) return;
      if (d < MAX_GAP) {
        const q = wheel * this.segments + s.head;
        this.geo.set([s.last.lx, s.last.lz, s.last.rx, s.last.rz, cur.lx, cur.lz, cur.rx, cur.rz, right.x, right.z, s.last.y, y], q * 12);
        terrainColorAt(heightAt, point.x, point.z, this.tmp);
        this.base.set([this.tmp.r, this.tmp.g, this.tmp.b], q * 3);
        // Alternating shade reads as the tread pattern pressed into the soil.
        s.stripe = 1 - s.stripe;
        this.strength[q] = strength * (s.stripe ? 1 : 0.8);
        this.used[q] = 1;
        s.head = (s.head + 1) % this.segments;
        s.count = Math.min(s.count + 1, this.segments);
        this.dirty = true;
      }
    }
    s.last = cur;
  }

  // Breaks the track (for example when the car is respawned).
  lift(wheel) {
    this.state[wheel].last = null;
  }

  berm(x, z) {
    return this.deformation ? Math.max(0, this.deformation.at(x, z)) : 0;
  }

  writeQuad(q, k, a, b, c, d, color) {
    const o = (q * QUADS + k) * 12;
    this.positions.set([a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]], o);
    for (let v = 0; v < 4; v++) this.colors.set(color, o + v * 3);
  }

  update(delta) {
    this.fadeTimer -= delta;
    if (!this.dirty && this.fadeTimer > 0) return;
    this.fadeTimer = 0.4;
    this.dirty = false;
    for (let w = 0; w < this.wheels; w++) {
      const s = this.state[w];
      for (let i = 0; i < s.count; i++) {
        const slot = (s.head - 1 - i + this.segments * 2) % this.segments;
        const q = w * this.segments + slot;
        const age = i / this.segments;
        const fade = age < 0.75 ? 1 : Math.max(0, 1 - (age - 0.75) / 0.25);
        const g = this.geo.subarray(q * 12, q * 12 + 12);
        const [l0x, l0z, r0x, r0z, l1x, l1z, r1x, r1z, ax, az, y0, y1] = g;
        const k = 1 - 0.42 * this.strength[q] * fade;
        const br = this.base[q * 3];
        const bg = this.base[q * 3 + 1];
        const bb = this.base[q * 3 + 2];
        const floor = [br * k, bg * k * 0.98, bb * k * 0.95];
        this.writeQuad(q, 0, [l0x, y0 + LIFT, l0z], [r0x, y0 + LIFT, r0z], [l1x, y1 + LIFT, l1z], [r1x, y1 + LIFT, r1z], floor);
        // Berms: loose soil, a touch lighter than the ground; they fade with the track.
        const loose = [br * 1.06, bg * 1.05, bb * 1.04];
        for (const [side, k0, k1] of [[-1, 1, 2], [1, 3, 4]]) {
          const e0 = side < 0 ? [l0x, l0z] : [r0x, r0z];
          const e1 = side < 0 ? [l1x, l1z] : [r1x, r1z];
          const ox = ax * side;
          const oz = az * side;
          const c0 = [e0[0] + ox * CREST, e0[1] + oz * CREST];
          const c1 = [e1[0] + ox * CREST, e1[1] + oz * CREST];
          const h0 = y0 + LIFT + this.berm(c0[0], c0[1]) * fade;
          const h1 = y1 + LIFT + this.berm(c1[0], c1[1]) * fade;
          const f0 = [e0[0] + ox * FOOT, y0 + LIFT, e0[1] + oz * FOOT];
          const f1 = [e1[0] + ox * FOOT, y1 + LIFT, e1[1] + oz * FOOT];
          this.writeQuad(q, k0, [e0[0], y0 + LIFT, e0[1]], [c0[0], h0, c0[1]], [e1[0], y1 + LIFT, e1[1]], [c1[0], h1, c1[1]], floor);
          this.writeQuad(q, k1, [c0[0], h0, c0[1]], f0, [c1[0], h1, c1[1]], f1, loose);
        }
      }
    }
    this.mesh.geometry.getAttribute('position').needsUpdate = true;
    this.mesh.geometry.getAttribute('color').needsUpdate = true;
  }

  clear() {
    for (const s of this.state) Object.assign(s, { last: null, head: 0, count: 0 });
    this.positions.fill(0);
    this.colors.fill(0);
    this.used.fill(0);
    this.mesh.geometry.getAttribute('position').needsUpdate = true;
    this.mesh.geometry.getAttribute('color').needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}
