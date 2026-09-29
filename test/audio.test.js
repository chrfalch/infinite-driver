import { describe, expect, it } from 'vitest';
import { AudioFeed, FeedReader, RECORDS, createFeedBuffer } from '../src/audio/feed.js';
import { EngineSynth, LAYERS } from '../src/audio/engine-synth.js';
import { TURBO_DIESEL_I4, TURBO_DIESEL_V8 } from '../src/audio/engine-presets.js';
import { GroundSynth } from '../src/audio/ground-synth.js';
import { panGains, softKnee } from '../src/audio/mix.js';
import { CarSynth } from '../src/audio/car-synth.js';
import { surfaceAt, writeWheels, WHEEL_FIELDS } from '../src/audio/wheels.js';
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

  it('plays one layer alone, or none', () => {
    const silent = new EngineSynth(SR);
    silent.setLayers(Object.fromEntries(Object.keys(LAYERS).map((k) => [k, 0])));
    expect(rms(render(0.5, { rpm: 2000, fuel: 0.6 }, silent).out, SR / 4)).toBeLessThan(1e-4);
    // The clatter is tuned out in the preset (layers.clatter = 0), so it is turned back on here.
    const preset = { ...TURBO_DIESEL_I4, layers: { ...TURBO_DIESEL_I4.layers, clatter: 1 } };
    for (const layer of ['pulses', 'echo', 'silencer1', 'block', 'clatter']) {
      const solo = new EngineSynth(SR, preset);
      solo.setLayers(Object.fromEntries(Object.keys(LAYERS).map((k) => [k, k === layer ? 1 : 0])));
      expect(rms(render(0.5, { rpm: 2000, fuel: 0.6 }, solo).out, SR / 4), layer).toBeGreaterThan(1e-3);
    }
  });

  it('takes the layer levels from the preset', () => {
    const muted = new EngineSynth(SR, { ...TURBO_DIESEL_I4, layers: Object.fromEntries(Object.keys(LAYERS).map((k) => [k, 0])) });
    expect(rms(render(0.5, { rpm: 2000, fuel: 0.6 }, muted).out, SR / 4)).toBeLessThan(1e-4);
  });

  it('lets the boost off through the wastegate when the throttle lifts', () => {
    const synth = new EngineSynth(SR);
    render(3, { rpm: 3500, fuel: 1, throttle: 1 }, synth);
    render(0.01, { rpm: 3400, fuel: 0, throttle: 0 }, synth);
    expect(synth.wastegate).toBeGreaterThan(0.3);
    render(1.5, { rpm: 2500, fuel: 0, throttle: 0 }, synth);
    expect(synth.wastegate).toBeLessThanOrEqual(0);
  });

  it('recovers from a NaN instead of staying silent', () => {
    const synth = new EngineSynth(SR);
    render(0.1, { rpm: 1500, fuel: 0.5 }, synth);
    synth.tone.ic1 = NaN;
    const { out } = render(0.5, { rpm: 1500, fuel: 0.5 }, synth);
    expect(synth.recoveries).toBeGreaterThan(0);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(rms(out, SR / 4)).toBeGreaterThan(0.01);
  });

  it('renders the same with the same seed', () => {
    const a = render(0.2, { rpm: 2000, fuel: 0.5 }, new EngineSynth(SR, undefined, { seed: 7 })).out;
    const b = render(0.2, { rpm: 2000, fuel: 0.5 }, new EngineSynth(SR, undefined, { seed: 7 })).out;
    expect(a).toEqual(b);
  });
});

describe('V8', () => {
  it('fires each bank unevenly: 270-180-90-180°', () => {
    const p = TURBO_DIESEL_V8;
    for (const bank of [0, 1]) {
      const times = p.firing.filter((_, c) => p.banks[c] === bank).sort((a, b) => a - b);
      const gaps = times.map((t, i) => Math.round(((times[(i + 1) % 4] - t + 1) % 1) * 720));
      expect([...gaps].sort()).toEqual([180, 180, 270, 90].sort());
    }
    // The engine as a whole fires every 90°.
    expect([...p.firing].sort((a, b) => a - b).map((t) => t * 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('fires eight times per two crank turns', () => {
    const { synth } = render(2, { rpm: 1500, fuel: 0.5 }, new EngineSynth(SR, TURBO_DIESEL_V8));
    expect(Math.abs(synth.firings - 200)).toBeLessThanOrEqual(2);
  });

  it('burbles: strong low orders (per cycle) against the firing tone, unlike the four', () => {
    const burble = (preset) => {
      const x = render(3, { rpm: 2200, fuel: 1, throttle: 1 }, new EngineSynth(SR, preset)).out.subarray(SR);
      const f0 = 2200 / 120;
      return (power(x, 2 * f0) + power(x, 3 * f0)) / power(x, preset.cylinders * f0);
    };
    expect(burble(TURBO_DIESEL_V8)).toBeGreaterThan(burble(TURBO_DIESEL_I4) * 30);
    // With equal banks it mostly cancels.
    const equal = { ...TURBO_DIESEL_V8, bankGain: [1, 1], bankPipeLengths: [3.4, 3.4], headers: TURBO_DIESEL_V8.headers.map(() => 0.5), collide: 0 };
    expect(burble(TURBO_DIESEL_V8)).toBeGreaterThan(burble(equal) * 3);
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


describe('tyres and ground', () => {
  const wheels = (o) => {
    const v = {};
    for (let i = 0; i < 4; i++) for (const [k, x] of Object.entries({ contact: 1, ground: 0, roll: 0, slipLong: 0, slipLat: 0, load: 1, rock: 0, gravel: 0, ...o })) v[`w${i}${k}`] = x;
    return v;
  };
  const play = (state, synth = new GroundSynth(SR), seconds = 1) => {
    const out = new Float32Array(SR * seconds);
    const right = new Float32Array(SR * seconds);
    for (let i = 0; i < out.length; i += BLOCK) synth.render(out, right, state, state, i, i + BLOCK);
    return rms(out, SR / 4);
  };

  it('is silent standing still, and in the air', () => {
    expect(play(wheels({}))).toBeLessThan(1e-4);
    expect(play(wheels({ contact: 0, ground: 15, roll: 15, gravel: 1 }))).toBeLessThan(1e-4);
  });

  it('crunches louder on gravel the faster it rolls', () => {
    const slow = play(wheels({ ground: 3, roll: 3, gravel: 1 }));
    const fast = play(wheels({ ground: 12, roll: 12, gravel: 1 }));
    expect(slow).toBeGreaterThan(0.005);
    expect(fast).toBeGreaterThan(slow * 1.5);
  });

  it('squeals sliding on rock, not on soil', () => {
    const rolling = play(wheels({ ground: 8, roll: 8, rock: 1 }));
    const sliding = play(wheels({ ground: 8, roll: 8, slipLat: 3, rock: 1 }));
    expect(sliding).toBeGreaterThan(rolling * 2);
    const soilSliding = new GroundSynth(SR);
    soilSliding.setLayers({ gravel: 0, soil: 0, rock: 0, hum: 0, scrub: 0, spin: 0 }); // squeal alone
    expect(play(wheels({ ground: 8, roll: 8, slipLat: 3 }), soilSliding)).toBeLessThan(1e-4);
  });

  it('stays inside full scale added to a loud engine', () => {
    const synth = new GroundSynth(SR);
    const out = new Float32Array(SR).fill(0.8);
    const right = new Float32Array(SR).fill(0.8);
    const s = wheels({ ground: 20, roll: 26, slipLong: 6, slipLat: 4, gravel: 1, load: 2 });
    for (let i = 0; i < out.length; i += BLOCK) synth.render(out, right, s, s, i, i + BLOCK);
    // The worklet's soft knee on the sum.
    for (const x of out) expect(Math.abs(softKnee(x))).toBeLessThanOrEqual(1);
    expect(softKnee(0.5)).toBe(0.5);
  });

  it('ticks when a thrown stone hits the car, clicks when one lands on rock', () => {
    for (const e of [{ kind: 'throw', size: 0.06, speed: 6 }, { kind: 'land', size: 0.05, rock: 1 }]) {
      const synth = new GroundSynth(SR, { ...new GroundSynth(SR).preset, stones: { ...new GroundSynth(SR).preset.stones, hitChance: 1 } });
      synth.event(e);
      const out = new Float32Array(SR / 4);
      const right = new Float32Array(SR / 4);
      for (let i = 0; i < out.length; i += BLOCK) synth.render(out, right, wheels({ contact: 0 }), wheels({ contact: 0 }), i, i + BLOCK);
      expect(Math.max(...out.map(Math.abs)), e.kind).toBeGreaterThan(0.02);
    }
  });

  it('reads the wheels: speed, slip and ground', () => {
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const controller = {
      wheels: [0, 1, 2, 3].map(() => ({ hub: { linvel: () => ({ x: 10, y: 0, z: 1 }), rotation: () => identity, translation: () => ({ x: 0, y: 0, z: 0 }) }, tyreLoad: 4400 })),
      rollingRadius: () => 0.4,
      wheelSpin: () => 30, // 12 m/s at the tread
    };
    const out = new Float64Array(4 * WHEEL_FIELDS.length);
    const surfaces = [0, 1, 2, 3].map(() => ({ rock: 0, gravel: 0 }));
    writeWheels({ controller }, out, 0, { rockAt: () => true }, surfaces, true);
    const [contact, ground, roll, slipLong, slipLat, load, rock] = out;
    expect(contact).toBe(1);
    expect(ground).toBeCloseTo(Math.hypot(10, 1), 5);
    expect(roll).toBeCloseTo(12, 5);
    expect(slipLong).toBeCloseTo(2, 5);
    expect(slipLat).toBeCloseTo(1, 5);
    expect(load).toBeCloseTo(4400 / ((1800 * 9.81) / 4), 5);
    expect(rock).toBe(1);
    expect(surfaceAt({ world: 'canyon', sample: () => ({ rock: 0, road: 1 }) }, 0, 0).gravel).toBe(1);
  });
});

describe('hits', () => {
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  const car = { suspensionRestLength: 0.52, maxSuspensionTravel: 0.36 };
  const makeController = () => ({
    car,
    wheels: [0, 1, 2, 3].map(() => ({ hub: { linvel: () => ({ x: 5, y: 0, z: 0 }), rotation: () => identity, translation: () => ({ x: 0, y: 0, z: 0 }) }, tyreLoad: 4400, suspensionLength: 0.52, travelSpeed: 0 })),
    rollingRadius: () => 0.43,
    wheelSpin: () => 5 / 0.43,
  });
  const step = (controller, contacts, out, surfaces) => writeWheels({ controller, contacts }, out, 0, null, surfaces, false);
  const I = (field, wheel = 0) => wheel * WHEEL_FIELDS.length + WHEEL_FIELDS.indexOf(field);

  it('counts a tyre hit, a bump stop and a rim strike once each', () => {
    const c = makeController();
    const out = new Float64Array(4 * WHEEL_FIELDS.length);
    const surfaces = [0, 1, 2, 3].map(() => ({ rock: 0, gravel: 0 }));
    const contacts = { chassis: 0, rims: [0, 0, 0, 0] };
    step(c, contacts, out, surfaces);
    // One step: the load triples on wheel 0, wheel 1 reaches its bump stop, rim 2 strikes.
    c.wheels[0].tyreLoad = 4400 * 3;
    c.wheels[1].suspensionLength = 0.52 - 0.36;
    c.wheels[1].travelSpeed = -1.5;
    contacts.rims[2] = 8000;
    step(c, contacts, out, surfaces);
    // Held there for a few steps: no more hits.
    c.wheels[1].travelSpeed = 0;
    for (let k = 0; k < 5; k++) step(c, contacts, out, surfaces);
    expect(out[I('impact', 0)]).toBeCloseTo((4400 * 2) / ((1800 * 9.81) / 4) - 0.7, 5);
    expect(out[I('bump', 1)]).toBeCloseTo(1.5, 5);
    expect(out[I('rim', 2)]).toBeCloseTo(8000 / ((1800 * 9.81) / 4), 5);
    expect(out[I('impact', 3)]).toBe(0);
    expect(out[I('bump', 0)]).toBe(0);
  });

  it('plays each hit, and nothing without one', () => {
    const peak = (a, b) => {
      const g = new GroundSynth(SR);
      const out = new Float32Array(SR / 4);
      const right = new Float32Array(SR / 4);
      let s = a;
      for (let i = 0; i < out.length; i += BLOCK) {
        const next = i >= BLOCK * 4 ? b : a;
        g.render(out, right, s, next, i, i + BLOCK);
        s = next;
      }
      return Math.max(...out.map(Math.abs));
    };
    expect(peak({ w0impact: 0 }, { w0impact: 0 })).toBeLessThan(1e-4);
    for (const key of ['w0impact', 'w1bump', 'w2topOut', 'w3rim', 'chassisHits']) expect(peak({ [key]: 5 }, { [key]: 6 }), key).toBeGreaterThan(0.05);
  });
});

describe('driveline, steering and body', () => {
  const base = { rpm: 2400, gear: 3, clutch: 1, shaft: 2, speed: 10, w0roll: 10, w1roll: 10, w2roll: 10, w3roll: 10, w0contact: 1, w1contact: 1 };
  const play = (state, layers = null, seconds = 1) => {
    const c = new CarSynth(SR);
    if (layers) c.setLayers(layers);
    const L = new Float32Array(SR * seconds);
    const R = new Float32Array(SR * seconds);
    for (let i = 0; i < L.length; i += BLOCK) c.render(L, R, state, state, i, i + BLOCK);
    return L;
  };
  const only = (k) => Object.fromEntries(['gearWhine', 'transfer', 'axle', 'clunk', 'shift', 'lock', 'cv', 'pump', 'rattle', 'creak', 'wind'].map((x) => [x, x === k ? 1 : 0]));

  it('whines at engine speed × gearbox teeth, most in reverse', () => {
    const x = play(base, only('gearWhine')).subarray(SR / 2);
    const f = (2400 / 60) * 23;
    expect(power(x, f)).toBeGreaterThan(power(x, f * 1.13) * 20);
    const reverse = rms(play({ ...base, gear: -1 }, only('gearWhine')), SR / 2);
    expect(reverse).toBeGreaterThan(rms(play(base, only('gearWhine')), SR / 2) * 3);
  });

  it('whines from the transfer case only in low range', () => {
    expect(rms(play(base, only('transfer')), SR / 2)).toBeLessThan(1e-5);
    expect(rms(play({ ...base, low: 1 }, only('transfer')), SR / 2)).toBeGreaterThan(0.005);
  });

  it('clicks at full lock under drive, not straight ahead', () => {
    expect(rms(play({ ...base, steer: 0 }, only('cv')), SR / 2)).toBeLessThan(1e-5);
    expect(rms(play({ ...base, steer: 1 }, only('cv')), SR / 2)).toBeGreaterThan(0.002);
  });

  it('blows louder the faster it goes', () => {
    const slow = rms(play({ ...base, speed: 8 }, only('wind')), SR / 2);
    const fast = rms(play({ ...base, speed: 28 }, only('wind')), SR / 2);
    expect(fast).toBeGreaterThan(slow * 5);
  });

  it('clunks on backlash, a shift and a diff lock', () => {
    for (const [a, b] of [[{ clunks: 1 }, { clunks: 2 }], [{ gear: 1 }, { gear: 2 }], [{ locks: 0 }, { locks: 1 }]]) {
      const c = new CarSynth(SR);
      const L = new Float32Array(SR / 4);
      const R = new Float32Array(SR / 4);
      let s = a;
      for (let i = 0; i < L.length; i += BLOCK) {
        const next = i >= BLOCK * 4 ? b : a;
        c.render(L, R, s, next, i, i + BLOCK);
        s = next;
      }
      expect(Math.max(...L.map(Math.abs)), JSON.stringify(b)).toBeGreaterThan(0.05);
    }
  });

  it('pans with equal power, as loud as mono in the middle', () => {
    const mid = panGains(0);
    expect(mid.l).toBeCloseTo(1, 6);
    expect(mid.r).toBeCloseTo(1, 6);
    const left = panGains(-1);
    expect(left.r).toBeCloseTo(0, 6);
    expect(left.l ** 2 + left.r ** 2).toBeCloseTo(2, 6);
  });
});
