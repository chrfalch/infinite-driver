// Builds a recorded engine's bank (src/audio/sample-engine.js) from recordings of a real engine:
//   node scripts/samples/engine-bank.mjs scripts/samples/engine-v8.json [--report]
//
// The spec (JSON) names the recordings and what is in each:
//   { name, out: 'public/audio/engine-v8', cylinders: 8, rpms: [800, 1100, …], loopSeconds: 1.2,
//     sources: [{ file, load: 'on' | 'off', from, to (s), minRpm, maxRpm, window, rpmScale, gain (dB) }],
//     levels: { on: -20, off: -24, rise: 6 } (dB RMS: see below) }
// minClarity (0.4), maxDeviation (0.08), prefer (a bonus to the score: this source first).
// window: the analysis window (s; 0.5 by default): an idle's orders lie only ~7 Hz apart, so 2.
// Files are looked up in AUDIO_SRC (default: ../audio-src next to the repo's session folder, see
// SOURCE_DIR below) and decoded with ffmpeg. For every rpm in `rpms` and each load, the stretch of
// a recording that passes closest and most cleanly through that rpm is held at it (flatten: a rev
// becomes a steady rpm), cut to whole engine cycles and looped (makeLoop). The loops are written as
// FLAC (lossless: no encoder padding at the seam, and every browser decodes it) with manifest.json.
//
// rpmScale corrects a recording whose speed the order tracker gets wrong by a factor (it should
// not). --report prints each source's track as rpm over time.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { flatten, makeLoop, rms, trackOrders } from './pitch.mjs';

const SR = 48000;
const ANALYSIS_SR = 4000; // the orders up to 1.5 kHz are enough to follow the engine
const MAX_DEVIATION = 0.08; // the most a stretch's pitch may move around its rpm (flatten shifts timbre)

const specPath = resolve(process.argv[2] ?? 'scripts/samples/engine-v8.json');
const report = process.argv.includes('--report');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const SOURCE_DIR = process.env.AUDIO_SRC ?? resolve(dirname(specPath), spec.sourceDir ?? '.');

function decode(file, sr, from, to) {
  const args = ['-v', 'error'];
  if (from) args.push('-ss', String(from));
  if (to) args.push('-to', String(to));
  args.push('-i', file, '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-');
  const buf = execFileSync('ffmpeg', args, { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
}

function encodeFlac(data, path) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', '-', '-sample_fmt', 's32', '-c:a', 'flac', path], {
    input: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
  });
}

// A loop through sox's equalisers (a loop stays a loop: filtered twice over and the second pass
// kept, so the filters' start-up does not land at the seam).
function offLoad(loop) {
  const twice = new Float32Array(loop.length * 2);
  twice.set(loop);
  twice.set(loop, loop.length);
  // Through files: sox stops reading a pipe from node after its first 64 kB.
  const dir = mkdtempSync(join(tmpdir(), 'off-load-'));
  const raw = ['-t', 'raw', '-e', 'floating-point', '-b', '32', '-r', String(SR), '-c', '1'];
  writeFileSync(join(dir, 'in.raw'), Buffer.from(twice.buffer));
  execFileSync('sox', [...raw, join(dir, 'in.raw'), ...raw, join(dir, 'out.raw'), 'equalizer', '350', '1.2q', '-4', 'equalizer', '2000', '1q', '-5', 'equalizer', '9000', '1q', '-6']);
  const buf = readFileSync(join(dir, 'out.raw'));
  rmSync(dir, { recursive: true });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice(loop.length, loop.length * 2);
}

const cyl = spec.cylinders ?? 8;
const toRpm = (f) => (f * 120) / cyl;
const toF = (rpm) => (rpm * cyl) / 120;

// Each source: its audio, its pitch track in rpm, and its level.
const sources = spec.sources.map((s) => {
  const file = join(SOURCE_DIR, s.file);
  const full = decode(file, SR, s.from, s.to);
  const low = decode(file, ANALYSIS_SR, s.from, s.to);
  const scale = s.rpmScale ?? 1;
  const track = trackOrders(low, ANALYSIS_SR, { minRpm: (s.minRpm ?? 500) / scale, maxRpm: (s.maxRpm ?? 7000) / scale, cylinders: cyl, window: s.window ?? 0.5 }).map((p) => ({ ...p, f: p.f * scale }));
  if (report) {
    console.log(`\n${s.file} (${s.load}):`);
    for (let i = 0; i < track.length; i += 50) console.log(`  ${track[i].t.toFixed(2)} s  ${Math.round(toRpm(track[i].f))} rpm  clarity ${track[i].clarity.toFixed(2)}`);
  }
  return { ...s, full, track, gain: 10 ** ((s.gain ?? 0) / 20) };
});
if (report) process.exit(0);

// The best stretch of any source with this load through `rpm`: { source, t0, score }.
function bestStretch(rpm, load, seconds) {
  const f = toF(rpm);
  let best = null;
  for (const s of sources.filter((x) => x.load === load)) {
    const tr = s.track;
    const hop = tr.length > 1 ? tr[1].t - tr[0].t : 0.01;
    const frames = Math.ceil(seconds / hop);
    for (let i = 0; i + frames < tr.length; i++) {
      // The stretch starting here, centred on the rpm: its frames' pitch and clarity.
      let dev = 0;
      let clarity = 0;
      let mean = 0;
      for (let k = i; k < i + frames; k++) {
        dev = Math.max(dev, Math.abs(tr[k].f / f - 1));
        clarity += tr[k].clarity;
        mean += tr[k].f;
      }
      clarity /= frames;
      mean /= frames;
      if (dev > (s.maxDeviation ?? MAX_DEVIATION) || clarity < (s.minClarity ?? 0.4)) continue;
      const score = clarity - 2 * Math.abs(mean / f - 1) - dev + (s.prefer ?? 0);
      if (!best || score > best.score) best = { source: s, t0: tr[i].t - 0.5 * hop, score, dev, clarity };
    }
  }
  return best;
}

const out = resolve(spec.out ?? 'public/audio/engine-v8');
mkdirSync(out, { recursive: true });
const seconds = spec.loopSeconds ?? 1.2;
const fade = spec.fadeSeconds ?? 0.04;
const loops = [];
// Every loop is set to one level curve, as the recordings' own levels (mic distance, gain) say
// little about the engine: louder with rpm (+6 dB idle to the top), the off-load set quieter
// (dB, spec.levels), then the source's gain (dB). The peaks stay under -1 dBFS.
const levels = { on: -20, off: -24, rise: 6, ...spec.levels };
const top = Math.max(...spec.rpms);
const bottom = Math.min(...spec.rpms);
const PEAK = 10 ** (-1 / 20);
const made = { on: new Map(), off: new Map() };
for (const load of ['on', 'off']) {
  for (const rpm of spec.rpms) {
    const pick = bestStretch(rpm, load, seconds + fade + 0.05);
    if (!pick && load === 'off' && made.on.has(rpm)) {
      // No coasting recording at this rpm: the pulling loop made to sound off load, as Caviezel
      // suggests (Boom Library's engine primer): quieter, the low mids and the bark at 2 kHz and the
      // fizz at 10 kHz cut.
      const derived = offLoad(made.on.get(rpm));
      const file = `off-${rpm}.flac`;
      const db = levels.off + (levels.rise * (rpm - bottom)) / (top - bottom);
      const g = 10 ** (db / 20) / (rms(derived) || 1);
      for (let i = 0; i < derived.length; i++) derived[i] *= g;
      encodeFlac(derived, join(out, file));
      loops.push({ file, rpm, load, loopStart: 0, loopEnd: derived.length / SR, gain: 1 });
      console.log(`off ${rpm} rpm: from the on-load loop (no coasting recording)`);
      continue;
    }
    if (!pick) {
      console.log(`${load} ${rpm} rpm: no clean stretch`);
      continue;
    }
    const f = toF(rpm);
    const flat = flatten(pick.source.full, SR, pick.source.track.map((p) => ({ t: p.t, f: p.f })), pick.t0, f, seconds + fade + 0.05);
    const cycles = Math.max(1, Math.floor((seconds * f) / (cyl / 2)));
    const loop = makeLoop(flat, SR, f, { perCycle: cyl / 2, cycles, fade });
    const db = levels[load] + (levels.rise * (rpm - bottom)) / (top - bottom) + 20 * Math.log10(pick.source.gain);
    let gain = 10 ** (db / 20) / (rms(loop) || 1);
    let peak = 0;
    for (let i = 0; i < loop.length; i++) peak = Math.max(peak, Math.abs(loop[i]));
    gain = Math.min(gain, PEAK / (peak || 1));
    for (let i = 0; i < loop.length; i++) loop[i] *= gain;
    made[load].set(rpm, loop);
    const file = `${load}-${rpm}.flac`;
    encodeFlac(loop, join(out, file));
    loops.push({ file, rpm, load, loopStart: 0, loopEnd: loop.length / SR, gain: 1 });
    console.log(`${load} ${rpm} rpm: ${pick.source.file} at ${pick.t0.toFixed(2)} s, pitch within ${(pick.dev * 100).toFixed(1)} %, clarity ${pick.clarity.toFixed(2)}, ${(loop.length / SR).toFixed(2)} s`);
  }
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ name: spec.name, gain: spec.gain ?? 1, loops }, null, 2)}\n`);
console.log(`${loops.length} loops in ${out}`);
