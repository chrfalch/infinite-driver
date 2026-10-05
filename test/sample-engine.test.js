import { describe, expect, it } from 'vitest';
import { SampleEngine, rpmGains } from '../src/audio/sample-engine.js';
import { mono } from '../src/audio/sample-bank.js';

const SR = 48000;
const BLOCK = 128;

// A loop of a V8 at `rpm`: its firing tone (rpm / 15 Hz) and two harmonics, a whole number of
// periods long so it wraps cleanly; or noise (uncorrelated with any other loop).
function loop(rpm, load, { amp = 0.3, noise = false, seed = 1 } = {}) {
  const f0 = rpm / 15;
  const period = Math.round(SR / f0);
  const data = new Float32Array(period * Math.round(f0 * 0.5));
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    if (noise) {
      s = (s * 1103515245 + 12345) >>> 0;
      data[i] = amp * ((s / 2 ** 32) * 2 - 1);
    } else {
      const ph = (2 * Math.PI * i) / period;
      data[i] = amp * (Math.sin(ph) + 0.5 * Math.sin(2 * ph + 1) + 0.25 * Math.sin(3 * ph + 2));
    }
  }
  return { rpm, load, data, sampleRate: SR, loopStart: 0, loopEnd: data.length };
}

function render(engine, seconds, from, to = from) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i += BLOCK) {
    const end = Math.min(out.length, i + BLOCK);
    const lerp = (k) => ({ rpm: from.rpm + (to.rpm - from.rpm) * (k / out.length), fuel: from.fuel + (to.fuel - from.fuel) * (k / out.length) });
    engine.render(out, lerp(i), lerp(end), i, end);
  }
  return out;
}

const rms = (x, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
};

function power(x, f) {
  const w = (2 * Math.PI * f) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / x.length;
}

const tonal = () => ({ name: 'test', loops: [loop(1200, 'on'), loop(2400, 'on'), loop(3600, 'on'), loop(1200, 'off', { amp: 0.1 }), loop(2400, 'off', { amp: 0.1 })] });

describe('recorded engine', () => {
  it('is silent without a bank', () => {
    const e = new SampleEngine(SR);
    expect(e.ready).toBe(false);
    expect(rms(render(e, 0.1, { rpm: 2000, fuel: 1 }))).toBe(0);
  });

  it('mixes the two loops either side of the rpm with equal power', () => {
    const set = [{ rpm: 1000 }, { rpm: 1500 }, { rpm: 2000 }];
    const g = rpmGains(set, Math.sqrt(1000 * 1500), new Float64Array(3));
    expect(g[0] ** 2 + g[1] ** 2).toBeCloseTo(1, 6);
    expect(g[0]).toBeCloseTo(g[1], 6);
    expect(g[2]).toBe(0);
    expect([...rpmGains(set, 500, new Float64Array(3))]).toEqual([1, 0, 0]);
    expect([...rpmGains(set, 9000, new Float64Array(3))]).toEqual([0, 0, 1]);
  });

  it('stretches no loop far across a wide gap between loops', () => {
    const set = [{ rpm: 800 }, { rpm: 2800 }];
    const g = new Float64Array(2);
    // Idle sped up 1.25× still plays alone; and the top loop slowed to 1 / 1.25.
    expect([...rpmGains(set, 1000, g)]).toEqual([1, 0]);
    rpmGains(set, 2240, g);
    expect(g[0]).toBeCloseTo(0, 9);
    expect(g[1]).toBeCloseTo(1, 9);
    rpmGains(set, Math.sqrt(800 * 2800), g);
    expect(g[0]).toBeCloseTo(g[1], 6);
  });

  it('sounds at the firing tone of the rpm, between and on the loops', () => {
    for (const rpm of [1200, 1500, 3000]) {
      const e = new SampleEngine(SR, tonal());
      const out = render(e, 0.5, { rpm, fuel: 1 }).subarray(SR * 0.1);
      const f0 = rpm / 15;
      expect(power(out, f0)).toBeGreaterThan(20 * power(out, f0 * 0.85));
      expect(power(out, f0)).toBeGreaterThan(20 * power(out, f0 * 1.15));
    }
  });

  it('plays the on-load set pulling and the off-load set coasting', () => {
    const on = rms(render(new SampleEngine(SR, tonal()), 0.5, { rpm: 1200, fuel: 1 }), SR * 0.2);
    const off = rms(render(new SampleEngine(SR, tonal()), 0.5, { rpm: 1200, fuel: 0 }), SR * 0.2);
    expect(on / off).toBeCloseTo(3, 1);
  });

  it('holds its level through the crossfades on a slow rev', () => {
    const bank = { loops: [1000, 1500, 2000, 2500, 3000].map((rpm, i) => loop(rpm, 'on', { noise: true, seed: i + 1 })) };
    const out = render(new SampleEngine(SR, bank), 4, { rpm: 1000, fuel: 1 }, { rpm: 3000, fuel: 1 });
    const win = SR * 0.1;
    const levels = [];
    for (let i = win; i + win <= out.length - win; i += win) levels.push(rms(out, i, i + win));
    const db = levels.map((l) => 20 * Math.log10(l / levels[0]));
    expect(Math.max(...db) - Math.min(...db)).toBeLessThan(2.5);
  });

  it('wraps its loops without a click', () => {
    const e = new SampleEngine(SR, { loops: [loop(1200, 'on')] });
    const out = render(e, 1.2, { rpm: 1200, fuel: 1 });
    let jump = 0;
    // From the second block (the first fades in).
    for (let i = BLOCK + 1; i < out.length; i++) jump = Math.max(jump, Math.abs(out[i] - out[i - 1]));
    // The steepest step of the tone itself: amp × 2π f0 / SR × (1 + 2 × 0.5 + 3 × 0.25).
    expect(jump).toBeLessThan(0.3 * ((2 * Math.PI * 80) / SR) * 2.75 * 1.05);
  });

  it('stays finite from standstill to past the top loop', () => {
    const out = render(new SampleEngine(SR, tonal()), 1, { rpm: 0, fuel: 0 }, { rpm: 7000, fuel: 1 });
    expect(out.every(Number.isFinite)).toBe(true);
  });

  it('mixes a decoded recording down to mono', () => {
    const l = new Float32Array([1, 0.5]);
    const r = new Float32Array([0, 0.5]);
    expect([...mono({ length: 2, numberOfChannels: 2, getChannelData: (c) => (c ? r : l) })]).toEqual([0.5, 0.5]);
  });
});
