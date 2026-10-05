// Recorded sounds of the tyres, the ground and the car (foley), played from the same audio feed as
// the procedural ground and car synths (ground-synth.js, car-synth.js). Pure maths like them; the
// audio worklet adds it after them, and each part it plays is silenced in the synths (covers()).
//
// Two kinds of sound, from a bank (audio/sample-bank.js loadFoley):
//   loops     a sound that lasts: rolling on gravel, dirt, sand, rock or snow, sliding, wheelspin,
//             the chassis scraping, rattles. Played at a level and a rate set every block from the
//             feed (faster rolling: louder and a little higher). Takes of a loop are a list; one
//             plays (a bank may hold several for variety; the first for now).
//   one-shots a hit: a stone on the body or on rock, a tyre over a rock edge, the bump stop, the
//             suspension topping out, a rim strike, the chassis hitting, a landing, a creak, a clunk.
//             Each has takes recorded at different strengths; a hit plays the take nearest its
//             strength (never the same take twice running), a little higher or lower each time,
//             louder the harder it is, where it happened. At most MAX_VOICES at once: a new one
//             takes the place of the quietest.
// The feed's hit counters (wheels.js) count up; a hit is the rise of a counter between blocks, as
// in the synths.
import { WHEELS } from './wheels.js';
import { CENTERED } from './mix.js';

const MAX_VOICES = 24;
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

// Cubic read of a loop at a fractional position, wrapping inside [0, len).
function loopAt(data, len, pos) {
  const i = Math.floor(pos);
  const f = pos - i;
  const at = (k) => data[k < 0 ? k + len : k >= len ? k - len : k];
  const xm1 = at(i - 1);
  const x0 = data[i];
  const x1 = at(i + 1);
  const x2 = at(i + 2);
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

// How each sound is driven, and how loud it plays (1 = the bank's level). Loops: `speed` (m/s) is
// the ground speed at which the take plays at its recorded rate and full level; slower plays it
// quieter and lower. One-shots: `full` is the strength (the feed's units, see wheels.js) that plays
// the loudest take at full level; strength below `from` plays nothing.
export const FOLEY = Object.freeze({
  loops: {
    'roll-gravel': { level: 0.5, speed: 12 },
    'roll-dirt': { level: 0.45, speed: 12 },
    'roll-sand': { level: 0.45, speed: 12 },
    'roll-rock': { level: 0.4, speed: 12 },
    'roll-snow': { level: 0.4, speed: 10 },
    slide: { level: 0.5, from: 0.6, full: 4 }, // slip, m/s
    squeal: { level: 0.25, from: 0.9, full: 3.5 },
    spin: { level: 0.5, from: 1.5, full: 8 },
    scrape: { level: 0.6, full: 4 }, // speed m/s
    rattle: { level: 0.4, from: 2, full: 14 }, // chassis heave, m/s²
  },
  oneshots: {
    'stone-hit': { level: 0.35, from: 0, full: 1 },
    'stone-land': { level: 0.25, from: 0, full: 1 },
    'tyre-hit': { level: 0.45, from: 0.05, full: 2 }, // static loads
    bump: { level: 0.6, from: 0.1, full: 3 }, // m/s
    'top-out': { level: 0.35, from: 0.1, full: 2.5 },
    rim: { level: 0.4, from: 0.1, full: 3 },
    'chassis-hit': { level: 0.7, from: 0.05, full: 2 }, // car weights
    landing: { level: 0.8, from: 1.5, full: 6 }, // m/s, all wheels' bump stops together
    creak: { level: 0.3, from: 12, full: 40 }, // twist rad/s²
    clunk: { level: 0.35, from: 0.2, full: 2 }, // kN·m
  },
  gain: 1,
});

// Which synth layers each recorded sound replaces (GROUND_LAYERS, CAR_LAYERS).
export const REPLACES = Object.freeze({
  ground: {
    'roll-gravel': ['gravel'],
    'roll-dirt': ['soil'],
    'roll-sand': ['soil'],
    'roll-rock': ['rock'],
    slide: ['scrub'],
    squeal: ['squeal'],
    spin: ['spin'],
    scrape: ['scrape'],
    'stone-hit': ['stoneHits'],
    'stone-land': ['stoneLand'],
    'tyre-hit': ['tyreHit'],
    bump: ['bumpStop'],
    'top-out': ['topOut'],
    rim: ['rimHit'],
    'chassis-hit': ['chassisHit'],
  },
  car: { rattle: ['rattle'], creak: ['creak'], clunk: ['clunk'] },
});

export class Foley {
  constructor(sampleRate, bank = null, { seed = 4242, preset = FOLEY } = {}) {
    this.sr = sampleRate;
    this.random = rng(seed);
    this.preset = preset;
    this.level = { ground: 1, car: 1 }; // the sound settings' levels
    this.counters = {};
    this.voices = []; // one-shots playing: { take, pos, rate, gain, pan }
    this.last = {}; // the take each one-shot played last
    this.pending = []; // stone events: { at (samples), name, strength }
    this.clock = 0;
    this.setBank(bank);
  }

  setBank(bank) {
    this.bank = bank;
    // Each loop's voice: its take, read position and gain at the end of the last block.
    this.loops = {};
    for (const [name, takes] of Object.entries(bank?.loops ?? {})) if (takes.length) this.loops[name] = { take: takes[0], pos: 0, gain: 0, rate: 1, pan: CENTERED.body };
    this.shots = {};
    for (const [name, takes] of Object.entries(bank?.oneshots ?? {})) if (takes.length) this.shots[name] = [...takes].sort((x, y) => x.strength - y.strength);
  }

  // The synth layers to silence, as { ground: [...], car: [...] }: those this bank plays.
  covers() {
    const out = { ground: [], car: [] };
    for (const part of ['ground', 'car']) {
      for (const [name, layers] of Object.entries(REPLACES[part])) if (this.loops[name] || this.shots[name]) out[part].push(...layers);
    }
    return out;
  }

  // A stone event from the soil particles (as GroundSynth.event).
  event(e) {
    const r = this.random;
    if (this.pending.length >= 64) return;
    const big = Math.min(1, (e.size ?? 0.04) / 0.07);
    if (e.kind === 'throw' && this.shots['stone-hit']) {
      if (r() > 0.3) return;
      const strength = (0.3 + 0.7 * big) * Math.min(1, 0.3 + (e.speed ?? 3) / 8) * (0.5 + 0.5 * r());
      this.pending.push({ at: this.clock + Math.round(this.sr * (0.02 + 0.1 * r())), name: 'stone-hit', strength });
    } else if (e.kind === 'land' && e.rock && this.shots['stone-land']) {
      const strength = Math.min(1, e.rock) * (0.3 + 0.7 * big) * (0.5 + 0.5 * r());
      this.pending.push({ at: this.clock + Math.round(this.sr * 0.01 * r()), name: 'stone-land', strength });
    }
  }

  // Plays a one-shot of `strength` heard at `pan` ({ l, r }).
  hit(name, strength, pan, part) {
    const takes = this.shots[name];
    const spec = this.preset.oneshots[name];
    if (!takes || !spec || strength <= spec.from) return;
    const r = this.random;
    const s = Math.min(1, (strength - spec.from) / (spec.full - spec.from));
    // The takes nearest this strength (the strongest takes for the strongest hits), not the last.
    const want = s * (takes[takes.length - 1].strength ?? 1);
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < takes.length; k++) {
      if (takes.length > 1 && takes[k] === this.last[name]) continue;
      const d = Math.abs((takes[k].strength ?? 1) - want) * (0.8 + 0.4 * r());
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    const take = takes[best];
    this.last[name] = take;
    // Louder the harder (compressed), and what the chosen take lacks in strength made up a little.
    const gain = spec.level * Math.sqrt(s) * (take.gain ?? 1) * this.preset.gain * this.level[part];
    const voice = { take, pos: 0, rate: (take.sampleRate / this.sr) * (1 + 0.08 * (r() - 0.5)), gain, pan };
    if (this.voices.length >= MAX_VOICES) {
      let q = 0;
      for (let k = 1; k < this.voices.length; k++) if (this.voices[k].gain < this.voices[q].gain) q = k;
      if (this.voices[q].gain > gain) return;
      this.voices[q] = voice;
    } else this.voices.push(voice);
  }

  // Adds the recorded sounds to outL/outR[start..end), from feed values a to b (as the synths).
  render(outL, outR, a, b, start = 0, end = outL.length, pos = CENTERED) {
    const n = end - start;
    if (n <= 0 || !this.bank) return;
    const L = this.preset.loops;
    const mid = (k) => ((a[k] ?? 0) + (b[k] ?? 0)) / 2;
    const rise = (key) => {
      const now = b[key] ?? 0;
      const last = this.counters[key];
      this.counters[key] = now;
      return last === undefined || now < last ? 0 : now - last;
    };

    // Rolling, sliding and spinning: summed over the wheels, heard where the wheels doing it are.
    const roll = {};
    const pans = {};
    const add = (name, amount, at, speedWeight) => {
      if (amount <= 0) return;
      roll[name] = (roll[name] ?? 0) + amount;
      const p = (pans[name] ??= { l: 0, r: 0, w: 0, speed: 0 });
      p.l += amount * at.l;
      p.r += amount * at.r;
      p.w += amount;
      p.speed += amount * speedWeight;
    };
    let bumps = 0;
    let bumpWheels = 0;
    for (let i = 0; i < WHEELS; i++) {
      const g = (f) => mid(`w${i}${f}`);
      const contact = g('contact');
      const speed = Math.max(g('ground'), Math.abs(g('roll')));
      const slip = Math.hypot(g('slipLong'), g('slipLat'));
      const press = contact * (0.4 + 0.6 * Math.min(1.5, g('load')));
      const rock = g('rock');
      const snow = g('snow');
      const gravel = g('gravel') * (1 - rock);
      const sand = g('sand') * (1 - rock - gravel);
      const dirt = Math.max(0, 1 - rock - gravel - sand - snow);
      const at = pos.wheels[i];
      const rolling = press * Math.min(1, speed / 1.5);
      // Sand without a recording of its own rolls as dirt, dirt as sand, snow as dirt.
      const dirtAs = this.loops['roll-dirt'] ? 'roll-dirt' : 'roll-sand';
      add('roll-gravel', rolling * gravel, at, speed);
      add('roll-rock', rolling * rock, at, speed);
      add(this.loops['roll-snow'] ? 'roll-snow' : dirtAs, rolling * snow, at, speed);
      add(dirtAs, rolling * dirt, at, speed);
      add(this.loops['roll-sand'] ? 'roll-sand' : dirtAs, rolling * sand, at, speed);
      const loose = gravel + dirt + sand + snow;
      add('slide', press * loose * smoothstep(L.slide.from, L.slide.full, slip), at, slip);
      add('squeal', press * rock * smoothstep(L.squeal.from, L.squeal.full, slip), at, slip);
      add('spin', press * loose * smoothstep(L.spin.from, L.spin.full, Math.abs(g('slipLong'))), at, Math.abs(g('slipLong')));

      this.hit('tyre-hit', rise(`w${i}impact`), at, 'ground');
      const bump = rise(`w${i}bump`);
      if (bump > 0) {
        bumps += bump;
        bumpWheels++;
      }
      this.hit('bump', bump, at, 'ground');
      this.hit('top-out', rise(`w${i}topOut`), at, 'ground');
      this.hit('rim', rise(`w${i}rim`), at, 'ground');
    }
    // A landing: two or more wheels into their bump stops in the same block.
    if (bumpWheels >= 2) this.hit('landing', bumps, pos.body, 'ground');
    this.hit('chassis-hit', rise('chassisHits'), pos.body, 'ground');
    this.hit('clunk', rise('clunks'), pos.body, 'car');
    const twist = mid('twist');
    // Creaks: now and then while the chassis twists, more often the harder.
    const creak = this.preset.oneshots.creak;
    if (twist > creak.from && this.random() < (n / this.sr) * 2 * smoothstep(creak.from, creak.full, twist)) this.hit('creak', twist, pos.body, 'car');
    const speed = Math.abs(mid('speed'));
    add('scrape', Math.sqrt(Math.min(2, mid('chassisForce'))) * Math.min(1, speed / L.scrape.full), pos.body, 1);
    add('rattle', smoothstep(L.rattle.from, L.rattle.full, mid('heave')), pos.body, 1);

    // Stones due in this block.
    for (let e = this.pending.length - 1; e >= 0; e--) {
      const ev = this.pending[e];
      if (ev.at >= this.clock + n) continue;
      this.hit(ev.name, ev.strength, ev.name === 'stone-hit' ? pos.body : pos.wheels[(this.random() * WHEELS) | 0], 'ground');
      this.pending.splice(e, 1);
    }
    this.clock += n;

    // The loops.
    const gain = this.preset.gain;
    for (const [name, voice] of Object.entries(this.loops)) {
      const spec = L[name];
      if (!spec) continue;
      const part = name === 'rattle' ? 'car' : 'ground';
      const amount = roll[name] ?? 0;
      const p = pans[name];
      let target = 0;
      let rate = voice.rate;
      if (amount > 0) {
        const s = p.speed / p.w; // the weighted speed (or slip) of the wheels doing it
        const rolling = name.startsWith('roll-');
        // Rolling: louder and higher with speed (rate ∝ √speed, from 0.7 to 1.3); the rest at their
        // own rate, louder with the amount (summed over the wheels, so averaged).
        const f = rolling ? Math.sqrt(Math.max(0.05, s / spec.speed)) : 1;
        rate = rolling ? Math.min(1.3, Math.max(0.7, f)) : 1;
        // (A wheel sound's amount is summed over the wheels: all four at full is 1.)
        const body = name === 'scrape' || name === 'rattle';
        target = spec.level * Math.min(1.5, body ? amount : amount / WHEELS) * (rolling ? Math.min(1.2, f) : 1) * (voice.take.gain ?? 1) * gain * this.level[part];
        voice.pan = { l: p.l / p.w, r: p.r / p.w };
      }
      const from = voice.gain;
      if (from === 0 && target === 0) continue;
      const take = voice.take;
      const len = take.data.length;
      const step = (take.sampleRate / this.sr) * rate;
      let posn = voice.pos;
      const pl = voice.pan.l;
      const pr = voice.pan.r;
      for (let j = 0; j < n; j++) {
        const g = from + (target - from) * (j / n);
        const x = loopAt(take.data, len, posn) * g;
        outL[start + j] += x * pl;
        outR[start + j] += x * pr;
        posn += step;
        if (posn >= len) posn -= len;
      }
      voice.pos = posn;
      voice.gain = target;
      voice.rate = rate;
    }

    // The one-shots.
    for (let v = this.voices.length - 1; v >= 0; v--) {
      const voice = this.voices[v];
      const data = voice.take.data;
      let posn = voice.pos;
      for (let j = 0; j < n; j++) {
        const i = posn | 0;
        if (i + 1 >= data.length) break;
        const f = posn - i;
        const x = (data[i] + (data[i + 1] - data[i]) * f) * voice.gain;
        outL[start + j] += x * voice.pan.l;
        outR[start + j] += x * voice.pan.r;
        posn += voice.rate;
      }
      voice.pos = posn;
      if (posn + 1 >= data.length) this.voices.splice(v, 1);
    }
  }
}
