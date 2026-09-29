// Procedural engine sound. Pure maths with no Web Audio: the audio worklet (engine-processor.js)
// runs it, and tests and scripts/render-engine.mjs render it offline.
//
// Each cylinder firing sends a pressure pulse down the exhaust. The pulses go through a model of
// the pipe (a delay line with an inverted reflection) and the silencer (resonances and a low-pass
// whose cutoff rises with load and rpm). The block rings a little with each combustion, the diesel
// knocks (clatter), and the turbo spools up with exhaust energy and whistles. The pitch is simply
// the firing rate: rpm / 60 × cylinders / 2 pulses per second.
import { TURBO_DIESEL_I4 } from './engine-presets.js';

// Zavalishin's state-variable filter (topology-preserving transform): stable when the cutoff moves.
export class Svf {
  constructor() {
    this.ic1 = 0;
    this.ic2 = 0;
    this.set(1000, 0.7, 48000);
  }
  set(f, q, sampleRate) {
    const g = Math.tan((Math.PI * Math.min(f, sampleRate * 0.45)) / sampleRate);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  // One sample; the low-pass and band-pass results are left in this.low and this.band.
  tick(v0) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
    return v2;
  }
}

// Deterministic noise, so offline renders and tests repeat exactly.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const MAX_PULSES = 6;

export class EngineSynth {
  constructor(sampleRate, preset = TURBO_DIESEL_I4, { seed = 12345 } = {}) {
    this.sr = sampleRate;
    this.preset = preset;
    this.random = rng(seed);
    // Level multipliers from the sound settings (see audio/config.js).
    this.mix = { engine: 1, turbo: 1, clatter: 1 };

    this.phase = 0; // position in the 720° cycle, 0..1
    this.firings = 0; // count of firings so far (tests read it)
    this.nextJitter = preset.firing.map(() => 0);
    // Cycle travelled since each cylinder last fired: a cylinder fires at most once per cycle,
    // however its moment moves with the jitter.
    this.sinceFire = preset.firing.map(() => 1);
    // Active pulses: time since firing (s), strength, body time constant (s), knock strength.
    this.pulses = [];

    this.delay = new Float32Array(Math.ceil(sampleRate * 0.1));
    this.delayIndex = 0;
    this.delayLp = 0;
    this.muffler = [];
    this.tone = new Svf();
    this.block = new Svf();
    this.clatter = [];
    this.hiss = new Svf();
    this.flutterFilter = new Svf();
    this.flutterFilter.set(900, 1.5, sampleRate);
    // The last stage: no fizz above what an exhaust makes.
    this.air = new Svf();
    this.setPreset(preset);
    this.dc = 0; // DC blocker state
    this.dcIn = 0;

    this.spool = 0; // turbo speed, 0..1
    this.whinePhase = 0;
    this.gearPhase = 0;
    this.flutter = 0; // time left of a compressor flutter (s)
    this.flutterPhase = 0;
    this.lastThrottle = 0;
    this.roughNoise = 0;
    this.wander = 0;
    this.whine2Phase = 0;
  }

  // A new preset, applied while playing (the engine lab's sliders). Filters keep their state.
  setPreset(preset) {
    const sr = this.sr;
    this.preset = preset;
    const pipe = preset.pipe;
    this.delayLength = Math.min(this.delay.length - 1, Math.max(1, Math.round((sr * 2 * pipe.length) / pipe.speedOfSound)));
    const filters = (list, specs) => {
      while (list.length < specs.length) list.push(new Svf());
      list.length = specs.length;
      specs.forEach((s, i) => list[i].set(s.f, s.q, sr));
    };
    filters(this.muffler, preset.muffler);
    filters(this.clatter, preset.clatter.bands);
    this.block.set(preset.block.f, preset.block.q, sr);
    this.air.set(preset.topCut ?? 7000, 0.6, sr);
  }

  setMix(mix) {
    Object.assign(this.mix, mix);
  }

  // Fires cylinder k: a new exhaust pulse and its combustion knock.
  fire(k, rpm, fuel, exhaustBrake) {
    const p = this.preset;
    this.firings++;
    const interval = 120 / Math.max(rpm, 100) / p.cylinders; // s between firings
    const burn = Math.min(1, fuel * 3); // any fuel at all burns: the knock does not scale with load
    const jitter = 1 + p.ampJitter * (this.random() * 2 - 1);
    // A slow wander over several firings: the engine throbs and lumps along instead of hissing.
    this.wander += ((this.random() * 2 - 1) - this.wander) * 0.35;
    const wander = 1 + (p.wander ?? 0) * this.wander;
    const strength = p.cylinderGain[k] * jitter * wander * (p.motoring + (1 - p.motoring) * Math.pow(fuel, 0.6) + p.exhaustBrake.level * exhaustBrake);
    const rpmNorm = Math.min(1, rpm / p.limiterRpm);
    const knock = p.clatter.level * (0.08 + 0.92 * burn) * (0.35 + 0.65 * burn * (1 - fuel * 0.4)) * Math.max(0.25, 1.25 - rpmNorm) * jitter;
    const body = Math.min(0.012, Math.max(0.0008, p.bodyShare * interval));
    if (this.pulses.length >= MAX_PULSES) this.pulses.shift();
    this.pulses.push({ t: 0, strength, body, knock, brake: exhaustBrake });
    // The next firing of this cylinder comes a little early or late.
    this.nextJitter[k] = p.timingJitter * (this.random() * 2 - 1) / p.cylinders;
  }

  // Renders out.length samples (from index start to end), with the engine state moving linearly
  // from `a` to `b` over them: { rpm, fuel, exhaustBrake, throttle }.
  render(out, a, b, start = 0, end = out.length) {
    const p = this.preset;
    const sr = this.sr;
    const dt = 1 / sr;
    const n = end - start;
    if (n <= 0) return;
    const mix = this.mix;

    // Per-block coefficients from the block's middle.
    const rpmMid = (a.rpm + b.rpm) / 2;
    const fuelMid = (a.fuel + b.fuel) / 2;
    const cutoff = (p.tone.base + p.tone.load * fuelMid + p.tone.perRpm * rpmMid) * (1 - 0.25 * this.spool);
    this.tone.set(cutoff, p.tone.q, sr);
    const t = p.turbo;
    this.hiss.set(1500 + 2600 * this.spool, t.hissQ, sr);
    const upK = 1 - Math.exp(-(n * dt) / t.upTime);
    const downK = 1 - Math.exp(-(n * dt) / t.downTime);
    const dcK = Math.exp((-2 * Math.PI * 25) / sr);
    const pipeFb = p.pipe.feedback;
    const pipeDamp = p.pipe.damping;
    const spikeTime = p.spikeTime;
    const clatterDecay = p.clatter.decay;
    // Turbulence noise: one-pole low-passed white noise, scaled back to unit spread.
    const roughK = 1 - Math.exp((-2 * Math.PI * p.rough.frequency) / sr);
    const roughNorm = 1 / Math.sqrt(roughK / (2 - roughK) / 3);
    const roughAmount = p.rough.amount * (0.6 + 0.4 * fuelMid);

    // Turbo: spools toward the exhaust energy (rpm and fuel), faster up than down.
    const energy = (rpmMid / p.limiterRpm) * (0.15 + fuelMid);
    const target = Math.min(1, Math.max(0, (energy - 0.12) / 0.7));
    this.spool += (target - this.spool) * (target > this.spool ? upK : downK);
    const spool = this.spool;
    // Lifting off at boost starts a compressor flutter.
    const throttle = b.throttle ?? 0;
    if (this.lastThrottle > 0.5 && throttle <= 0.5 && spool > 0.4) this.flutter = t.flutterTime;
    this.lastThrottle = throttle;
    const whineAmp = t.whine * spool ** 1.5 * (0.4 + 0.6 * fuelMid) * mix.turbo;
    const hissAmp = t.hiss * spool * (0.2 + 0.8 * fuelMid) * mix.turbo;
    const flutterAmp = t.flutter * spool * mix.turbo;
    const whineF = t.whineMin + (t.whineMax - t.whineMin) * spool;
    const gearAmp = p.gearWhine.level * Math.min(1, rpmMid / 3000);
    const cylinders = p.cylinders;
    const firing = p.firing;

    for (let i = 0; i < n; i++) {
      const f = n > 1 ? i / (n - 1) : 1;
      const rpm = a.rpm + (b.rpm - a.rpm) * f;
      const fuel = a.fuel + (b.fuel - a.fuel) * f;
      const brake = (a.exhaustBrake ?? 0) + ((b.exhaustBrake ?? 0) - (a.exhaustBrake ?? 0)) * f;

      // Advance the cycle and fire each cylinder whose moment has passed.
      const prev = this.phase;
      const step = (Math.max(0, rpm) / 120) * dt;
      let next = prev + step;
      for (let k = 0; k < cylinders; k++) {
        this.sinceFire[k] += step;
        let at = firing[k] + this.nextJitter[k];
        if (at < 0) at += 1;
        if (at >= 1) at -= 1;
        if (this.sinceFire[k] > 0.5 && ((prev < at && next >= at) || (next >= 1 && at <= next - 1))) {
          this.sinceFire[k] = 0;
          this.fire(k, rpm, fuel, brake);
        }
      }
      if (next >= 1) next -= 1;
      this.phase = next;

      // Sum the active pulses: spike + body (alpha functions, peak 1 at their time constant),
      // and the knock envelope.
      let pressure = 0;
      let knock = 0;
      let rasp = 0;
      for (let j = 0; j < this.pulses.length; j++) {
        const q = this.pulses[j];
        const ts = q.t / spikeTime;
        const tb = q.t / q.body;
        const shape = p.spike * ts * Math.exp(1 - ts) + tb * Math.exp(1 - tb);
        pressure += q.strength * shape;
        knock += q.knock * Math.exp(-q.t / clatterDecay);
        rasp += q.brake * tb * Math.exp(1 - tb);
        q.t += dt;
      }
      // Drop pulses that have died away (oldest first).
      while (this.pulses.length && this.pulses[0].t > this.pulses[0].body * 8 && this.pulses[0].t > 0.006) this.pulses.shift();

      const noise = this.random() * 2 - 1;
      // The exhaust brake makes the pulses raspy.
      pressure += rasp * p.exhaustBrake.rasp * noise;
      // Turbulence: the gas does not flow smoothly, so each pulse is roughened by low-passed noise.
      // Smooth pulses through the pipe sounded like blowing through a hose; rough ones rumble.
      this.roughNoise += (noise - this.roughNoise) * roughK;
      pressure *= Math.max(0, 1 + roughAmount * this.roughNoise * roughNorm);

      // Pipe: the pulse plus its inverted, dulled reflection a round trip later.
      const delayed = this.delay[(this.delayIndex - this.delayLength + this.delay.length) % this.delay.length];
      this.delayLp += (delayed - this.delayLp) * (1 - pipeDamp);
      const piped = pressure + pipeFb * this.delayLp;
      this.delay[this.delayIndex] = piped;
      this.delayIndex = (this.delayIndex + 1) % this.delay.length;

      // Silencer: body resonances, then the load-dependent low-pass.
      let silenced = piped * 0.5;
      for (let m = 0; m < this.muffler.length; m++) {
        this.muffler[m].tick(piped);
        silenced += this.muffler[m].band * p.muffler[m].gain;
      }
      // The silencer overdriven a little, harder on the pressure peaks: grit in the low mids.
      const drive = p.drive;
      silenced = silenced > 0 ? Math.tanh(silenced * drive) / drive : Math.tanh(silenced * drive * 0.6) / (drive * 0.6);
      const exhaust = this.tone.tick(silenced);

      // Block ring and diesel clatter.
      this.block.tick(pressure);
      const blockOut = this.block.band * p.block.gain;
      const knockNoise = knock * noise;
      let clatter = 0;
      for (let c = 0; c < this.clatter.length; c++) {
        this.clatter[c].tick(knockNoise);
        clatter += this.clatter[c].band * p.clatter.bands[c].gain;
      }
      clatter *= mix.clatter;

      // Turbo whistle, intake hiss and lift-off flutter.
      this.whinePhase += whineF * dt;
      if (this.whinePhase >= 1) this.whinePhase -= 1;
      // Compressor whistle: the blade tone and a splitter-blade tone above it.
      this.whine2Phase += whineF * t.whine2Ratio * dt;
      if (this.whine2Phase >= 1) this.whine2Phase -= 1;
      let turbo = whineAmp * (Math.sin(2 * Math.PI * this.whinePhase) + t.whine2 * Math.sin(2 * Math.PI * this.whine2Phase));
      this.hiss.tick(noise);
      turbo += hissAmp * this.hiss.band;
      if (this.flutter > 0) {
        this.flutter -= dt;
        this.flutterPhase += t.flutterRate * dt;
        if (this.flutterPhase >= 1) this.flutterPhase -= 1;
        const gate = Math.max(0, Math.sin(2 * Math.PI * this.flutterPhase));
        this.flutterFilter.tick(noise);
        turbo += flutterAmp * (this.flutter / t.flutterTime) * gate * gate * this.flutterFilter.band;
      }

      // Timing gear whine.
      this.gearPhase += ((rpm / 60) * p.gearWhine.teeth) * dt;
      if (this.gearPhase >= 1) this.gearPhase -= 1;
      const gear = gearAmp * Math.sin(2 * Math.PI * this.gearPhase);

      // DC blocker (the pulses are one-sided), then a soft clip.
      const engine = (exhaust + blockOut) * mix.engine + clatter * mix.engine;
      this.dc = engine - this.dcIn + dcK * this.dc;
      this.dcIn = engine;
      const x = (this.dc + turbo + gear) * p.gain;
      out[start + i] = Math.tanh(this.air.tick(x));
    }
  }
}
