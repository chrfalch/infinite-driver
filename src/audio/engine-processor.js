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
//        { type: 'layers', values }   levels of the sound's parts (EngineSynth LAYERS)
//        { type: 'stones', events }   stones thrown and landing (GroundSynth.event)
//        { type: 'groundPreset', preset }, { type: 'groundLayers', values }   as above, for the
//                                     tyre and ground sounds (ground-synth.js)
//   out: { type: 'status', feedSteps } once a second: how many steps the feed has seen
import { EngineSynth } from './engine-synth.js';
import { TURBO_DIESEL_I4 } from './engine-presets.js';
import { AudioFeed, FeedReader } from './feed.js';
import { GroundSynth } from './ground-synth.js';

const IDLE = { rpm: TURBO_DIESEL_I4.idleRpm, fuel: 0.13, exhaustBrake: 0, throttle: 0 };
const MANUAL_SMOOTHING = 0.05; // s

class EngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { feedBuffer = null, mix = null, preset = null } = options.processorOptions ?? {};
    this.synth = new EngineSynth(sampleRate, preset ?? TURBO_DIESEL_I4, { seed: (Math.random() * 2 ** 31) | 0 });
    if (mix) this.synth.setMix(mix);
    this.ground = new GroundSynth(sampleRate, undefined, { seed: (Math.random() * 2 ** 31) | 0 });
    if (options.processorOptions?.groundPreset) this.ground.setPreset(options.processorOptions.groundPreset);
    if (mix?.ground !== undefined) this.ground.level = mix.ground;
    this.reader = feedBuffer ? new FeedReader(new AudioFeed(feedBuffer)) : null;
    this.manual = null;
    this.prev = { ...IDLE };
    this.next = { ...IDLE };
    this.sinceStatus = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'mix') {
        this.synth.setMix(m.values);
        if (m.values.ground !== undefined) this.ground.level = m.values.ground;
      } else if (m.type === 'stones') for (const e of m.events) this.ground.event(e);
      else if (m.type === 'groundPreset') this.ground.setPreset(m.preset);
      else if (m.type === 'groundLayers') this.ground.setLayers(m.values);
      else if (m.type === 'preset') this.synth.setPreset(m.preset);
      else if (m.type === 'layers') this.synth.setLayers(m.values);
      else if (m.type === 'manual') this.manual = { ...IDLE, ...m.values };
      else if (m.type === 'feed') this.manual = null;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const ch = out[0];
    if (!ch) return true;
    const n = ch.length;
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
    this.synth.render(ch, this.prev, next);
    this.ground.render(ch, this.prev, next);
    for (let c = 1; c < out.length; c++) out[c].set(ch);
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
