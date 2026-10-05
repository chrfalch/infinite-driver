// Loads a bank of recordings on the main thread for the audio worklet (sample-engine.js).
//
// A bank is a folder under public/audio/ with a manifest.json, made by scripts/samples/:
//   { name, gain, loops: [{ file, rpm, load: 'on' | 'off', loopStart, loopEnd, gain }] }
// loop points in seconds (the browser decodes at its own sample rate, so samples would not do).
// Each file is decoded, mixed down to mono, and sent to the worklet with its buffer transferred.

const base = () => (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';

// Mono from a decoded AudioBuffer (or anything with numberOfChannels and getChannelData).
export function mono(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / channels;
  }
  return out;
}

// A manifest's loops with their audio, as sample-engine.js plays them; decode(arrayBuffer) gives
// an AudioBuffer-like { sampleRate, length, numberOfChannels, getChannelData }.
export async function loadBank(path, decode, fetchFn = fetch) {
  const url = `${base()}${path}/`;
  const res = await fetchFn(`${url}manifest.json`);
  if (!res.ok) throw new Error(`${path}: manifest ${res.status}`);
  const manifest = await res.json();
  const loops = await Promise.all(
    manifest.loops.map(async (entry) => {
      const r = await fetchFn(url + entry.file);
      if (!r.ok) throw new Error(`${entry.file}: ${r.status}`);
      const decoded = await decode(await r.arrayBuffer());
      const data = mono(decoded);
      const sr = decoded.sampleRate;
      const loopStart = Math.max(0, Math.round((entry.loopStart ?? 0) * sr));
      const loopEnd = Math.min(data.length, entry.loopEnd ? Math.round(entry.loopEnd * sr) : data.length);
      return { rpm: entry.rpm, load: entry.load ?? 'on', gain: entry.gain ?? 1, data, sampleRate: sr, loopStart, loopEnd };
    }),
  );
  return { name: manifest.name ?? path, gain: manifest.gain ?? 1, loops };
}

// The buffers to transfer with a bank.
export const bankTransfer = (bank) => bank.loops.map((l) => l.data.buffer);
