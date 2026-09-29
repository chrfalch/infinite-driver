import { loadSettings, saveSettings } from '../settings-store.js';

// Sound settings, persisted like the others (see settings-store.js). M toggles the sound.
export const AUDIO_KEY = 'drift.audio.v1';

export const DEFAULT_AUDIO = Object.freeze({
  enabled: true,
  volume: 0.8, // master
  // Levels in the engine sound, 1 = as tuned.
  engine: 1,
  turbo: 1,
  clatter: 1,
});

export const AUDIO = { ...DEFAULT_AUDIO };
for (const [key, value] of Object.entries(loadSettings(AUDIO_KEY))) {
  if (typeof value === typeof DEFAULT_AUDIO[key]) AUDIO[key] = value;
}

export function saveAudio() {
  saveSettings(AUDIO_KEY, DEFAULT_AUDIO, AUDIO);
}

export function resetAudio() {
  Object.assign(AUDIO, DEFAULT_AUDIO);
  saveAudio();
}

export const audioMix = () => ({ engine: AUDIO.engine, turbo: AUDIO.turbo, clatter: AUDIO.clatter });
