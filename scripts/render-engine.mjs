// Renders the engine sound offline to a WAV file, for listening and for checking levels:
//   node scripts/render-engine.mjs [out.wav] [scenario] [preset changes as JSON]
// Scenarios: drive (default: idle, full throttle through the gears, lift off, coast, idle),
// short (idle, pull through 1st to 3rd, lift off), rev (revs in neutral), idle.
// Preset changes are merged into the preset, e.g. '{"pipe":{"feedback":0},"bodyShare":0.12}';
// '{"base":"Turbo-diesel I4"}' renders the four instead of the V8; '{"base":"Petrol V8 (recorded)"}'
// renders the recordings (the bank in public/, decoded with ffmpeg); '{"foley":true}' adds the
// recorded tyre, ground and car sounds (public/audio/foley) in place of the synths' parts.
//
// The drivetrain runs on a simple rolling car (as in test/drivetrain.test.js), writes the audio feed
// every physics step, and the sound is read from the feed as the audio worklet does.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { SampleEngine } from '../src/audio/sample-engine.js';
import { loadBank, loadFoley } from '../src/audio/sample-bank.js';
import { Foley } from '../src/audio/foley.js';
import { AudioFeed, FeedReader, createFeedBuffer } from '../src/audio/feed.js';
import { EngineSynth } from '../src/audio/engine-synth.js';
import { ENGINE_PRESETS, TURBO_DIESEL_V8 } from '../src/audio/engine-presets.js';
import { GroundSynth } from '../src/audio/ground-synth.js';
import { CarSynth } from '../src/audio/car-synth.js';
import { softKnee } from '../src/audio/mix.js';
import { DEFAULT_DRIVETRAIN, Drivetrain } from '../src/vehicle/drivetrain.js';

const out = process.argv[2] ?? 'engine.wav';
const scenario = process.argv[3] ?? 'drive';
const SR = 48000;
const BLOCK = 128;
const DT = 1 / 120;
const R = 0.46;
const MASS = 1800;

// Throttle over time for each scenario; neutral: the gearbox stays in neutral.
const SCENARIOS = {
  drive: { seconds: 26, neutral: false, throttle: (t) => (t < 2 ? 0 : t < 16 ? 1 : t < 17.5 ? 0 : t < 20 ? 1 : 0) },
  short: { seconds: 9, neutral: false, throttle: (t) => (t >= 1.5 && t < 7 ? 1 : 0) },
  rev: { seconds: 10, neutral: true, throttle: (t) => (t % 2.5 > 0.8 && t % 2.5 < 1.4 ? 1 : 0) },
  idle: { seconds: 5, neutral: true, throttle: () => 0 },
  // The engine alone, set directly: a slow pull from idle to 6500 rpm, then a slow coast back down
  // (hears every loop and every crossfade of a recorded engine).
  sweep: {
    seconds: 26,
    neutral: true,
    throttle: () => 0,
    engine: (t) => (t < 1 ? { rpm: 800, fuel: 0.13 } : t < 13 ? { rpm: 800 + ((t - 1) / 12) * 5700, fuel: 0.9 } : t < 25 ? { rpm: 6500 - ((t - 13) / 12) * 5700, fuel: 0 } : { rpm: 800, fuel: 0.13 }),
  },
  // Driveline and body: pull away in low range, full lock in a circle, a shaken body, then high
  // range up to speed (wind).
  driveline: {
    seconds: 18,
    neutral: false,
    low: (t) => t < 8,
    throttle: (t) => (t < 1 ? 0 : t < 5 ? 1 : t < 6 ? 0 : 1),
    steer: (t) => (t > 2.5 && t < 5.5 ? 1 : 0),
    shake: (t) => (t > 6 && t < 8 ? 14 : 0),
    surface: () => 'soil',
  },
  // Tyres and ground: pull away on a gravel road, slide on bare rock, spin up on soil (with stones).
  ground: {
    seconds: 16,
    neutral: false,
    throttle: (t) => (t < 1 ? 0 : t < 7 ? 1 : t < 9 ? 0 : t < 12 ? 0.6 : 1),
    surface: (t) => (t < 7 ? 'gravel' : t < 12 ? 'rock' : 'soil'),
    slide: (t) => (t > 8.5 && t < 11.5 ? 3 : 0),
    wheelspin: (t) => (t > 12.5 ? 6 : 0),
    stones: (t) => (t > 12.5 ? 20 : t < 7 && t > 2 ? 3 : 0), // thrown per second
  },
};
// The ground under the scenario's wheels (as the worlds answer surfaceAt in wheels.js).
const GROUNDS = {
  gravel: { world: 'canyon', sample: () => ({ rock: 0, road: 1 }) },
  soil: { world: 'canyon', sample: () => ({ rock: 0, road: 0 }) },
  rock: { rockAt: () => true },
};
const s = SCENARIOS[scenario];
if (!s) throw new Error(`unknown scenario ${scenario}`);

const feed = new AudioFeed(createFeedBuffer());
const reader = new FeedReader(feed);
// Nested objects merge key by key; arrays and values replace.
const merge = (base, changes) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(changes)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v;
  return out;
};
// "base" picks the preset to change (a name in ENGINE_PRESETS; the V8 by default).
const { base = TURBO_DIESEL_V8.name, foley: withFoley = false, ...changes } = JSON.parse(process.argv[4] ?? '{}');
const preset = merge(ENGINE_PRESETS[base], changes);
const synth = new EngineSynth(SR, preset);
// A recorded engine plays its bank, decoded here as the browser would.
let engine = synth;
const fetchFile = async (url) => {
  const bytes = readFileSync(new URL(`../public${url}`, import.meta.url));
  return { ok: true, json: async () => JSON.parse(bytes), arrayBuffer: async () => bytes };
};
const decode = async (bytes) => {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', '-', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { input: bytes, maxBuffer: 1 << 28 });
  const data = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4).slice();
  return { sampleRate: SR, length: data.length, numberOfChannels: 1, getChannelData: () => data };
};
if (preset.samples) engine = new SampleEngine(SR, await loadBank(preset.samples, decode, fetchFile));
const foley = withFoley ? new Foley(SR, await loadFoley('audio/foley', decode, fetchFile)) : null;
const drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN, automatic: !s.neutral, low: false });
const samples = new Float32Array(Math.ceil(s.seconds * SR));
const ground = new GroundSynth(SR);
const car = new CarSynth(SR);
if (foley) {
  const covers = foley.covers();
  ground.muted = new Set(covers.ground);
  car.muted = new Set(covers.car);
}
const right = new Float32Array(samples.length); // the WAV is mono: the left side
// Wheels rolling with the car (the scenario adds sliding and rear wheelspin), as wheels.js reads them.
const identity = { x: 0, y: 0, z: 0, w: 1 };
let slide = 0;
let spin = 0;
const controller = s.surface
  ? {
      wheels: [0, 1, 2, 3].map(() => ({ hub: { linvel: () => ({ x: v, y: 0, z: slide }), rotation: () => identity, translation: () => ({ x: 0, y: 0, z: 0 }) }, tyreLoad: 4400 })),
      rollingRadius: () => 0.43,
      wheelSpin: (i) => (v + (i >= 2 ? spin : 0)) / 0.43,
    }
  : null;

let v = 0;
let simTime = 0;
let prev = { rpm: DEFAULT_DRIVETRAIN.idleRpm, fuel: 0, exhaustBrake: 0, throttle: 0 };
const log = [];
for (let i = 0; i < samples.length; i += BLOCK) {
  const tAudio = i / SR;
  // Physics a little ahead of the audio, in batches like the game's.
  while (simTime < tAudio + 0.06) {
    const throttle = s.throttle(simTime);
    const spins = [v / R, v / R, v / R, v / R];
    const torques = drive.update(DT, { throttle, reverseRequest: false }, spins, v, R);
    if (!s.neutral) {
      const force = torques.reduce((a, b) => a + b, 0) / R - 0.75 * v * Math.abs(v) - (v > 0.05 ? 0.018 * MASS * 9.81 : 0);
      v = Math.max(0, v + (force / (MASS + (4 * 3.5) / (R * R))) * DT);
    }
    simTime += DT;
    slide = s.slide?.(simTime) ?? 0;
    spin = s.wheelspin?.(simTime) ?? 0;
    if (s.low) drive.params.low = s.low(simTime);
    const shake = s.shake ? { heave: s.shake(simTime), twist: s.shake(simTime) * 2 } : undefined;
    feed.writeStep(simTime, { drivetrain: drive, speed: v, controller, steer: (s.steer?.(simTime) ?? 0) * 0.62, shake }, s.surface ? GROUNDS[s.surface(simTime)] : null);
    const thrown = (s.stones?.(simTime) ?? 0) * DT;
    if (Math.random() < thrown) {
      const e = { kind: 'throw', size: 0.025 + Math.random() * 0.045, speed: 2 + Math.random() * 6 };
      ground.event(e);
      foley?.event(e);
    }
  }
  const end = Math.min(samples.length, i + BLOCK);
  const values = reader.advance((end - i) / SR);
  const next = { ...values, ...s.engine?.(end / SR) };
  engine.render(samples, prev, next, i, end);
  ground.render(samples, right, prev, next, i, end);
  car.render(samples, right, prev, next, i, end);
  foley?.render(samples, right, prev, next, i, end);
  for (let k = i; k < end; k++) samples[k] = softKnee(samples[k]);
  prev = next;
  if (i % (SR / 2) < BLOCK) log.push({ t: tAudio.toFixed(1), rpm: Math.round(next.rpm), gear: values.gear, fuel: next.fuel.toFixed(2), brake: next.exhaustBrake.toFixed(2), spool: synth.spool.toFixed(2), kmh: (values.speed * 3.6).toFixed(0) });
}

// Levels per second.
let peak = 0;
const rms = [];
for (let k = 0; k < samples.length; k += SR) {
  let sum = 0;
  for (let j = k; j < Math.min(samples.length, k + SR); j++) {
    sum += samples[j] * samples[j];
    peak = Math.max(peak, Math.abs(samples[j]));
  }
  rms.push(Math.sqrt(sum / SR).toFixed(3));
}
console.table(log);
console.log('peak', peak.toFixed(3), 'rms per second', rms.join(' '), 'firings', synth.firings);

// 16-bit PCM mono.
const data = Buffer.alloc(44 + samples.length * 2);
data.write('RIFF', 0);
data.writeUInt32LE(36 + samples.length * 2, 4);
data.write('WAVEfmt ', 8);
data.writeUInt32LE(16, 16);
data.writeUInt16LE(1, 20);
data.writeUInt16LE(1, 22);
data.writeUInt32LE(SR, 24);
data.writeUInt32LE(SR * 2, 28);
data.writeUInt16LE(2, 32);
data.writeUInt16LE(16, 34);
data.write('data', 36);
data.writeUInt32LE(samples.length * 2, 40);
for (let k = 0; k < samples.length; k++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[k])) * 32767), 44 + k * 2);
writeFileSync(out, data);
console.log('wrote', out);
