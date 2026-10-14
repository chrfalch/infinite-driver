import { describe, expect, it } from 'vitest';
import { createHeightField } from '../src/terrain/height.js';
import { BED_HALF_WIDTH, ROCK_REACH } from '../src/terrain/riverbed.js';
import { CHEVRON_RADIUS, GAP_WIDTH, MARK_SPACING, generateTrackMarkers } from '../src/terrain/track-markers.js';

const river = createHeightField({ mode: 'river' });
const marks = [];
for (let cx = -6; cx < 10; cx++) for (let cz = -6; cz < 6; cz++) marks.push(...generateTrackMarkers(river, cx, cz));
const of = (kind) => marks.filter((m) => m.kind === kind);

describe('dry river course markers', () => {
  it('sets out flags, chevrons, tyre stacks and one start gantry', () => {
    expect(of('flag').length).toBeGreaterThan(100);
    expect(of('chevron').length).toBeGreaterThan(3);
    expect(of('tyres').length).toBeGreaterThan(10);
    expect(of('gantry')).toHaveLength(1);
  });

  it('only in the dry river', () => {
    for (const mode of ['canyon', 'snow', 'flat']) expect(generateTrackMarkers(createHeightField({ mode }), 0, 0)).toEqual([]);
  });

  it('comes out the same every time, one chunk at a time', () => {
    expect(generateTrackMarkers(createHeightField({ mode: 'river' }), 1, 0)).toEqual(generateTrackMarkers(river, 1, 0));
  });

  it('stands them on the wall tops, out of the bed and short of the trees', () => {
    for (const m of [...of('flag'), ...of('chevron'), ...of('tyres')]) {
      const dist = river.bankDistance(m.x, m.z);
      expect(dist).toBeGreaterThan(BED_HALF_WIDTH + 1.5);
      expect(dist).toBeLessThan(ROCK_REACH + 1.5);
      expect(Math.abs(m.y - river(m.x, m.z))).toBeLessThan(1e-9);
    }
  });

  it('puts flags on alternate banks, MARK_SPACING m apart along the bed', () => {
    const near = of('flag').filter((m) => Math.hypot(m.x, m.z) < 120);
    for (const side of [-1, 1]) expect(near.some((m) => m.side === side)).toBe(true);
    // Neighbouring flags are about 2 x MARK_SPACING apart on one bank (a little more or less on a bend).
    const left = of('flag').filter((m) => m.side === 1 && Math.abs(m.z) < 40 && m.x > -60 && m.x < 60).sort((a, b) => a.x - b.x);
    for (let i = 1; i < left.length; i++) {
      const gap = Math.hypot(left[i].x - left[i - 1].x, left[i].z - left[i - 1].z);
      if (gap < 4 * MARK_SPACING) expect(gap).toBeGreaterThan(MARK_SPACING);
    }
  });

  it('marks gaps with tyres and bends with chevrons on their outside, arrows into the bend', () => {
    for (const m of of('tyres')) expect(river.bedWidth(m.x, m.z)).toBeLessThan(GAP_WIDTH + 0.3);
    expect(new Set(of('chevron').map((m) => m.flip))).toEqual(new Set([true, false]));
    for (const m of of('chevron')) {
      // Into the bend: from the board, along its arrows (its +x, or -x flipped), the bed bends
      // toward the board's arrows: the centre of the bend lies that way, past the bed's centre.
      const dir = m.flip ? -1 : 1;
      const ax = dir * Math.cos(m.yaw);
      const az = dir * -Math.sin(m.yaw);
      // The bed is that way (the board is on its bank, the arrows point across it).
      const ahead = river.bankDistance(m.x + ax * 6, m.z + az * 6);
      expect(ahead).toBeLessThan(river.bankDistance(m.x, m.z));
      // And the ground a bend's radius that way is closer to the bed than as far the other way
      // (inside a bend the bed wraps round; outside it falls away).
      const r = CHEVRON_RADIUS * 0.8;
      expect(river.roadDistance(m.x + ax * r, m.z + az * r)).toBeLessThan(river.roadDistance(m.x - ax * r, m.z - az * r));
    }
  });

  it('spans the start gantry over the bed ahead of the start, high over its floor', () => {
    const [g] = of('gantry');
    // Ahead: along the bed's heading at the start.
    const h = river.roadHeading(0, 0);
    expect(g.x * Math.cos(h) - g.z * Math.sin(h)).toBeGreaterThan(8);
    expect(river.roadDistance(g.x, g.z)).toBeLessThan(0.5);
    expect(g.top - river(g.x, g.z)).toBeGreaterThan(4);
    expect(g.half).toBeGreaterThan(river.bedWidth(g.x, g.z) + 1);
  });
});
