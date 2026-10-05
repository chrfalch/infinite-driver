// Builds the recorded tyre, ground and car sounds' bank (src/audio/foley.js) from recordings:
//   node scripts/samples/foley-bank.mjs scripts/samples/foley.json
//
// The spec (JSON):
//   { out: 'public/audio/foley', sourceDir,
//     loops: { name: [{ file, from, to, gain (dB), highpass (Hz) } | { parts: [{ file, from, to }], gain }] },
//     oneshots: { name: [{ file, from, to, gain (dB) } | { file, from, to, detect: { count, gap (s) } }] } }
// Loops: the stretch from..to, its end blended into its start over FADE s, set to LOOP_DB RMS (+
// gain). One-shots: a hit from..to, or `count` hits found in from..to (the loudest onsets at
// least `gap` apart); each cut from just before its onset until it has died away (30 dB below its
// peak, at most MAX_HIT s), faded in and out. A name's takes keep their loudness relative to each
// other: the loudest peaks at HIT_DB, and each take's strength is its peak against that one's
// (foley.js plays the take nearest a hit's strength). Written as FLAC with manifest.json.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const SR = 48000;
const FADE = 0.25; // s, a loop's seam (noise-like sounds blend over a long one without a lump)
const LOOP_DB = -20;
const HIT_DB = -3;
const MAX_HIT = 1.5; // s

const specPath = resolve(process.argv[2] ?? 'scripts/samples/foley.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const SOURCE_DIR = process.env.AUDIO_SRC ?? resolve(dirname(specPath), spec.sourceDir ?? '.');

// A file named in full, or by the start of its name (its source id) in its folder: 'rolling/fs848759'.
function resolveFile(file) {
  const full = join(SOURCE_DIR, file);
  if (existsSync(full)) return full;
  const dir = dirname(full);
  const match = readdirSync(dir).find((f) => f.startsWith(basename(file)) && f.endsWith('.48k.wav'));
  if (!match) throw new Error(`no recording ${file}`);
  return join(dir, match);
}

function decode(file, from, to, highpass) {
  const args = ['-v', 'error'];
  if (from) args.push('-ss', String(from));
  if (to) args.push('-to', String(to));
  args.push('-i', resolveFile(file), '-ac', '1', '-ar', String(SR));
  if (highpass) args.push('-af', `highpass=f=${highpass}`);
  args.push('-f', 'f32le', '-');
  const buf = execFileSync('ffmpeg', args, { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
}

function encodeFlac(data, path) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', '-', '-sample_fmt', 's16', '-c:a', 'flac', path], {
    input: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
  });
}

const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / (x.length || 1));
const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

// The stretch looped: its last FADE s blended (equal power) into its start.
export function loopOf(x) {
  const f = Math.min(Math.round(FADE * SR), Math.floor(x.length / 4));
  const len = x.length - f;
  const out = x.slice(0, len);
  for (let i = 0; i < f; i++) {
    const u = (i / f) * (Math.PI / 2);
    out[i] = x[i] * Math.sin(u) + x[len + i] * Math.cos(u);
  }
  return out;
}

// A 5 ms RMS envelope.
function envelope(x) {
  const w = Math.round(0.005 * SR);
  const env = new Float32Array(Math.ceil(x.length / w));
  for (let k = 0; k < env.length; k++) {
    let s = 0;
    for (let i = k * w; i < Math.min(x.length, (k + 1) * w); i++) s += x[i] * x[i];
    env[k] = Math.sqrt(s / w);
  }
  return { env, w };
}

// The `count` strongest onsets (sharp rises of the envelope) at least `gap` s apart: sample indices.
function onsets(x, count, gap) {
  const { env, w } = envelope(x);
  const rises = [];
  for (let k = 2; k < env.length; k++) {
    const before = Math.max(env[k - 2], 1e-6);
    if (env[k] > 2 * before && env[k] >= env[k - 1]) rises.push({ k, strength: env[k] - before });
  }
  rises.sort((a, b) => b.strength - a.strength);
  const picked = [];
  for (const r of rises) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(p - r.k) * w > gap * SR)) picked.push(r.k);
  }
  return picked.sort((a, b) => a - b).map((k) => Math.max(0, (k - 2) * w));
}

// A hit from `at`: until 30 dB under its peak (or the next onset, or MAX_HIT), faded in and out.
function cutHit(x, at, until = x.length) {
  const { env, w } = envelope(x.subarray(at, Math.min(until, at + MAX_HIT * SR)));
  let top = 0;
  for (let k = 0; k < env.length; k++) top = Math.max(top, env[k]);
  let end = env.length;
  let k = 0;
  while (k < env.length && env[k] < top) k++;
  for (; k < env.length; k++)
    if (env[k] < top * 0.03) {
      end = k;
      break;
    }
  const out = x.slice(at, at + end * w);
  const fin = Math.min(out.length, Math.round(0.002 * SR));
  const fout = Math.min(out.length, Math.round(0.03 * SR));
  for (let i = 0; i < fin; i++) out[i] *= i / fin;
  for (let i = 0; i < fout; i++) out[out.length - 1 - i] *= i / fout;
  return out;
}

const out = resolve(spec.out ?? 'public/audio/foley');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const manifest = { loops: {}, oneshots: {} };

// Short stretches strung together (each to the same level, blended into the next over JOIN s):
// one long take, so a short sound does not repeat every second.
const JOIN = 0.15;
function join_(parts) {
  const xs = parts.map((p) => {
    const x = decode(p.file, p.from, p.to, p.highpass ?? 30);
    const g = 1 / (rms(x) || 1);
    for (let k = 0; k < x.length; k++) x[k] *= g;
    return x;
  });
  const f = Math.round(JOIN * SR);
  let out = xs[0];
  for (const x of xs.slice(1)) {
    const next = new Float32Array(out.length + x.length - f);
    next.set(out);
    for (let i = 0; i < x.length; i++) {
      const k = out.length - f + i;
      if (i < f) {
        const u = (i / f) * (Math.PI / 2);
        next[k] = out[k] * Math.cos(u) + x[i] * Math.sin(u);
      } else next[k] = x[i];
    }
    out = next;
  }
  return out;
}

for (const [name, takes] of Object.entries(spec.loops ?? {})) {
  manifest.loops[name] = takes.map((t, i) => {
    const loop = loopOf(t.parts ? join_(t.parts) : decode(t.file, t.from, t.to, t.highpass ?? 30));
    // To its level, but never past -1 dBFS (a crackly stretch peaks far above its RMS).
    const g = Math.min(10 ** ((LOOP_DB + (t.gain ?? 0)) / 20) / (rms(loop) || 1), 10 ** (-1 / 20) / (peak(loop) || 1));
    for (let k = 0; k < loop.length; k++) loop[k] *= g;
    const file = `${name}-${i}.flac`;
    encodeFlac(loop, join(out, file));
    console.log(`loop ${file}: ${(loop.length / SR).toFixed(2)} s from ${t.parts ? `${t.parts.length} parts` : `${t.file} ${t.from ?? 0}-${t.to ?? 'end'} s`}, peak ${(20 * Math.log10(peak(loop))).toFixed(1)} dBFS`);
    return { file, gain: 1 };
  });
}

for (const [name, takes] of Object.entries(spec.oneshots ?? {})) {
  const hits = [];
  for (const t of takes) {
    const x = decode(t.file, t.from, t.to, t.highpass ?? 20);
    const extra = 10 ** ((t.gain ?? 0) / 20);
    if (t.detect) {
      const at = onsets(x, t.detect.count ?? 6, t.detect.gap ?? 0.3);
      at.forEach((a, k) => hits.push({ data: cutHit(x, a, at[k + 1]), extra, from: (t.from ?? 0) + a / SR, file: t.file }));
    } else hits.push({ data: cutHit(x, 0), extra, from: t.from ?? 0, file: t.file });
  }
  for (const h of hits) for (let k = 0; k < h.data.length; k++) h.data[k] *= h.extra;
  const loudest = Math.max(...hits.map((h) => peak(h.data))) || 1;
  const g = 10 ** (HIT_DB / 20) / loudest;
  manifest.oneshots[name] = hits.map((h, i) => {
    for (let k = 0; k < h.data.length; k++) h.data[k] *= g;
    const strength = Math.round((peak(h.data) / 10 ** (HIT_DB / 20)) * 100) / 100;
    const file = `${name}-${i}.flac`;
    encodeFlac(h.data, join(out, file));
    console.log(`hit ${file}: ${(h.data.length / SR).toFixed(2)} s, strength ${strength}, from ${h.file} at ${h.from.toFixed(2)} s`);
    return { file, strength, gain: 1 };
  });
}

writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${Object.keys(manifest.loops).length} loops, ${Object.keys(manifest.oneshots).length} hits in ${out}`);
