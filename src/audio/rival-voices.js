// The other cars' engines: one procedural engine (engine-synth.js) per car heard, mixed in stereo
// where each car is. Pure maths like the synths; the audio worklet (engine-processor.js, the
// 'rivals' processor) runs it, and tests render it offline.
//
// The main thread sends every frame the cars to hear, nearest first: { id, rpm, fuel, exhaustBrake,
// throttle, l, r } (l, r: gains for where the car is, see rivalVoices in audio.js). The engine state
// eases toward the newest (a frame's values at a time would step the pitch), and so do the gains (a
// car passing pans smoothly). A car left out fades away and its voice is freed. At most MAX_VOICES
// play: each costs about as much as the player's own engine.
import { EngineSynth } from './engine-synth.js';
import { TURBO_DIESEL_I4 } from './engine-presets.js';

export const MAX_VOICES = 3;
const SMOOTHING = 0.06; // s, the engine state's ease toward the newest values
const GAIN_SMOOTHING = 0.08; // s
const FADE_OUT = 0.3; // s for a car no longer heard
const IDLE = { rpm: 800, fuel: 0.13, exhaustBrake: 0, throttle: 0 };

export class RivalVoices {
  constructor(sampleRate, preset = TURBO_DIESEL_I4) {
    this.sr = sampleRate;
    this.preset = preset;
    this.mix = null;
    this.level = 0.55; // the others under the player's own car (three racing past at full throttle
    // were as loud as it at idle)
    this.voices = new Map(); // id -> { synth, prev, next, target, l, r, tl, tr, gone }
    this.buf = new Float32Array(128);
    this.seed = 1;
  }

  setPreset(preset) {
    this.preset = preset;
    for (const v of this.voices.values()) v.synth.setPreset(preset);
  }

  setMix(mix) {
    this.mix = { ...this.mix, ...mix };
    for (const v of this.voices.values()) v.synth.setMix(this.mix);
  }

  // The cars to hear now (see the top).
  set(cars) {
    const heard = new Set();
    for (const car of cars.slice(0, MAX_VOICES)) {
      heard.add(car.id);
      let v = this.voices.get(car.id);
      if (!v) {
        const synth = new EngineSynth(this.sr, this.preset, { seed: this.seed++ * 7919 });
        if (this.mix) synth.setMix(this.mix);
        const start = { ...IDLE, ...pick(car) };
        // A new voice starts silent and fades in.
        v = { synth, prev: { ...start }, next: { ...start }, target: start, l: 0, r: 0, tl: 0, tr: 0, gone: false };
        this.voices.set(car.id, v);
      }
      v.target = { ...IDLE, ...pick(car) };
      v.tl = car.l;
      v.tr = car.r;
      v.gone = false;
    }
    for (const [id, v] of this.voices) {
      if (heard.has(id)) continue;
      v.gone = true;
      v.tl = v.tr = 0;
    }
  }

  // Adds the voices into `left` and `right` (one block).
  render(left, right) {
    const n = left.length;
    if (this.buf.length !== n) this.buf = new Float32Array(n);
    const dt = n / this.sr;
    const k = 1 - Math.exp(-dt / SMOOTHING);
    for (const [id, v] of this.voices) {
      for (const key of ['rpm', 'fuel', 'exhaustBrake', 'throttle']) v.next[key] = v.prev[key] + (v.target[key] - v.prev[key]) * k;
      const buf = this.buf;
      buf.fill(0);
      v.synth.render(buf, v.prev, v.next);
      // The gains move across the block from where they were toward the newest.
      const g = 1 - Math.exp(-dt / (v.gone ? FADE_OUT / 3 : GAIN_SMOOTHING));
      const l0 = v.l;
      const r0 = v.r;
      const l1 = l0 + (v.tl - l0) * g;
      const r1 = r0 + (v.tr - r0) * g;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const s = buf[i] * this.level;
        left[i] += s * (l0 + (l1 - l0) * t);
        right[i] += s * (r0 + (r1 - r0) * t);
      }
      v.l = l1;
      v.r = r1;
      Object.assign(v.prev, v.next);
      if (v.gone && Math.max(v.l, v.r) < 1e-3) this.voices.delete(id);
    }
  }
}

const pick = (car) => {
  const out = {};
  for (const key of ['rpm', 'fuel', 'exhaustBrake', 'throttle']) if (Number.isFinite(car[key])) out[key] = car[key];
  return out;
};
