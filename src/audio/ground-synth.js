// Procedural tyre and ground sounds: what each wheel rolls and slides over, and the stones the tyres
// throw. Pure maths like engine-synth.js; the audio worklet adds it to the engine.
//
// Per wheel (from the audio feed, see wheels.js): contact, ground speed, tread speed, slip along and
// across the wheel, load, and the ground's rock and gravel shares.
//   gravel   short broadband cracks, each stone at its own pitch (a few loud, most faint), a
//            grinding crush from stones rubbing under the load, and low thumps over the bigger
//            ones; more cracks when sliding. (Clicks through two fixed bands sounded like drips.)
//   soil     soft low noise that opens up with speed
//   rock     a low road drone
//   hum      the mud-terrain tread blocks hitting the ground: a tone at wheel speed × blocks
//   scrub    sliding on soil and gravel
//   squeal   sliding on rock (grippy rubber on stone): a narrow, wavering tone
//   spin     wheelspin roar on loose ground
// Stones (events from the main thread's soil particles): thrown stones sometimes hit the body
// (a tick with a panel ring); stones landing on rock click.
// Hits (the feed's counters, see wheels.js): a tyre thud over a rock edge, the suspension's bump
// stop and full droop, the rim striking rock, and the chassis hitting (a bang with panel modes)
// and scraping (lasting contact while moving).
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
  tyreHit: 1,
  bumpStop: 1,
  topOut: 1,
  rimHit: 1,
  chassisHit: 1,
  scrape: 1,
});

// A struck object: resonant modes { f, q, gain } rung by an impulse, and a short noise burst.
const HIT_SOUNDS = ['tyreHit', 'bumpStop', 'topOut', 'rimHit', 'chassisHit'];

export const GROUND_SOUND = Object.freeze({
  name: 'Mud-terrain tyres',
  gravel: {
    perMetre: 140, // cracks per metre rolled on full gravel
    perSlip: 260, // extra cracks per second per m/s of sliding
    level: 0.5,
    decay: 0.00025, // s, one crack
    // Each crack rings one of these wide bands, picked at random: no pitch to hear.
    bands: [
      { f: 900, q: 0.55 },
      { f: 1800, q: 0.55 },
      { f: 3300, q: 0.6 },
      { f: 5600, q: 0.6 },
    ],
    loud: 4, // spread of crack strength: higher, fewer loud ones among many faint
    crush: { level: 0.35, f: 650, q: 0.6, flutter: 140 }, // grinding: noise at f, shaken at flutter Hz
    thump: { perMetre: 2.5, level: 0.6, f: 130, q: 1.1 }, // rolling over the bigger stones
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
  // Hits: modes rung by each hit, a noise burst (s) with it, and how loud a hit of strength 1 is
  // (the strength: static loads for tyre and rim, m/s for the suspension, car weights for the
  // chassis). Strength is compressed (square root), capped at `max`.
  tyreHit: { level: 0.35, max: 2, burst: 0.006, burstF: 380, modes: [{ f: 85, q: 1.4, gain: 1 }, { f: 380, q: 1, gain: 0.4 }] },
  bumpStop: { level: 0.45, max: 2, burst: 0.004, burstF: 900, modes: [{ f: 65, q: 2, gain: 1 }, { f: 850, q: 7, gain: 0.35 }] },
  topOut: { level: 0.25, max: 2, burst: 0.003, burstF: 1400, modes: [{ f: 220, q: 3, gain: 0.6 }, { f: 1300, q: 9, gain: 0.5 }] },
  rimHit: { level: 0.04, max: 1, burst: 0.002, burstF: 2500, modes: [{ f: 750, q: 30, gain: 0.6 }, { f: 1900, q: 22, gain: 0.5 }, { f: 3400, q: 18, gain: 0.3 }] },
  chassisHit: { level: 0.5, max: 2, burst: 0.012, burstF: 700, modes: [{ f: 140, q: 3, gain: 1 }, { f: 380, q: 5, gain: 0.6 }, { f: 1050, q: 8, gain: 0.35 }] },
  scrape: { level: 0.6, f: 1800, q: 0.9, rough: 60, fullSpeed: 4 },
  gain: 0.8,
  topCut: 8000, // Hz: the clicks' noise stops here
  // Levels of the parts, as tuned by ear (the gravel at half).
  layers: { ...GROUND_LAYERS, gravel: 0.5 },
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
    this.cracks = [];
    this.crackEnv = new Float64Array(8);
    this.crush = new Svf();
    this.crushShake = 0;
    this.thump = new Svf();
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
    // Hits: per kind, its modes and burst filter, the impulse and burst envelope due.
    this.hitBanks = Object.fromEntries(HIT_SOUNDS.map((k) => [k, { modes: [], burst: new Svf(), kick: 0, env: 0 }]));
    this.counters = {}; // the feed's hit counters as last played
    this.scrapeFilter = new Svf();
    this.scrapeShake = 0;
    this.air = new Svf();
    this.events = []; // { at (samples from now), kind, amp, f }
    this.clock = 0;
    this.setPreset(preset);
  }

  setPreset(preset) {
    const sr = this.sr;
    this.preset = preset;
    const g = preset.gravel;
    while (this.cracks.length < g.bands.length) this.cracks.push(new Svf());
    this.cracks.length = g.bands.length;
    g.bands.forEach((b, i) => this.cracks[i].set(b.f, b.q, sr));
    this.crush.set(g.crush.f, g.crush.q, sr);
    this.thump.set(g.thump.f, g.thump.q, sr);
    this.rock.set(preset.rock.f, 0.7, sr);
    this.scrub.set(preset.scrub.f, preset.scrub.q, sr);
    this.spin.set(preset.spin.f, 0.7, sr);
    this.hum.set(preset.hum.cutoff, 0.7, sr);
    this.air.set(preset.topCut ?? 8000, 0.6, sr);
    const modes = preset.stones.hitModes;
    while (this.hits.length < modes.length) this.hits.push(new Svf());
    this.hits.length = modes.length;
    modes.forEach((m, i) => this.hits[i].set(m.f, m.q, sr));
    for (const k of HIT_SOUNDS) {
      const bank = this.hitBanks[k];
      const spec = preset[k];
      while (bank.modes.length < spec.modes.length) bank.modes.push(new Svf());
      bank.modes.length = spec.modes.length;
      spec.modes.forEach((m, i) => bank.modes[i].set(m.f, m.q, sr));
      bank.burst.set(spec.burstF, 0.8, sr);
    }
    this.scrapeFilter.set(preset.scrape.f, preset.scrape.q, sr);
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
    let crushAmp = 0;
    let thumpRate = 0;
    let thumpPress = 0;
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
      thumpPress += press * gravel;
      crushAmp += press * gravel * Math.min(1, speed / 10 + Math.max(0, slip - 0.3) / 3);
      thumpRate += contact * gravel * p.gravel.thump.perMetre * speed;
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
    crushAmp *= (p.gravel.crush.level * L.gravel * level) / WHEELS;
    const thumpP = Math.min(0.5, thumpRate / sr);
    const thumpAmp = (p.gravel.thump.level * thumpPress * L.gravel * level) / WHEELS;
    const shakeK = 1 - Math.exp((-2 * Math.PI * p.gravel.crush.flutter) / sr);
    const shakeNorm = 1 / Math.sqrt(shakeK / (2 - shakeK) / 3);
    const bands = this.cracks.length;
    const loud = p.gravel.loud;
    soilAmp *= (p.soil.level * L.soil * level) / WHEELS;
    rockAmp *= (p.rock.level * L.rock * level) / WHEELS;
    scrubAmp *= (p.scrub.level * L.scrub * level) / WHEELS;
    spinAmp *= (p.spin.level * L.spin * level) / WHEELS;
    this.soil.set(p.soil.f + p.soil.perSpeed * fastest, 0.7, sr);
    const clickP = Math.min(0.5, gravelRate / sr);
    const decay = Math.exp(-dt / p.gravel.decay);
    const stones = p.stones;
    const hitAmp = L.stoneHits * level;
    const landAmp = L.stoneLand * level;

    // Hits since the last block: the rise of each counter.
    const rise = (key) => {
      const now = b[key] ?? 0;
      const last = this.counters[key];
      this.counters[key] = now;
      return last === undefined || now < last ? 0 : now - last;
    };
    const strike = (kind, strength) => {
      if (strength <= 0) return;
      const spec = p[kind];
      const bank = this.hitBanks[kind];
      const a = spec.level * Math.min(spec.max, Math.sqrt(strength)) * L[kind] * level;
      bank.kick = Math.min(spec.level * spec.max * L[kind] * level, bank.kick + a);
      bank.env = Math.max(bank.env, a);
    };
    for (let i = 0; i < WHEELS; i++) {
      strike('tyreHit', rise(`w${i}impact`));
      strike('bumpStop', rise(`w${i}bump`));
      strike('topOut', rise(`w${i}topOut`));
      strike('rimHit', rise(`w${i}rim`));
    }
    strike('chassisHit', rise('chassisHits'));
    const scrapeAmp = p.scrape.level * Math.sqrt(Math.min(2, (a.chassisForce + b.chassisForce) / 2 || 0)) * Math.min(1, Math.abs((a.speed + b.speed) / 2 || 0) / p.scrape.fullSpeed) * L.scrape * level;
    const scrapeK = 1 - Math.exp((-2 * Math.PI * p.scrape.rough) / sr);
    const scrapeNorm = 1 / Math.sqrt(scrapeK / (2 - scrapeK) / 3);
    const burstDecay = Object.fromEntries(HIT_SOUNDS.map((k) => [k, Math.exp(-dt / p[k].burst)]));

    for (let j = 0; j < n; j++) {
      const r = this.random;
      const noise = r() * 2 - 1;
      const noise2 = r() * 2 - 1;

      // Gravel cracks: each one rings a random band, a few loud among many faint.
      if (gravelAmp > 0 && r() < clickP) this.crackEnv[(r() * bands) | 0] += gravelAmp * r() ** loud * 3;
      let x = 0;
      for (let c = 0; c < bands; c++) {
        this.cracks[c].tick(this.crackEnv[c] * (c & 1 ? noise2 : noise));
        x += this.cracks[c].band;
        this.crackEnv[c] *= decay;
      }
      // Crush: noise shaken fast by low-passed noise; and thumps over the bigger stones.
      this.crushShake += (noise2 - this.crushShake) * shakeK;
      this.crush.tick(noise * Math.abs(this.crushShake) * shakeNorm);
      x += crushAmp * this.crush.band;
      this.thump.tick(thumpAmp > 0 && r() < thumpP ? thumpAmp * (0.4 + 0.6 * r()) * 8 : 0);
      x += this.thump.band;

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

      // Hits: the impulse rings the modes once; the burst decays.
      for (let h = 0; h < HIT_SOUNDS.length; h++) {
        const kind = HIT_SOUNDS[h];
        const bank = this.hitBanks[kind];
        if (bank.kick === 0 && bank.env < 1e-5 && !bank.ringing) continue;
        const spec = p[kind];
        const kick = bank.kick * 20;
        bank.kick = 0;
        let ring = 0;
        for (let m = 0; m < bank.modes.length; m++) {
          bank.modes[m].tick(kick);
          ring += bank.modes[m].band * spec.modes[m].gain;
        }
        bank.burst.tick(bank.env * noise2);
        x += ring + bank.burst.band;
        bank.env *= burstDecay[kind];
        bank.ringing = Math.abs(ring) > 1e-6 || kick !== 0;
      }
      if (scrapeAmp > 0) {
        this.scrapeShake += (noise - this.scrapeShake) * scrapeK;
        this.scrapeFilter.tick(noise2 * (0.4 + Math.abs(this.scrapeShake) * scrapeNorm));
        x += scrapeAmp * this.scrapeFilter.band;
      }

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
    for (const f of [this.air, this.crush, this.thump, ...this.cracks, this.soil, this.rock, this.scrub, this.spin, this.hum, this.landMode, ...this.squeal, ...this.hits]) f.ic1 = f.ic2 = 0;
    this.crackEnv.fill(0);
    for (const bank of Object.values(this.hitBanks)) {
      for (const f of [bank.burst, ...bank.modes]) f.ic1 = f.ic2 = 0;
      bank.kick = bank.env = 0;
    }
    this.scrapeFilter.ic1 = this.scrapeFilter.ic2 = 0;
    this.crushShake = 0;
    this.wobble.fill(0);
    this.events.length = 0;
    out.fill(0, start, end);
  }
}

export { WHEEL_FIELDS };
