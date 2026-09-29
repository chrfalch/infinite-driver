// Procedural tyre and ground sounds: what each wheel rolls and slides over, and the stones the tyres
// throw. Pure maths like engine-synth.js; the audio worklet adds it to the engine.
//
// Per wheel (from the audio feed, see wheels.js): contact, ground speed, tread speed, slip along and
// across the wheel, load, and the ground's rock and gravel shares.
//   gravel   many tiny clicks, as many per metre as stones under the tread, more when sliding
//   soil     soft low noise that opens up with speed
//   rock     a low road drone
//   hum      the mud-terrain tread blocks hitting the ground: a tone at wheel speed × blocks
//   scrub    sliding on soil and gravel
//   squeal   sliding on rock (grippy rubber on stone): a narrow, wavering tone
//   spin     wheelspin roar on loose ground
// Stones (events from the main thread's soil particles): thrown stones sometimes hit the body
// (a tick with a panel ring); stones landing on rock click.
import { Svf } from './engine-synth.js';
import { WHEEL_FIELDS, WHEELS } from './wheels.js';

export const GROUND_LAYERS = Object.freeze({
  gravel: 1,
  soil: 1,
  rock: 1,
  hum: 1,
  scrub: 1,
  squeal: 1,
  spin: 1,
  stoneHits: 1,
  stoneLand: 1,
});

export const GROUND_SOUND = Object.freeze({
  name: 'Mud-terrain tyres',
  gravel: {
    perMetre: 40, // clicks per metre rolled on full gravel
    perSlip: 90, // extra clicks per second per m/s of sliding
    level: 0.35,
    decay: 0.0008, // s, one click
    high: { f: 3800, q: 1.2 },
    low: { f: 1300, q: 1.4 },
    highShare: 0.55,
  },
  soil: { level: 0.4, f: 220, perSpeed: 30, fullSpeed: 14 }, // f: low-pass Hz + perSpeed × m/s
  rock: { level: 0.3, f: 150, fullSpeed: 15 },
  hum: { blocks: 36, level: 0.035, from: 3, full: 25, cutoff: 1500 }, // speeds in m/s
  scrub: { level: 0.22, f: 1500, q: 0.8, from: 0.6, full: 4 }, // slip in m/s
  squeal: { level: 0.1, f: 820, q: 28, perSlip: 35, from: 0.9, full: 3.5 },
  spin: { level: 0.25, f: 450, from: 1.5, full: 8 },
  stones: {
    hitChance: 0.3, // share of thrown stones that hit the body
    hitLevel: 0.35,
    hitModes: [
      { f: 1900, q: 14 },
      { f: 3300, q: 18 },
    ],
    landLevel: 0.25, // on rock
    landModes: { f: 2600, q: 10 },
  },
  gain: 0.8,
  topCut: 8000, // Hz: the clicks' noise stops here
  layers: { ...GROUND_LAYERS },
});

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const MAX_EVENTS = 64;
const KNEE = 0.85;

export class GroundSynth {
  constructor(sampleRate, preset = GROUND_SOUND, { seed = 777 } = {}) {
    this.sr = sampleRate;
    this.random = rng(seed);
    this.layers = { ...GROUND_LAYERS };
    this.effective = { ...GROUND_LAYERS };
    this.level = 1; // the sound settings' tyres & ground level
    this.wheel = Array.from({ length: WHEELS }, () => ({}));
    this.gravelHigh = new Svf();
    this.gravelLow = new Svf();
    this.envHigh = 0;
    this.envLow = 0;
    this.soil = new Svf();
    this.rock = new Svf();
    this.scrub = new Svf();
    this.spin = new Svf();
    this.hum = new Svf();
    this.squeal = Array.from({ length: WHEELS }, () => new Svf());
    this.humPhase = new Float64Array(WHEELS);
    this.wobble = new Float64Array(WHEELS);
    this.hits = [];
    this.landMode = new Svf();
    this.air = new Svf();
    this.events = []; // { at (samples from now), kind, amp, f }
    this.clock = 0;
    this.setPreset(preset);
  }

  setPreset(preset) {
    const sr = this.sr;
    this.preset = preset;
    const g = preset.gravel;
    this.gravelHigh.set(g.high.f, g.high.q, sr);
    this.gravelLow.set(g.low.f, g.low.q, sr);
    this.rock.set(preset.rock.f, 0.7, sr);
    this.scrub.set(preset.scrub.f, preset.scrub.q, sr);
    this.spin.set(preset.spin.f, 0.7, sr);
    this.hum.set(preset.hum.cutoff, 0.7, sr);
    this.air.set(preset.topCut ?? 8000, 0.6, sr);
    const modes = preset.stones.hitModes;
    while (this.hits.length < modes.length) this.hits.push(new Svf());
    this.hits.length = modes.length;
    modes.forEach((m, i) => this.hits[i].set(m.f, m.q, sr));
  }

  setLayers(layers) {
    Object.assign(this.layers, layers);
  }

  // A stone event from the soil particles: { kind: 'throw' | 'land', size (m), speed (m/s), rock }.
  event(e) {
    const s = this.preset.stones;
    const r = this.random;
    if (this.events.length >= MAX_EVENTS) return;
    const big = Math.min(1, (e.size ?? 0.04) / 0.07);
    if (e.kind === 'throw') {
      // Only some thrown stones hit the car, a little later, harder when thrown faster.
      if (r() > s.hitChance) return;
      const amp = s.hitLevel * (0.3 + 0.7 * big) * Math.min(1, 0.3 + (e.speed ?? 3) / 8) * (0.5 + r());
      this.events.push({ at: this.clock + Math.round(this.sr * (0.02 + 0.1 * r())), kind: 'hit', amp });
    } else if (e.kind === 'land' && e.rock) {
      // e.rock: how hard the ground is (1 bare rock, less for gravel).
      const amp = s.landLevel * Math.min(1, e.rock) * (0.3 + 0.7 * big) * (0.5 + r());
      // Smaller stones click higher.
      const f = s.landModes.f * (1.6 - big) * (0.85 + 0.3 * r());
      this.events.push({ at: this.clock + Math.round(this.sr * 0.01 * r()), kind: 'land', amp, f });
    }
  }

  // Adds the ground sound to out[start..end), the wheels moving from state a to b (feed values).
  render(out, a, b, start = 0, end = out.length) {
    const n = end - start;
    if (n <= 0) return;
    const p = this.preset;
    const sr = this.sr;
    const dt = 1 / sr;
    const L = this.effective;
    for (const k in GROUND_LAYERS) L[k] = (p.layers?.[k] ?? 1) * this.layers[k];

    // Per wheel, from the block's middle: levels of each part, and the tread tone.
    let gravelRate = 0;
    let gravelAmp = 0;
    let soilAmp = 0;
    let rockAmp = 0;
    let scrubAmp = 0;
    let spinAmp = 0;
    let fastest = 0;
    const hum = p.hum;
    for (let i = 0; i < WHEELS; i++) {
      const w = this.wheel[i];
      const get = (f) => ((a[`w${i}${f}`] ?? 0) + (b[`w${i}${f}`] ?? 0)) / 2;
      const contact = get('contact');
      const ground = get('ground');
      const roll = get('roll');
      const slipLong = get('slipLong');
      const slipLat = get('slipLat');
      const load = Math.min(2, get('load'));
      const rock = get('rock');
      const gravel = get('gravel') * (1 - rock);
      const soil = Math.max(0, 1 - rock - gravel);
      const speed = Math.max(ground, Math.abs(roll));
      const slip = Math.hypot(slipLong, slipLat);
      const press = contact * (0.4 + 0.6 * Math.min(1.5, load));
      fastest = Math.max(fastest, speed * contact);

      gravelRate += contact * gravel * (p.gravel.perMetre * speed + p.gravel.perSlip * Math.max(0, slip - 0.3));
      gravelAmp += press * gravel;
      soilAmp += press * soil * Math.min(1, speed / p.soil.fullSpeed);
      rockAmp += press * rock * Math.min(1, speed / p.rock.fullSpeed);
      scrubAmp += press * (soil + gravel) * smoothstep(p.scrub.from, p.scrub.full, slip);
      spinAmp += press * (soil + gravel) * smoothstep(p.spin.from, p.spin.full, Math.abs(slipLong));
      // Tread hum: loudest on hard ground.
      w.humAmp = hum.level * press * (rock + 0.6 * gravel + 0.15 * soil) * smoothstep(hum.from, hum.full, Math.abs(roll)) * L.hum * this.level;
      w.humF = (Math.abs(roll) / (2 * Math.PI * 0.43)) * hum.blocks;
      // Squeal: sliding rubber on rock.
      w.squealAmp = p.squeal.level * press * rock * smoothstep(p.squeal.from, p.squeal.full, slip) * L.squeal * this.level;
      this.squeal[i].set(p.squeal.f * (1 + 0.035 * i) + p.squeal.perSlip * slip, p.squeal.q, sr);
    }
    const level = this.level;
    gravelAmp = (p.gravel.level * gravelAmp * L.gravel * level) / WHEELS;
    soilAmp *= (p.soil.level * L.soil * level) / WHEELS;
    rockAmp *= (p.rock.level * L.rock * level) / WHEELS;
    scrubAmp *= (p.scrub.level * L.scrub * level) / WHEELS;
    spinAmp *= (p.spin.level * L.spin * level) / WHEELS;
    this.soil.set(p.soil.f + p.soil.perSpeed * fastest, 0.7, sr);
    const clickP = Math.min(0.5, gravelRate / sr);
    const decay = Math.exp(-dt / p.gravel.decay);
    const highShare = p.gravel.highShare;
    const stones = p.stones;
    const hitAmp = L.stoneHits * level;
    const landAmp = L.stoneLand * level;

    for (let j = 0; j < n; j++) {
      const r = this.random;
      const noise = r() * 2 - 1;
      const noise2 = r() * 2 - 1;

      // Gravel: each click adds to the high or low band's envelope.
      if (gravelAmp > 0 && r() < clickP) {
        const amp = gravelAmp * (0.3 + 0.7 * r());
        if (r() < highShare) this.envHigh += amp;
        else this.envLow += amp;
      }
      this.gravelHigh.tick(this.envHigh * noise);
      this.gravelLow.tick(this.envLow * noise2);
      this.envHigh *= decay;
      this.envLow *= decay;
      let x = this.gravelHigh.band + this.gravelLow.band;

      x += soilAmp * this.soil.tick(noise2) * 2;
      x += rockAmp * this.rock.tick(noise) * 3;
      this.scrub.tick(noise);
      x += scrubAmp * this.scrub.band;
      x += spinAmp * this.spin.tick(noise2) * 2;

      // Tread hum and squeal, per wheel.
      let tread = 0;
      for (let i = 0; i < WHEELS; i++) {
        const w = this.wheel[i];
        if (w.humAmp > 0) {
          this.humPhase[i] += w.humF * dt;
          if (this.humPhase[i] >= 1) this.humPhase[i] -= 1;
          // A saw: the blocks strike and release.
          tread += w.humAmp * (2 * this.humPhase[i] - 1);
        }
        if (w.squealAmp > 0) {
          this.wobble[i] += (r() * 2 - 1) * 0.02;
          this.wobble[i] *= 0.999;
          this.squeal[i].tick(noise * (1 + this.wobble[i]));
          x += w.squealAmp * this.squeal[i].band * 0.6;
        }
      }
      x += this.hum.tick(tread);

      // Stone events due now.
      let hit = 0;
      let land = 0;
      for (let e = this.events.length - 1; e >= 0; e--) {
        const ev = this.events[e];
        if (ev.at > this.clock) continue;
        if (ev.kind === 'hit') hit += ev.amp;
        else {
          this.landMode.set(ev.f, stones.landModes.q, sr);
          land += ev.amp;
        }
        this.events.splice(e, 1);
      }
      for (let m = 0; m < this.hits.length; m++) {
        this.hits[m].tick(hit * 2.5);
        x += this.hits[m].band * hitAmp;
      }
      this.landMode.tick(land * 6);
      x += this.landMode.band * landAmp;

      this.clock++;
      // Added to the engine; a soft knee keeps the sum inside full scale without touching the
      // engine's own level below it.
      const sum = out[start + j] + this.air.tick(x) * p.gain;
      const m = Math.abs(sum);
      out[start + j] = m < KNEE ? sum : Math.sign(sum) * (KNEE + (1 - KNEE) * Math.tanh((m - KNEE) / (1 - KNEE)));
    }
    if (!Number.isFinite(out[end - 1])) this.recover(out, start, end);
  }

  recover(out, start, end) {
    for (const f of [this.air, this.gravelHigh, this.gravelLow, this.soil, this.rock, this.scrub, this.spin, this.hum, this.landMode, ...this.squeal, ...this.hits]) f.ic1 = f.ic2 = 0;
    this.envHigh = this.envLow = 0;
    this.wobble.fill(0);
    this.events.length = 0;
    out.fill(0, start, end);
  }
}

export { WHEEL_FIELDS };
