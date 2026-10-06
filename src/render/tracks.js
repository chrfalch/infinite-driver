import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { abs, attribute, cameraPosition, clamp, float, fract, int, mix, modelWorldMatrix, normalize, positionLocal, positionWorld, smoothstep, transformNormalToView, uniformArray, varying, vec3, vec4 } from 'three/tsl';
import { RIVER_PBR, bump, groundPatches, soilColor } from './river-ground.js';
import { rutAt } from './rut-map.js';
import { terrainColorAt } from './terrain-mesh.js';
import { count } from '../perf.js';

const SPACING = 0.12; // metres between track segments
const MAX_GAP = 1.2; // default: a longer jump (respawn) starts a new track
const LIFT = 0.006; // above the ground, against z-fighting
const QUADS = 5; // floor, then inner and outer slope of the berm on each side
const VERTS = QUADS * 4; // vertices per segment
const SETTLING = 40; // newest segments whose berms still follow the ground
const CREST = 0.07; // berm crest distance outside the track edge
const FOOT = 0.17; // berm foot distance outside the track edge
const FADE_START = 0.75; // the oldest quarter of each ring fades out

// The soil texture's mean colour, as soilColor returns it (render/river-ground.js).
const SOIL_TEXTURE_MEAN = vec3(0.225, 0.156, 0.082);

// Per vertex: colour without the track darkening, `seg` = (wheel, sequence number, darkening),
// `berm` = berm height (crest vertices only) and `tread` = (along, across) on the floor (along in
// segments, across 0..1; across < 0 off the floor). The fade of old segments happens in the shader,
// from each wheel's newest sequence number, so old segments never have to be rewritten.
// `ruts` (render/rut-map.js): the track lies in its rut instead of over it. On snow (`snow`) the
// track is packed snow: a little greyer than the snow around, with no soil texture.
function createMaterial(heads, segments, ruts, snow) {
  const seg = attribute('seg', 'vec3');
  const head = heads.element(int(seg.x));
  const age = head.sub(1).sub(seg.y).div(float(segments));
  const fade = clamp(float(1).sub(age.sub(FADE_START).div(1 - FADE_START)), 0, 1);
  const material = new MeshStandardNodeMaterial({
    roughness: snow ? 0.6 : 1,
    metalness: 0,
    // Winding depends on the direction of travel, so draw both faces.
    side: DoubleSide,
    // Overlapping segments (in turns) would z-fight; without depth writes they simply draw in
    // buffer order, newest on top, and still hide behind the car and rocks.
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // Berms sink back into the ground as the track fades.
  let position = positionLocal.add(vec3(0, attribute('berm', 'float').mul(fade), 0));
  if (ruts) {
    // Down into the rut (on snow: onto the snow surface, ruts and berms and all), and 3 cm toward
    // the camera: the ground near the car is drawn on its own grids (1 m mesh, 25 cm rock sheet,
    // 12.5 cm patches), whose facets cut across the rut's floor, and the track writes no depth, so
    // it would hide behind them.
    const world = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
    position = ruts.absolute
      ? vec3(positionLocal.x, rutAt(ruts, world.x, world.z, positionLocal.y).add(LIFT), positionLocal.z)
      : position.add(vec3(0, rutAt(ruts, world.x, world.z).min(0), 0));
    position = position.add(normalize(cameraPosition.sub(world)).mul(0.03));
  }
  material.positionNode = position;
  const fadeV = varying(fade);
  // The tyre's tread printed in the floor: chevron lugs about 7 cm apart across the middle, square
  // shoulder blocks at the edges; the print fades with the track.
  const tread = attribute('tread', 'vec2');
  const along = tread.x.mul(SPACING);
  const across = tread.y;
  const middle = abs(across.sub(0.5));
  const chevron = fract(along.div(0.07).add(middle.mul(1.6)));
  const shoulder = fract(along.div(0.09).add(0.25));
  const lugs = mix(smoothstep(0.45, 0.55, chevron), smoothstep(0.4, 0.5, shoulder), smoothstep(0.33, 0.38, middle));
  const onFloor = smoothstep(-0.05, 0.05, across).mul(fadeV);
  const print = varying(onFloor).mul(lugs);
  // Soil: pressed darker, with the soil texture as detail over the track's own colour (on the dry
  // river's photo look with the bed's slow tone patches, so it matches the soil pockets). Snow:
  // packed, only a little greyer. The berms (loose, no darkening) a touch lighter.
  const shade = float(1).sub(seg.z.mul(fadeV).mul(snow ? 0.35 : 1));
  const texel = snow ? vec3(1) : soilColor(positionWorld.xz).mul(RIVER_PBR ? groundPatches(positionWorld.xz) : 1).div(SOIL_TEXTURE_MEAN);
  const loose = snow ? float(1) : float(1).sub(smoothstep(0, 0.02, seg.z)).mul(0.08).add(1);
  material.colorNode = vec4(attribute('color', 'vec3').mul(texel).mul(shade).mul(print.mul(snow ? -0.12 : -0.22).add(1)).mul(loose), 1);
  // The lugs pressed 1 cm into the floor.
  const face = normalize(positionWorld.dFdx().cross(positionWorld.dFdy()));
  const up = face.mul(face.y.sign());
  material.normalNode = transformNormalToView(bump(up, print.mul(-0.01)));
  return material;
}

// Merges a new [start, start + count) range into an attribute's pending upload ranges.
function markRange(attr, start, count) {
  const ranges = attr.updateRanges;
  const last = ranges[ranges.length - 1];
  if (last && last.start + last.count === start) last.count += count;
  else if (last && start + count === last.start) {
    last.start = start;
    last.count += count;
  } else attr.addUpdateRange(start, count);
  attr.needsUpdate = true;
}

// Tyre tracks: one ring buffer of segments per wheel. Each segment is a darker, compressed-soil
// floor with a tread stripe, and low berms of pushed-aside soil along both edges whose height comes
// from the ground deformation. The oldest quarter of each ring fades back into the ground.
// Only new segments and the settling berms of the newest ones are written and uploaded.
export class TireTracks {
  constructor(scene, { wheels = 4, segments = 1500, deformation = null, ruts = null, snow = false } = {}) {
    this.wheels = wheels;
    this.segments = segments;
    this.deformation = deformation;
    const total = wheels * segments;
    const verts = total * VERTS;
    this.positions = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 3);
    this.seg = new Float32Array(verts * 3);
    this.bermHeights = new Float32Array(verts);
    this.tread = new Float32Array(verts * 2);
    // Berm crest points per segment: left c0, left c1, right c0, right c1 (x, z).
    this.crests = new Float32Array(total * 8);
    const index = new Uint32Array(total * QUADS * 6);
    for (let q = 0; q < total * QUADS; q++) {
      const v = q * 4;
      const o = q * 6;
      index[o] = v;
      index[o + 1] = v + 2;
      index[o + 2] = v + 1;
      index[o + 3] = v + 1;
      index[o + 4] = v + 2;
      index[o + 5] = v + 3;
    }
    const geometry = new BufferGeometry();
    this.attrs = {
      position: new BufferAttribute(this.positions, 3),
      color: new BufferAttribute(this.colors, 3),
      seg: new BufferAttribute(this.seg, 3),
      berm: new BufferAttribute(this.bermHeights, 1),
      tread: new BufferAttribute(this.tread, 2),
    };
    for (const [name, attr] of Object.entries(this.attrs)) geometry.setAttribute(name, attr);
    geometry.setIndex(new BufferAttribute(index, 1));
    // Newest sequence number + 1 per wheel (the number of segments laid so far).
    this.heads = uniformArray(new Array(wheels).fill(0), 'float');
    this.mesh = new Mesh(geometry, createMaterial(this.heads, segments, ruts, snow));
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    // Drawn right after the ground (it does not write depth, so the ground must already be there)
    // and before everything else: a tyre sunk in a rut, below the track's surface, then still draws
    // over the track instead of the track over the tyre. The ground is at renderOrder -1.
    this.mesh.renderOrder = -0.5;
    this.mesh.name = 'tyre tracks';
    scene.add(this.mesh);
    this.state = Array.from({ length: wheels }, () => ({ last: null, head: 0, count: 0, stripe: 0, total: 0 }));
    this.dirty = false;
    this.bermVersion = -1;
    this.tmp = new Color();
  }

  // Records a contact point for a wheel. `right` is the unit axle direction in the ground plane.
  // `maxGap`: a longer jump from the last point starts a new track (callers scale it with speed).
  add(wheel, heightAt, point, right, width, strength, maxGap = MAX_GAP) {
    const s = this.state[wheel];
    const half = width / 2;
    const y = heightAt(point.x, point.z);
    const ax = right.x;
    const az = right.z;
    const lx = point.x - ax * half;
    const lz = point.z - az * half;
    const rx = point.x + ax * half;
    const rz = point.z + az * half;
    const last = s.last;
    if (last) {
      const d = Math.hypot(point.x - last.x, point.z - last.z);
      if (d < SPACING) return;
      if (d >= maxGap) count('tracks.breakGap');
      if (d < maxGap) {
        const q = wheel * this.segments + s.head;
        terrainColorAt(heightAt, point.x, point.z, this.tmp);
        // Alternating shade reads as the tread pattern pressed into the soil.
        s.stripe = 1 - s.stripe;
        const dark = 0.42 * strength * (s.stripe ? 1 : 0.8);
        // Both ends keep their own axle direction, so neighbouring segments share their corners.
        this.writeSegment(q, wheel, s.total, dark, last.lx, last.lz, last.rx, last.rz, last.ax, last.az, last.y, lx, lz, rx, rz, ax, az, y);
        s.total++;
        s.head = (s.head + 1) % this.segments;
        s.count = Math.min(s.count + 1, this.segments);
        this.heads.array[wheel] = s.total;
        this.dirty = true;
      }
    }
    if (last) {
      // Reuse the object rather than allocating one per contact.
      last.x = point.x;
      last.z = point.z;
      last.y = y;
      last.ax = ax;
      last.az = az;
      last.lx = lx;
      last.lz = lz;
      last.rx = rx;
      last.rz = rz;
    } else s.last = { x: point.x, z: point.z, y, ax, az, lx, lz, rx, rz };
  }

  // Breaks the track (for example when the car is respawned).
  lift(wheel) {
    this.state[wheel].last = null;
  }

  berm(x, z) {
    return this.deformation ? Math.max(0, this.deformation.at(x, z)) : 0;
  }

  vertex(v, x, y, z, r, g, b, wheel, seq, dark) {
    const o = v * 3;
    const P = this.positions;
    const C = this.colors;
    const S = this.seg;
    P[o] = x;
    P[o + 1] = y;
    P[o + 2] = z;
    C[o] = r;
    C[o + 1] = g;
    C[o + 2] = b;
    S[o] = wheel;
    S[o + 1] = seq;
    S[o + 2] = dark;
    this.bermHeights[v] = 0;
    this.tread[v * 2] = 0;
    this.tread[v * 2 + 1] = -1;
  }

  writeSegment(q, wheel, seq, dark, l0x, l0z, r0x, r0z, a0x, a0z, y0, l1x, l1z, r1x, r1z, a1x, a1z, y1) {
    const v0 = q * VERTS;
    const t = this.tmp;
    const br = t.r;
    const bg = t.g;
    const bb = t.b;
    // Floor: compressed soil, darkened in the shader (the darkening fades with age).
    const fr = br;
    const fg = bg * 0.98;
    const fb = bb * 0.95;
    // Berms: loose soil, a touch lighter than the ground.
    const lr = br * 1.06;
    const lg = bg * 1.05;
    const lb = bb * 1.04;
    const h0 = y0 + LIFT;
    const h1 = y1 + LIFT;
    this.vertex(v0, l0x, h0, l0z, fr, fg, fb, wheel, seq, dark);
    this.vertex(v0 + 1, r0x, h0, r0z, fr, fg, fb, wheel, seq, dark);
    this.vertex(v0 + 2, l1x, h1, l1z, fr, fg, fb, wheel, seq, dark);
    this.vertex(v0 + 3, r1x, h1, r1z, fr, fg, fb, wheel, seq, dark);
    // The floor's tread coordinates: along (in segments) and across (left 0, right 1).
    this.tread.set([seq, 0, seq, 1, seq + 1, 0, seq + 1, 1], v0 * 2);
    const cr = this.crests;
    for (let n = 0; n < 2; n++) {
      const side = n === 0 ? -1 : 1;
      const e0x = n === 0 ? l0x : r0x;
      const e0z = n === 0 ? l0z : r0z;
      const e1x = n === 0 ? l1x : r1x;
      const e1z = n === 0 ? l1z : r1z;
      const c0x = e0x + a0x * side * CREST;
      const c0z = e0z + a0z * side * CREST;
      const c1x = e1x + a1x * side * CREST;
      const c1z = e1z + a1z * side * CREST;
      const f0x = e0x + a0x * side * FOOT;
      const f0z = e0z + a0z * side * FOOT;
      const f1x = e1x + a1x * side * FOOT;
      const f1z = e1z + a1z * side * FOOT;
      const co = q * 8 + n * 4;
      cr[co] = c0x;
      cr[co + 1] = c0z;
      cr[co + 2] = c1x;
      cr[co + 3] = c1z;
      // Inner slope (floor colour, darkened with the floor), then outer slope (loose soil).
      const k0 = v0 + (1 + 2 * n) * 4;
      const k1 = v0 + (2 + 2 * n) * 4;
      this.vertex(k0, e0x, h0, e0z, fr, fg, fb, wheel, seq, dark);
      this.vertex(k0 + 1, c0x, h0, c0z, fr, fg, fb, wheel, seq, dark);
      this.vertex(k0 + 2, e1x, h1, e1z, fr, fg, fb, wheel, seq, dark);
      this.vertex(k0 + 3, c1x, h1, c1z, fr, fg, fb, wheel, seq, dark);
      this.vertex(k1, c0x, h0, c0z, lr, lg, lb, wheel, seq, 0);
      this.vertex(k1 + 1, f0x, h0, f0z, lr, lg, lb, wheel, seq, 0);
      this.vertex(k1 + 2, c1x, h1, c1z, lr, lg, lb, wheel, seq, 0);
      this.vertex(k1 + 3, f1x, h1, f1z, lr, lg, lb, wheel, seq, 0);
    }
    const { position, color, seg, tread } = this.attrs;
    markRange(position, v0 * 3, VERTS * 3);
    markRange(color, v0 * 3, VERTS * 3);
    markRange(seg, v0 * 3, VERTS * 3);
    markRange(tread, v0 * 2, VERTS * 2);
  }

  // Berm heights of the newest segments follow the ground deformation until they settle.
  settle() {
    const B = this.bermHeights;
    const cr = this.crests;
    const attr = this.attrs.berm;
    for (let w = 0; w < this.wheels; w++) {
      const s = this.state[w];
      const n = Math.min(s.count, SETTLING);
      for (let i = 0; i < n; i++) {
        const q = w * this.segments + ((s.head - 1 - i + this.segments) % this.segments);
        const v0 = q * VERTS;
        for (let side = 0; side < 2; side++) {
          const co = q * 8 + side * 4;
          const b0 = this.berm(cr[co], cr[co + 1]);
          const b1 = this.berm(cr[co + 2], cr[co + 3]);
          const k0 = v0 + (1 + 2 * side) * 4;
          const k1 = v0 + (2 + 2 * side) * 4;
          B[k0 + 1] = b0;
          B[k1] = b0;
          B[k0 + 3] = b1;
          B[k1 + 2] = b1;
        }
      }
      if (n === 0) continue;
      // The settling window is contiguous in the ring, except where it wraps.
      const first = (s.head - n + this.segments) % this.segments;
      const base = w * this.segments;
      if (first + n <= this.segments) markRange(attr, (base + first) * VERTS, n * VERTS);
      else {
        markRange(attr, (base + first) * VERTS, (this.segments - first) * VERTS);
        markRange(attr, base * VERTS, (first + n - this.segments) * VERTS);
      }
    }
  }

  update() {
    const version = this.deformation ? this.deformation.version : 0;
    if (!this.dirty && version === this.bermVersion) return;
    this.dirty = false;
    this.bermVersion = version;
    this.settle();
  }

  clear() {
    for (const s of this.state) Object.assign(s, { last: null, head: 0, count: 0, total: 0 });
    this.heads.array.fill(0);
    this.positions.fill(0);
    this.colors.fill(0);
    this.seg.fill(0);
    this.bermHeights.fill(0);
    this.tread.fill(0);
    for (const attr of Object.values(this.attrs)) {
      attr.clearUpdateRanges();
      attr.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
