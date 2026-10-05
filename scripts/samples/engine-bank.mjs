// Builds a recorded engine's bank (src/audio/sample-engine.js) from recordings of a real engine:
//   node scripts/samples/engine-bank.mjs scripts/samples/engine-v8.json [--report]
//
// The spec (JSON) names the recordings and what is in each:
//   { name, out: 'public/audio/engine-v8', cylinders: 8, rpms: [800, 1100, …], loopSeconds: 1.2,
//     sources: [{ file, load: 'on' | 'off', from, to (s), minRpm, maxRpm, rpmScale, gain }] }
// Files are looked up in AUDIO_SRC (default: ../audio-src next to the repo's session folder, see
// SOURCE_DIR below) and decoded with ffmpeg. For every rpm in `rpms` and each load, the stretch of
// a recording that passes closest and most cleanly through that rpm is held at it (flatten: a rev
// becomes a steady rpm), cut to whole engine cycles and looped (makeLoop). The loops are written as
// FLAC (lossless: no encoder padding at the seam, and every browser decodes it) with manifest.json.
//
// rpmScale: the tracker follows the strongest tone; if a recording's tone is a half order (a V8's
// burble), 2 corrects it. --report prints each source's pitch track as rpm over time.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { flatten, makeLoop, rms, trackPitch } from './pitch.mjs';

const SR = 48000;
const ANALYSIS_SR = 12000;
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

const cyl = spec.cylinders ?? 8;
const toRpm = (f) => (f * 120) / cyl;
const toF = (rpm) => (rpm * cyl) / 120;

// Each source: its audio, its pitch track in rpm, and its level.
const sources = spec.sources.map((s) => {
  const file = join(SOURCE_DIR, s.file);
  const full = decode(file, SR, s.from, s.to);
  const low = decode(file, ANALYSIS_SR, s.from, s.to);
  const scale = s.rpmScale ?? 1;
  const minF = toF(s.minRpm ?? 600) / scale;
  const maxF = toF(s.maxRpm ?? 6500) / scale;
  const track = trackPitch(low, ANALYSIS_SR, { minF: minF * 0.9, maxF: maxF * 1.1 }).map((p) => ({ ...p, f: p.f * scale }));
  if (report) {
    console.log(`\n${s.file} (${s.load}):`);
    for (let i = 0; i < track.length; i += 25) console.log(`  ${track[i].t.toFixed(2)} s  ${Math.round(toRpm(track[i].f))} rpm  clarity ${track[i].clarity.toFixed(2)}`);
  }
  return { ...s, full, track, gain: s.gain ?? 1, level: rms(full) || 1 };
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
      if (dev > MAX_DEVIATION || clarity < 0.4) continue;
      const score = clarity - 2 * Math.abs(mean / f - 1) - dev;
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
// Each source's level evened out (its own variation with rpm kept), then its gain.
const median = [...sources.map((s) => s.level)].sort((a, b) => a - b)[Math.floor(sources.length / 2)];
for (const load of ['on', 'off']) {
  for (const rpm of spec.rpms) {
    const pick = bestStretch(rpm, load, seconds + fade + 0.05);
    if (!pick) {
      console.log(`${load} ${rpm} rpm: no clean stretch`);
      continue;
    }
    const f = toF(rpm);
    const flat = flatten(pick.source.full, SR, pick.source.track.map((p) => ({ t: p.t, f: p.f })), pick.t0, f, seconds + fade + 0.05);
    const cycles = Math.max(1, Math.floor((seconds * f) / (cyl / 2)));
    const loop = makeLoop(flat, SR, f, { perCycle: cyl / 2, cycles, fade });
    const gain = (pick.source.gain * median) / pick.source.level;
    for (let i = 0; i < loop.length; i++) loop[i] *= gain;
    const file = `${load}-${rpm}.flac`;
    encodeFlac(loop, join(out, file));
    loops.push({ file, rpm, load, loopStart: 0, loopEnd: loop.length / SR, gain: 1 });
    console.log(`${load} ${rpm} rpm: ${pick.source.file} at ${pick.t0.toFixed(2)} s, pitch within ${(pick.dev * 100).toFixed(1)} %, clarity ${pick.clarity.toFixed(2)}, ${(loop.length / SR).toFixed(2)} s`);
  }
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ name: spec.name, gain: spec.gain ?? 1, loops }, null, 2)}\n`);
console.log(`${loops.length} loops in ${out}`);
