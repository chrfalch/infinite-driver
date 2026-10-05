import { describe, expect, it } from 'vitest';
import { Foley } from '../src/audio/foley.js';
import { GroundSynth } from '../src/audio/ground-synth.js';
import { WHEEL_FIELDS, WHEELS, surfaceAt } from '../src/audio/wheels.js';

const SR = 48000;
const BLOCK = 128;

const noise = (seconds, amp = 0.3, seed = 1) => {
  let s = seed;
  return Float32Array.from({ length: Math.round(seconds * SR) }, () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return amp * ((s / 2 ** 32) * 2 - 1);
  });
};
const take = (data, strength = 1) => ({ data, sampleRate: SR, gain: 1, strength });
// A hit: a decaying burst, louder for the stronger take.
const thud = (strength) => Float32Array.from({ length: 2400 }, (_, i) => strength * 0.5 * Math.exp(-i / 300) * Math.sin(i * 0.05));

const bank = () => ({
  loops: { 'roll-gravel': [take(noise(1, 0.3, 1))], 'roll-dirt': [take(noise(1, 0.3, 2))], scrape: [take(noise(1, 0.3, 3))] },
  oneshots: { bump: [take(thud(0.3), 0.3), take(thud(0.6), 0.6), take(thud(1), 1)], landing: [take(thud(1), 1)] },
});

// Feed values for all wheels rolling at `speed` on `surface` weights.
function state(speed, surface = {}, extra = {}) {
  const v = { speed, chassisForce: 0, chassisHits: 0, heave: 0, twist: 0, clunks: 0 };
  for (let i = 0; i < WHEELS; i++) {
    for (const f of WHEEL_FIELDS) v[`w${i}${f}`] = 0;
    Object.assign(v, { [`w${i}contact`]: 1, [`w${i}ground`]: speed, [`w${i}roll`]: speed, [`w${i}load`]: 1 });
    for (const [k, x] of Object.entries(surface)) v[`w${i}${k}`] = x;
  }
  return Object.assign(v, extra);
}

function render(foley, seconds, at) {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let prev = at(0);
  for (let i = 0; i < n; i += BLOCK) {
    const end = Math.min(n, i + BLOCK);
    const next = at(end / SR);
    foley.render(l, r, prev, next, i, end);
    prev = next;
  }
  return l;
}

const rms = (x, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

describe('recorded ground and car sounds', () => {
  it('is silent without a bank, and standing still', () => {
    expect(rms(render(new Foley(SR), 0.2, () => state(10, { gravel: 1 })))).toBe(0);
    expect(rms(render(new Foley(SR, bank()), 0.2, () => state(0, { gravel: 1 })))).toBe(0);
  });

  it('rolls louder the faster, on the ground it is on', () => {
    const slow = rms(render(new Foley(SR, bank()), 0.5, () => state(3, { gravel: 1 })), SR * 0.1);
    const fast = rms(render(new Foley(SR, bank()), 0.5, () => state(15, { gravel: 1 })), SR * 0.1);
    expect(fast).toBeGreaterThan(slow * 1.5);
    const f = new Foley(SR, bank());
    render(f, 0.2, () => state(10, { gravel: 1 }));
    expect(f.loops['roll-gravel'].gain).toBeGreaterThan(0);
    expect(f.loops['roll-dirt'].gain).toBe(0);
  });

  it('rolls on sand as dirt when there is no sand recording', () => {
    const f = new Foley(SR, bank());
    render(f, 0.2, () => state(10, { sand: 1 }));
    expect(f.loops['roll-dirt'].gain).toBeGreaterThan(0);
  });

  it('plays a bump stop once per hit, louder and from a stronger take the harder', () => {
    const play = (strength) => {
      const f = new Foley(SR, bank(), { seed: 3 });
      const out = render(f, 0.3, (t) => state(0, {}, { w0bump: t > 0.1 ? strength : 0 }));
      return { f, level: rms(out) };
    };
    const soft = play(0.5);
    const hard = play(3);
    expect(hard.level).toBeGreaterThan(soft.level * 2);
    expect(hard.f.last.bump.strength).toBe(1);
    expect(soft.f.last.bump.strength).toBeLessThan(1);
    expect(rms(render(new Foley(SR, bank()), 0.3, () => state(0)))).toBe(0);
  });

  it('never plays the same take twice running', () => {
    const f = new Foley(SR, bank(), { seed: 9 });
    const seen = [];
    for (let k = 0; k < 6; k++) {
      f.hit('bump', 1.5, { l: 1, r: 1 }, 'ground');
      seen.push(f.last.bump);
    }
    for (let k = 1; k < seen.length; k++) expect(seen[k]).not.toBe(seen[k - 1]);
  });

  it('lands when two wheels hit their bump stops together', () => {
    const f = new Foley(SR, bank());
    render(f, 0.2, (t) => state(0, {}, t > 0.1 ? { w0bump: 2, w1bump: 2 } : {}));
    expect(f.last.landing).toBeDefined();
    const g = new Foley(SR, bank());
    render(g, 0.2, (t) => state(0, {}, t > 0.1 ? { w0bump: 2 } : {}));
    expect(g.last.landing).toBeUndefined();
  });

  it('keeps at most 24 hits playing', () => {
    const f = new Foley(SR, bank());
    for (let k = 0; k < 40; k++) f.hit('bump', 1 + k / 20, { l: 1, r: 1 }, 'ground');
    expect(f.voices.length).toBe(24);
  });

  it('scrapes while the chassis drags, moving', () => {
    const still = rms(render(new Foley(SR, bank()), 0.3, () => state(0, {}, { chassisForce: 1 })));
    const moving = rms(render(new Foley(SR, bank()), 0.3, () => ({ ...state(0, {}, { chassisForce: 1 }), speed: 3 })), SR * 0.1);
    expect(still).toBe(0);
    expect(moving).toBeGreaterThan(0.01);
  });

  it('mutes in the synths the parts it plays', () => {
    const covers = new Foley(SR, bank()).covers();
    expect(covers.ground).toEqual(expect.arrayContaining(['gravel', 'soil', 'scrape', 'bumpStop']));
    expect(covers.ground).not.toContain('rock');
    // The gravel's crunch goes; the tread's hum (not recorded) stays.
    const level = (muted) => {
      const synth = new GroundSynth(SR);
      synth.muted = new Set(muted);
      const l = new Float32Array(SR * 0.3);
      const r = new Float32Array(SR * 0.3);
      const s = state(10, { gravel: 1 });
      for (let i = 0; i < l.length; i += BLOCK) synth.render(l, r, s, s, i, Math.min(l.length, i + BLOCK));
      return rms(l);
    };
    expect(level(covers.ground)).toBeLessThan(0.3 * level([]));
    expect(level([...covers.ground, 'hum'])).toBeLessThan(1e-4);
  });

  it('reads sand and snow from the worlds', () => {
    expect(surfaceAt({ snowAt: () => 1 }, 0, 0)).toMatchObject({ snow: 1, rock: 0, gravel: 0 });
    expect(surfaceAt({ rockAt: () => false }, 0, 0)).toMatchObject({ sand: 0.5, gravel: 0.5, rock: 0 });
  });
});
