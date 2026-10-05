// Engine sound from recordings: loops of a real engine held at steady rpm, on load (pulling) and off
// load (coasting), as racing games do it (Forza, Assetto Corsa, BeamNG). Pure maths like
// engine-synth.js, with the same render(): the audio worklet plays it in place of the synth once
// the bank is loaded, and tests and scripts render it offline.
//
// Each loop is played at rpm / its recorded rpm, so its firing tone follows the engine. The two
// loops either side of the rpm are mixed with equal-power gains (cos/sin, so the level does not dip
// between them), and so are the on- and off-load sets by the engine's load (its fuel). Every loop
// keeps its place while silent, so one coming back in starts where it would have been: no click.
// A loop's read position wraps from its end back to its start; the seam is blended offline
// (scripts/samples/), so the wrap is smooth. Samples between read positions are interpolated with a
// cubic (Hermite): the browsers' own playbackRate interpolates linearly, which aliases.
//
// A bank: { name, loops: [{ rpm, load: 'on' | 'off', data: Float32Array, sampleRate,
// loopStart, loopEnd, gain }] }, loop points in samples (see audio/sample-bank.js).

// Load from fuel: the idle governor's little fuel is still off load.
const LOAD_FROM = 0.12;
const LOAD_FULL = 0.45;
const LOAD_TIME = 0.06; // s, the load's smoothing (the fuel steps when the clutch takes up)

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The loop at a fractional position (Hermite, 4 points), wrapping inside [start, end).
function sampleAt(data, pos, start, end) {
  const i = Math.floor(pos);
  const f = pos - i;
  const len = end - start;
  const at = (k) => data[k < start ? k + len : k >= end ? k - len : k];
  const xm1 = at(i - 1);
  const x0 = data[i];
  const x1 = at(i + 1);
  const x2 = at(i + 2);
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

// Equal-power gains for the loops of one set at this rpm, into `gains` (by index into `set`).
export function rpmGains(set, rpm, gains) {
  gains.fill(0);
  const n = set.length;
  if (n === 0) return gains;
  if (rpm <= set[0].rpm) gains[0] = 1;
  else if (rpm >= set[n - 1].rpm) gains[n - 1] = 1;
  else {
    let i = 0;
    while (set[i + 1].rpm < rpm) i++;
    const x = (rpm - set[i].rpm) / (set[i + 1].rpm - set[i].rpm);
    gains[i] = Math.cos((x * Math.PI) / 2);
    gains[i + 1] = Math.sin((x * Math.PI) / 2);
  }
  return gains;
}

export class SampleEngine {
  constructor(sampleRate, bank = null) {
    this.sr = sampleRate;
    this.mix = { engine: 1 };
    this.load = 0;
    this.setBank(bank);
  }

  setBank(bank) {
    this.bank = bank;
    const sets = { on: [], off: [] };
    for (const loop of bank?.loops ?? []) (sets[loop.load] ?? sets.on).push(loop);
    for (const s of Object.values(sets)) s.sort((a, b) => a.rpm - b.rpm);
    // With one set only, it plays at every load (as the on-load set).
    if (!sets.on.length) [sets.on, sets.off] = [sets.off, sets.on];
    this.oneSet = !sets.off.length;
    this.sets = sets;
    // A voice per loop: its read position and its gain at the end of the last block.
    this.voices = new Map();
    for (const loop of new Set([...sets.on, ...sets.off])) this.voices.set(loop, { pos: loop.loopStart ?? 0, gain: 0 });
    this.gains = { on: new Float64Array(sets.on.length), off: new Float64Array(sets.off.length) };
    this.targets = new Map();
  }

  get ready() {
    return this.voices.size > 0;
  }

  setMix(mix) {
    Object.assign(this.mix, mix);
  }

  setLayers() {}

  setPreset() {}

  // Renders out[start..end) with the engine state moving from `a` to `b` ({ rpm, fuel, … }), as
  // EngineSynth.render. The gains move linearly over the block; the pitch follows the rpm per sample.
  render(out, a, b, start = 0, end = out.length) {
    const n = end - start;
    if (n <= 0) return;
    out.fill(0, start, end);
    if (!this.ready) return;
    const dt = n / this.sr;
    const fuel = ((a.fuel ?? 0) + (b.fuel ?? 0)) / 2;
    this.load += (smoothstep(LOAD_FROM, LOAD_FULL, fuel) - this.load) * (1 - Math.exp(-dt / LOAD_TIME));
    const rpmMid = (a.rpm + b.rpm) / 2;
    const onLevel = this.oneSet ? 1 : Math.sin((this.load * Math.PI) / 2);
    const offLevel = this.oneSet ? 0 : Math.cos((this.load * Math.PI) / 2);
    const targets = this.targets;
    targets.clear();
    for (const [set, level] of [['on', onLevel], ['off', offLevel]]) {
      const loops = this.sets[set];
      const g = rpmGains(loops, rpmMid, this.gains[set]);
      for (let k = 0; k < loops.length; k++) targets.set(loops[k], (targets.get(loops[k]) ?? 0) + g[k] * level);
    }
    const level = (this.bank.gain ?? 1) * this.mix.engine;
    for (const [loop, voice] of this.voices) {
      const target = (targets.get(loop) ?? 0) * (loop.gain ?? 1) * level;
      const from = voice.gain;
      const start0 = loop.loopStart ?? 0;
      const end0 = loop.loopEnd ?? loop.data.length;
      const len = end0 - start0;
      const ratio = (loop.sampleRate ?? this.sr) / this.sr / loop.rpm;
      if (from === 0 && target === 0) {
        // Silent: only keep its place.
        voice.pos += ((a.rpm + b.rpm) / 2) * ratio * n;
        voice.pos = start0 + ((((voice.pos - start0) % len) + len) % len);
        continue;
      }
      const data = loop.data;
      let pos = voice.pos;
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 1;
        const rpm = a.rpm + (b.rpm - a.rpm) * f;
        out[start + i] += sampleAt(data, pos, start0, end0) * (from + (target - from) * f);
        pos += rpm * ratio;
        if (pos >= end0) pos -= len;
      }
      voice.pos = pos;
      voice.gain = target;
    }
  }
}
