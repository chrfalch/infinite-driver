import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MeshStandardMaterial } from 'three/webgpu';
import { terrainColorAt } from './terrain-mesh.js';

const SPACING = 0.12; // metres between track segments
const MAX_GAP = 1.2; // a longer jump (airborne, respawn) starts a new track
const LIFT = 0.006; // above the ground, against z-fighting

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

// Tyre tracks: one ring buffer of quads per wheel, coloured as darker, compressed soil with a
// tread pattern. The oldest quarter of each ring fades back into the ground colour.
export class TireTracks {
  constructor(scene, { wheels = 4, segments = 1500 } = {}) {
    this.wheels = wheels;
    this.segments = segments;
    const quads = wheels * segments;
    this.positions = new Float32Array(quads * 4 * 3);
    this.colors = new Float32Array(quads * 4 * 3);
    this.base = new Float32Array(quads * 3); // ground colour per segment
    this.strength = new Float32Array(quads); // how dark each segment is when fresh
    const index = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) index.set([q * 4, q * 4 + 2, q * 4 + 1, q * 4 + 1, q * 4 + 2, q * 4 + 3], q * 6);
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
    const y = heightAt(point.x, point.z) + LIFT;
    const half = width / 2;
    const left = { x: point.x - right.x * half, y, z: point.z - right.z * half };
    const rightEdge = { x: point.x + right.x * half, y, z: point.z + right.z * half };
    if (s.last) {
      const d = Math.hypot(point.x - s.last.x, point.z - s.last.z);
      if (d < SPACING) return;
      if (d < MAX_GAP) {
        const q = wheel * this.segments + s.head;
        const o = q * 12;
        this.positions.set([s.last.left.x, s.last.left.y, s.last.left.z, s.last.right.x, s.last.right.y, s.last.right.z], o);
        this.positions.set([left.x, left.y, left.z, rightEdge.x, rightEdge.y, rightEdge.z], o + 6);
        terrainColorAt(heightAt, point.x, point.z, this.tmp);
        this.base.set([this.tmp.r, this.tmp.g, this.tmp.b], q * 3);
        // Alternating shade reads as the tread pattern pressed into the soil.
        s.stripe = 1 - s.stripe;
        this.strength[q] = strength * (s.stripe ? 1 : 0.8);
        s.head = (s.head + 1) % this.segments;
        s.count = Math.min(s.count + 1, this.segments);
        this.dirty = true;
      }
    }
    s.last = { x: point.x, z: point.z, left, right: rightEdge };
  }

  // Breaks the track (for example when the car is respawned).
  lift(wheel) {
    this.state[wheel].last = null;
  }

  update(delta) {
    this.fadeTimer -= delta;
    if (!this.dirty && this.fadeTimer > 0) return;
    this.fadeTimer = 0.5;
    this.dirty = false;
    for (let w = 0; w < this.wheels; w++) {
      const s = this.state[w];
      for (let i = 0; i < s.count; i++) {
        // Age 0 is the newest segment.
        const slot = (s.head - 1 - i + this.segments * 2) % this.segments;
        const q = w * this.segments + slot;
        const age = i / this.segments;
        const fade = age < 0.75 ? 1 : Math.max(0, 1 - (age - 0.75) / 0.25);
        const k = 1 - 0.42 * this.strength[q] * fade;
        const r = this.base[q * 3] * k;
        const g = this.base[q * 3 + 1] * k * 0.98;
        const b = this.base[q * 3 + 2] * k * 0.95;
        for (let v = 0; v < 4; v++) this.colors.set([r, g, b], q * 12 + v * 3);
      }
    }
    this.mesh.geometry.getAttribute('position').needsUpdate = true;
    this.mesh.geometry.getAttribute('color').needsUpdate = true;
  }

  clear() {
    for (const s of this.state) Object.assign(s, { last: null, head: 0, count: 0 });
    this.positions.fill(0);
    this.colors.fill(0);
    this.mesh.geometry.getAttribute('position').needsUpdate = true;
    this.mesh.geometry.getAttribute('color').needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}
