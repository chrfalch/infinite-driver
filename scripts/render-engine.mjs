// Renders the engine sound offline to a WAV file, for listening and for checking levels:
//   node scripts/render-engine.mjs [out.wav] [scenario] [preset changes as JSON]
// Scenarios: drive (default: idle, full throttle through the gears, lift off, coast, idle),
// short (idle, pull through 1st to 3rd, lift off), rev (revs in neutral), idle.
// Preset changes are merged into the preset, e.g. '{"pipe":{"feedback":0},"bodyShare":0.12}'.
//
// The drivetrain runs on a simple rolling car (as in test/drivetrain.test.js), writes the audio feed
// every physics step, and the sound is read from the feed as the audio worklet does.
import { writeFileSync } from 'node:fs';
import { AudioFeed, FeedReader, createFeedBuffer } from '../src/audio/feed.js';
import { EngineSynth } from '../src/audio/engine-synth.js';
import { TURBO_DIESEL_I4 } from '../src/audio/engine-presets.js';
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
const preset = merge(TURBO_DIESEL_I4, JSON.parse(process.argv[4] ?? '{}'));
const synth = new EngineSynth(SR, preset);
const drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN, automatic: !s.neutral });
const samples = new Float32Array(Math.ceil(s.seconds * SR));

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
    feed.writeStep(simTime, { drivetrain: drive, speed: v });
  }
  const end = Math.min(samples.length, i + BLOCK);
  const values = reader.advance((end - i) / SR);
  const next = { rpm: values.rpm, fuel: values.fuel, exhaustBrake: values.exhaustBrake, throttle: values.throttle };
  synth.render(samples, prev, next, i, end);
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
