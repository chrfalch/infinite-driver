// Audio worklet: the procedural engine (engine-synth.js) on the audio thread, driven by the
// physics steps in the shared audio feed (feed.js). Loaded by audio/audio.js.
//
// Messages on the port:
//   in:  { type: 'mix', values }      level settings (engine, turbo, clatter)
//        { type: 'manual', values }   drive the engine from these values instead of the feed
//                                     ({ rpm, fuel, exhaustBrake, throttle }; the engine lab, or a
//                                     browser that cannot share memory with the audio thread)
//        { type: 'feed' }             back to the feed
//        { type: 'preset', preset }   a whole new engine preset (the engine lab's sliders)
//        { type: 'bank', bank }       recordings for a preset with `samples` (sample-bank.js)
//        { type: 'foley', bank }      recorded tyre, ground and car sounds (foley.js); each one
//                                     recorded replaces its synth layer
//        { type: 'foleyOn', on }      play the recordings (true) or only the synths
//        { type: 'source', samples }  play the recordings (true, as the preset says) or the synth
//        { type: 'layers', values }   levels of the sound's parts (EngineSynth LAYERS)
//        { type: 'stones', events }   stones thrown and landing (GroundSynth.event)
//        { type: 'groundPreset', preset }, { type: 'groundLayers', values }   as above, for the
//                                     tyre and ground sounds (ground-synth.js)
//        { type: 'carPreset', preset }, { type: 'carLayers', values }   the same for the driveline,
//                                     steering and body (car-synth.js)
//        { type: 'listener', pos }    where each part is heard ({ l, r } gains; mix.js CENTERED)
//   out: { type: 'status', feedSteps } once a second: how many steps the feed has seen
import { EngineSynth } from './engine-synth.js';
import { SampleEngine } from './sample-engine.js';
import { TURBO_DIESEL_I4 } from './engine-presets.js';
import { AudioFeed, FeedReader } from './feed.js';
import { GroundSynth } from './ground-synth.js';
import { CarSynth } from './car-synth.js';
import { Foley } from './foley.js';
import { CENTERED, softKnee } from './mix.js';

const IDLE = { rpm: TURBO_DIESEL_I4.idleRpm, fuel: 0.13, exhaustBrake: 0, throttle: 0 };
const MANUAL_SMOOTHING = 0.05; // s

class EngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { feedBuffer = null, mix = null, preset = null } = options.processorOptions ?? {};
    this.synth = new EngineSynth(sampleRate, preset ?? TURBO_DIESEL_I4, { seed: (Math.random() * 2 ** 31) | 0 });
    if (mix) this.synth.setMix(mix);
    // A preset with recordings plays them once its bank arrives; the synth until then.
    this.sampler = new SampleEngine(sampleRate);
    if (mix) this.sampler.setMix(mix);
    this.recorded = !!preset?.samples;
    this.useSamples = true;
    this.foleyOn = true;
    this.ground = new GroundSynth(sampleRate, undefined, { seed: (Math.random() * 2 ** 31) | 0 });
    if (options.processorOptions?.groundPreset) this.ground.setPreset(options.processorOptions.groundPreset);
    if (mix?.ground !== undefined) this.ground.level = mix.ground;
    this.car = new CarSynth(sampleRate, undefined, { seed: (Math.random() * 2 ** 31) | 0 });
    if (options.processorOptions?.carPreset) this.car.setPreset(options.processorOptions.carPreset);
    if (mix?.car !== undefined) this.car.level = mix.car;
    this.foley = new Foley(sampleRate, null, { seed: (Math.random() * 2 ** 31) | 0 });
    this.foley.level = { ground: mix?.ground ?? 1, car: mix?.car ?? 1 };
    this.reader = feedBuffer ? new FeedReader(new AudioFeed(feedBuffer)) : null;
    this.manual = null;
    this.prev = { ...IDLE };
    this.next = { ...IDLE };
    this.sinceStatus = 0;
    this.pos = CENTERED; // where each part is heard (audio.js sends it every frame)
    this.engineBuf = new Float32Array(128);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'mix') {
        this.synth.setMix(m.values);
        this.sampler.setMix(m.values);
        if (m.values.ground !== undefined) this.ground.level = this.foley.level.ground = m.values.ground;
        if (m.values.car !== undefined) this.car.level = this.foley.level.car = m.values.car;
      } else if (m.type === 'stones') {
        for (const e of m.events) {
          this.ground.event(e);
          if (this.foleyOn) this.foley.event(e);
        }
      } else if (m.type === 'groundPreset') this.ground.setPreset(m.preset);
      else if (m.type === 'groundLayers') this.ground.setLayers(m.values);
      else if (m.type === 'carPreset') this.car.setPreset(m.preset);
      else if (m.type === 'carLayers') this.car.setLayers(m.values);
      else if (m.type === 'listener') this.pos = m.pos;
      else if (m.type === 'preset') {
        this.synth.setPreset(m.preset);
        this.recorded = !!m.preset.samples;
      } else if (m.type === 'bank') this.sampler.setBank(m.bank);
      else if (m.type === 'foley') {
        this.foley.setBank(m.bank);
        this.applyCovers();
      } else if (m.type === 'foleyOn') {
        this.foleyOn = m.on;
        this.applyCovers();
      }
      else if (m.type === 'source') this.useSamples = m.samples;
      else if (m.type === 'layers') this.synth.setLayers(m.values);
      else if (m.type === 'manual') this.manual = { ...IDLE, ...m.values };
      else if (m.type === 'feed') this.manual = null;
    };
  }

  // The synth layers the recordings replace are muted (while the recordings play).
  applyCovers() {
    const covers = this.foleyOn ? this.foley.covers() : { ground: [], car: [] };
    this.ground.muted = new Set(covers.ground);
    this.car.muted = new Set(covers.car);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    if (!left) return true;
    const right = out[1] ?? null;
    const n = left.length;
    const dt = n / sampleRate;
    const next = this.next;
    if (this.manual) {
      const k = 1 - Math.exp(-dt / MANUAL_SMOOTHING);
      for (const key of ['rpm', 'fuel', 'exhaustBrake', 'throttle']) next[key] = this.prev[key] + (this.manual[key] - this.prev[key]) * k;
      next.throttle = this.manual.throttle;
    } else if (this.reader) {
      const v = this.reader.advance(dt);
      // All fields: the engine's and each wheel's.
      if (this.reader.hasData) Object.assign(next, v);
    }
    // The engine (mono) where the exhaust is, then the tyres, ground and hits, each where it is.
    if (this.engineBuf.length !== n) this.engineBuf = new Float32Array(n);
    const engine = this.engineBuf;
    const recorded = this.recorded && this.useSamples && this.sampler.ready;
    (recorded ? this.sampler : this.synth).render(engine, this.prev, next);
    const R = right ?? (this.monoRight ??= new Float32Array(n));
    const at = this.pos.exhaust;
    for (let i = 0; i < n; i++) {
      left[i] = engine[i] * at.l;
      R[i] = engine[i] * at.r;
    }
    this.ground.render(left, R, this.prev, next, 0, n, this.pos);
    this.car.render(left, R, this.prev, next, 0, n, this.pos);
    if (this.foleyOn) this.foley.render(left, R, this.prev, next, 0, n, this.pos);
    for (let i = 0; i < n; i++) {
      left[i] = softKnee(left[i]);
      R[i] = softKnee(R[i]);
    }
    // A mono output gets both sides.
    if (!right) for (let i = 0; i < n; i++) left[i] = (left[i] + R[i]) / 2;
    for (let c = 2; c < out.length; c++) out[c].set(left);
    const ch = left;
    for (let i = 0; i < n; i++) this.peak = Math.max(this.peak ?? 0, Math.abs(ch[i]));
    Object.assign(this.prev, next);

    this.sinceStatus += dt;
    if (this.sinceStatus >= 1) {
      this.sinceStatus = 0;
      this.port.postMessage({ type: 'status', feedSteps: this.reader ? this.reader.feed.written() : 0, recoveries: this.synth.recoveries ?? 0, peak: this.peak });
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('engine', EngineProcessor);
