import { describe, expect, it } from 'vitest';
import { AudioFeed, FeedReader, RECORDS, createFeedBuffer } from '../src/audio/feed.js';
import { EngineSynth } from '../src/audio/engine-synth.js';
import { DEFAULT_DRIVETRAIN, Drivetrain } from '../src/vehicle/drivetrain.js';

const SR = 48000;
const BLOCK = 128;

// Renders `seconds` of steady engine state; returns the samples and the synth.
function render(seconds, state, synth = new EngineSynth(SR)) {
  const out = new Float32Array(Math.round(seconds * SR));
  const s = { exhaustBrake: 0, throttle: 0, ...state };
  for (let i = 0; i < out.length; i += BLOCK) synth.render(out, s, s, i, Math.min(out.length, i + BLOCK));
  return { out, synth };
}

const rms = (x, from = 0) => {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length - from));
};

// Power at one frequency (Goertzel).
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

describe('audio feed', () => {
  it('keeps the newest records in its ring', () => {
    const feed = new AudioFeed(createFeedBuffer());
    const out = new Float64Array(8);
    for (let i = 0; i < RECORDS + 10; i++) feed.write([i, 1000 + i, 0, 0, 0, 0, 0, 0]);
    expect(feed.written()).toBe(RECORDS + 10);
    expect(feed.read(5, out)).toBe(false); // overwritten
    expect(feed.read(RECORDS + 9, out)).toBe(true);
    expect(out[1]).toBe(1000 + RECORDS + 9);
  });

  it('plays the steps a little behind the newest, interpolated', () => {
    const feed = new AudioFeed(createFeedBuffer());
    const reader = new FeedReader(feed, { latency: 0.05 });
    // 0.5 s of steps with rpm rising 1000 per second.
    for (let k = 1; k <= 60; k++) feed.write([k / 120, 1000 + (k / 120) * 1000, 0, 0, 0, 0, 0, 1]);
    const v = reader.advance(128 / SR);
    // The first read jumps to newest - latency: t = 0.45 s.
    expect(v.rpm).toBeCloseTo(1450, 0);
    expect(v.gear).toBe(1);
    // Between steps the value is interpolated.
    const v2 = reader.advance(0.004);
    expect(v2.rpm).toBeGreaterThan(1450);
    expect(v2.rpm).toBeLessThan(1460);
  });

  it('holds the distance to the newest step as physics arrives in batches', () => {
    const feed = new AudioFeed(createFeedBuffer());
    const reader = new FeedReader(feed, { latency: 0.05 });
    let simTime = 0;
    const gaps = [];
    // 3 s: physics comes in bursts of 4 steps every 33 ms, audio in 128-sample blocks.
    for (let t = 0; t < 3; t += 128 / SR) {
      while (simTime < t - ((t * 1000) % 33) / 1000 + 0.001) {
        simTime += 1 / 120;
        feed.write([simTime, 1000, 0, 0, 0, 0, 0, 0]);
      }
      reader.advance(128 / SR);
      if (t > 1) gaps.push(simTime - reader.playhead);
    }
    for (const g of gaps) {
      expect(g).toBeGreaterThan(0.005);
      expect(g).toBeLessThan(0.1);
    }
  });

  it('waits at the newest step when physics stops', () => {
    const feed = new AudioFeed(createFeedBuffer());
    const reader = new FeedReader(feed);
    for (let k = 1; k <= 12; k++) feed.write([k / 120, 800 + k, 0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 100; i++) reader.advance(0.01);
    expect(reader.playhead).toBeCloseTo(12 / 120, 6);
    expect(reader.values.rpm).toBe(812);
  });
});

describe('engine synth', () => {
  it('fires each cylinder once per two crank turns', () => {
    const { synth } = render(2, { rpm: 1500, fuel: 0.5 });
    // 1500 rpm, four cylinders: 50 firings per second.
    expect(Math.abs(synth.firings - 100)).toBeLessThanOrEqual(1);
  });

  it('sounds at the firing frequency and its harmonics', () => {
    const { out } = render(2, { rpm: 1500, fuel: 0.6 });
    const x = out.subarray(SR / 2);
    // Firing harmonics (50, 100, 150 Hz) stand well above the frequencies between them.
    const firing = power(x, 50) + power(x, 100) + power(x, 150);
    const between = power(x, 75) + power(x, 125) + power(x, 175);
    expect(firing).toBeGreaterThan(between * 5);
  });

  it('stays finite and inside full scale at every load', () => {
    for (const state of [{ rpm: 850, fuel: 0.13 }, { rpm: 5400, fuel: 1 }, { rpm: 3000, fuel: 0, exhaustBrake: 1 }, { rpm: 200, fuel: 0 }]) {
      const { out } = render(1, state);
      for (const s of out) {
        expect(Number.isFinite(s)).toBe(true);
        expect(Math.abs(s)).toBeLessThanOrEqual(1);
      }
      expect(rms(out, SR / 4)).toBeGreaterThan(0.005);
    }
  });

  it('is louder under load than coasting at the same rpm', () => {
    const load = rms(render(1, { rpm: 2500, fuel: 1 }).out, SR / 2);
    const coast = rms(render(1, { rpm: 2500, fuel: 0 }).out, SR / 2);
    expect(load).toBeGreaterThan(coast * 1.8);
  });

  it('spools the turbo up under load and down again after', () => {
    const synth = new EngineSynth(SR);
    render(0.3, { rpm: 3500, fuel: 1 }, synth);
    const early = synth.spool;
    render(3, { rpm: 3500, fuel: 1 }, synth);
    const full = synth.spool;
    render(3, { rpm: 900, fuel: 0.1 }, synth);
    expect(early).toBeLessThan(full * 0.6);
    expect(full).toBeGreaterThan(0.7);
    expect(synth.spool).toBeLessThan(0.2);
    expect(render(0.5, { rpm: 850, fuel: 0.13 }).synth.spool).toBeLessThan(0.05);
  });

  it('flutters when the throttle lifts at boost', () => {
    const synth = new EngineSynth(SR);
    render(3, { rpm: 3500, fuel: 1, throttle: 1 }, synth);
    render(0.01, { rpm: 3400, fuel: 0, throttle: 0 }, synth);
    expect(synth.flutter).toBeGreaterThan(0);
  });

  it('takes a new preset while playing', () => {
    const synth = new EngineSynth(SR);
    render(0.2, { rpm: 1500, fuel: 0.5 }, synth);
    const quiet = { ...synth.preset, gain: 0.1, pipe: { ...synth.preset.pipe, length: 1 }, muffler: synth.preset.muffler.slice(0, 1) };
    synth.setPreset(quiet);
    expect(synth.muffler.length).toBe(1);
    expect(synth.delayLength).toBe(Math.round((SR * 2) / quiet.pipe.speedOfSound));
    const out = render(0.5, { rpm: 1500, fuel: 0.5 }, synth).out;
    const loud = render(0.5, { rpm: 1500, fuel: 0.5 }).out;
    expect(rms(out, SR / 4)).toBeLessThan(rms(loud, SR / 4) * 0.3);
  });

  it('renders the same with the same seed', () => {
    const a = render(0.2, { rpm: 2000, fuel: 0.5 }, new EngineSynth(SR, undefined, { seed: 7 })).out;
    const b = render(0.2, { rpm: 2000, fuel: 0.5 }, new EngineSynth(SR, undefined, { seed: 7 })).out;
    expect(a).toEqual(b);
  });
});

describe('drivetrain outputs for the sound', () => {
  it('reports fuel under throttle and the exhaust brake when coasting', () => {
    const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN });
    const R = 0.46;
    let v = 0;
    for (let t = 0; t < 4; t += 1 / 120) {
      const torques = d.update(1 / 120, { throttle: 1, reverseRequest: false }, [v / R, v / R, v / R, v / R], v, R);
      v += ((torques.reduce((a, b) => a + b, 0) / R) / 2000) / 120;
    }
    expect(d.fuel).toBeGreaterThan(0.8);
    expect(d.exhaustBrake).toBe(0);
    for (let t = 0; t < 0.5; t += 1 / 120) d.update(1 / 120, { throttle: 0, reverseRequest: false }, [v / R, v / R, v / R, v / R], v, R);
    expect(d.fuel).toBe(0);
    expect(d.exhaustBrake).toBeGreaterThan(0.5);
  });

  it('reports the idle governor as a little fuel', () => {
    const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN });
    for (let t = 0; t < 2; t += 1 / 120) d.update(1 / 120, { throttle: 0, reverseRequest: false }, [0, 0, 0, 0], 0, 0.46);
    expect(d.fuel).toBeGreaterThan(0.05);
    expect(d.fuel).toBeLessThan(0.3);
  });
});
