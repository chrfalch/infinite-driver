import { describe, expect, it } from 'vitest';
import { createHeightField } from '../src/terrain/height.js';
import { BARRIER, LANE_HALF, WATER_LEVEL } from '../src/terrain/stadium.js';
import { generateRocks } from '../src/terrain/rocks.js';
import { generatePlants } from '../src/terrain/vegetation.js';

const stadium = createHeightField({ mode: 'stadium' });
const { segments, length } = stadium.track;

// Points along the centre line, every `step` m, with the way round there.
function centreLine(step = 0.5) {
  const out = [];
  for (const seg of segments) {
    for (let a = 0; a < seg.length; a += step) {
      if (seg.kind === 'line') out.push({ x: seg.x0 + seg.tx * a, z: seg.z0 + seg.tz * a, tx: seg.tx, tz: seg.tz });
      else {
        const sign = Math.sign(seg.sweep);
        const ang = seg.a0 + (a / seg.r) * sign;
        out.push({ x: seg.cx + Math.cos(ang) * seg.r, z: seg.cz + Math.sin(ang) * seg.r, tx: -Math.sin(ang) * sign, tz: Math.cos(ang) * sign });
      }
    }
  }
  return out;
}

const segEnd = (seg) => {
  if (seg.kind === 'line') return { x: seg.x0 + seg.tx * seg.length, z: seg.z0 + seg.tz * seg.length };
  const ang = seg.a0 + seg.sweep;
  return { x: seg.cx + Math.cos(ang) * seg.r, z: seg.cz + Math.sin(ang) * seg.r };
};
const segStart = (seg) => (seg.kind === 'line' ? { x: seg.x0, z: seg.z0 } : { x: seg.cx + Math.cos(seg.a0) * seg.r, z: seg.cz + Math.sin(seg.a0) * seg.r });

describe('stadium', () => {
  it('starts at the origin on the level start straight, facing +x', () => {
    expect(stadium.world).toBe('stadium');
    expect(stadium.roadDistance(0, 0)).toBeLessThan(1e-6);
    expect(stadium.roadHeading(0, 0)).toBeCloseTo(0, 6);
    expect(stadium.sample(0, 0).s).toBeCloseTo(0, 6);
    for (const [x, z] of [[-3, 0], [3, 0], [0, -3], [0, 3]]) expect(stadium(x, z)).toBeCloseTo(0, 2);
  });

  it('is one closed loop of 250-800 m, its pieces joined end to end', () => {
    expect(length).toBeGreaterThan(250);
    expect(length).toBeLessThan(800);
    segments.forEach((seg, i) => {
      const next = segments[(i + 1) % segments.length];
      const a = segEnd(seg);
      const b = segStart(next);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-6);
      expect(Math.abs(((seg.s0 + seg.length) % length) - next.s0) % length).toBeLessThan(1e-6);
    });
  });

  it('knows where it is along the loop and which way round it goes', () => {
    let prev = null;
    let total = 0;
    for (const p of centreLine(1)) {
      const s = stadium.sample(p.x, p.z);
      expect(Math.abs(s.d)).toBeLessThan(1e-6);
      const h = stadium.roadHeading(p.x, p.z);
      expect(Math.cos(h) * p.tx - Math.sin(h) * p.tz).toBeGreaterThan(0.999);
      if (prev !== null) {
        const ds = (s.s - prev + length) % length;
        // (Two points may fall together where one piece ends and the next begins.)
        expect(ds).toBeLessThan(1.01);
        total += ds;
      }
      prev = s.s;
    }
    expect(total).toBeGreaterThan(length - 2);
  });

  it('has jumps a truck can take: ramps no steeper than about 30 degrees, lips no higher than 2 m', () => {
    let top = 0;
    const kinds = new Set();
    const line = centreLine(0.25);
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const grade = Math.abs(stadium(b.x, b.z) - stadium(a.x, a.z)) / Math.hypot(b.x - a.x, b.z - a.z);
      expect(grade).toBeLessThan(Math.tan((31 * Math.PI) / 180));
      top = Math.max(top, stadium(b.x, b.z));
      const f = stadium.sample(b.x, b.z).feature;
      if (f) kinds.add(f);
    }
    expect(top).toBeGreaterThan(1);
    expect(top).toBeLessThanOrEqual(2);
    expect([...kinds].sort()).toEqual(['bump', 'puddle', 'ridge', 'washboard', 'whoops']);
  });

  it('lies level from side to side on the straights (but for the humps), banked a little on the outside of the corners', () => {
    for (const p of centreLine(2)) {
      const s = stadium.sample(p.x, p.z);
      const side = (off) => stadium(p.x + p.tz * off, p.z - p.tx * off);
      const tilt = Math.abs(side(3) - side(-3)) / 6;
      // (The humps stand on one side of the lane.)
      if (s.feature === 'bump') continue;
      // (The ridge leans across the lanes a little.)
      expect(tilt).toBeLessThan(s.feature === 'ridge' ? 0.1 : s.feature && !s.corner ? 0.01 : 0.07);
    }
  });

  it('shows water only in the water holes', () => {
    for (let x = stadium.arena.x0; x <= stadium.arena.x1; x += 1.5) {
      for (let z = stadium.arena.z0; z <= stadium.arena.z1; z += 1.5) {
        const s = stadium.sample(x, z);
        if (s.h < WATER_LEVEL + 0.25) {
          expect(s.feature).toBe('puddle');
          expect(s.dist).toBeLessThan(LANE_HALF + 0.6);
        }
      }
    }
  });

  it('walls every lane in with rails along both sides, clear of the other lanes', () => {
    const rails = stadium.barriers.filter((b) => b.kind === 'rail');
    expect(rails.length).toBeGreaterThan(200);
    for (const b of rails) {
      expect(stadium.roadDistance(b.x, b.z)).toBeCloseTo(BARRIER.offset, 1);
      expect(b.length).toBeGreaterThan(1.2);
      expect(b.length).toBeLessThan(3);
    }
    // Driving down the middle of the lane never meets one.
    for (const p of centreLine(1)) {
      let nearest = Infinity;
      for (const b of rails) nearest = Math.min(nearest, Math.hypot(b.x - p.x, b.z - p.z));
      expect(nearest).toBeGreaterThan(BARRIER.offset - BARRIER.thick - 0.2);
    }
  });

  it('gives the tyres the rails beside the car, within the solver\'s 48 rocks wherever it drives', () => {
    const rails = stadium.barrierRocks;
    let most = 0;
    for (const p of centreLine(1)) {
      const near = rails.filter((r) => r.distanceTo(p.x, p.z) < 14);
      most = Math.max(most, near.length);
      // Both rails of the lane are among them.
      expect(near.filter((r) => r.distanceTo(p.x, p.z) < BARRIER.offset + 0.5).length).toBeGreaterThanOrEqual(2);
    }
    expect(most).toBeLessThanOrEqual(48);
    // A box's corners are where its collider is.
    const b = stadium.barrierBoxes[0];
    const r = stadium.barrierRocks[0];
    expect(r.distanceTo(b.x, b.z)).toBe(0);
    expect(r.distanceTo(b.x + Math.cos(b.yaw) * (b.length / 2 + 1), b.z - Math.sin(b.yaw) * (b.length / 2 + 1))).toBeCloseTo(1, 6);
  });

  it('rings the arena with a wall outside every lane', () => {
    const { x0, x1, z0, z1 } = stadium.arena;
    for (const p of centreLine(5)) {
      expect(Math.min(p.x - x0, x1 - p.x, p.z - z0, z1 - p.z)).toBeGreaterThan(BARRIER.offset + 3);
    }
    expect(stadium.barriers.some((b) => b.kind === 'wall')).toBe(true);
  });

  it('has no rocks or plants', () => {
    expect(generateRocks(stadium, 0, 0)).toEqual([]);
    expect(generatePlants(stadium, -1, -1)).toEqual([]);
  });
});
