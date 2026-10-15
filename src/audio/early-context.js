// The sound's AudioContext, created inside the click (or key) that picks the world on the loading
// screen: browsers start audio only from such a gesture (iOS Safari only inside it), and the drive
// starts without another one once everything has loaded. audio.js takes it over when it starts.
// Light on purpose: start.js imports it before the game loads.
import { AUDIO } from './config.js';

let early = null;

// Called inside the gesture. Nothing plays until audio.js connects the engine to it.
export function startEarlyContext() {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const off = new URLSearchParams(globalThis.location?.search ?? '').get('sound') === '0';
  if (early || off || !AUDIO.enabled || !Context || typeof AudioWorkletNode === 'undefined' || !globalThis.isSecureContext) return;
  try {
    // iOS: play through the ring/silent switch, like a game or a video (Safari 17+).
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {
    // Not supported: the silent switch mutes the sound.
  }
  try {
    early = new Context({ latencyHint: 'interactive' });
    // Older iOS unlocks the output only when something plays inside the gesture.
    const silent = early.createBufferSource();
    silent.buffer = early.createBuffer(1, 1, early.sampleRate);
    silent.connect(early.destination);
    silent.start();
    if (early.state !== 'running') early.resume().catch(() => {});
  } catch (error) {
    console.warn('[sound] no context on the world pick, the sound starts on the next tap or key', error);
    early = null;
  }
}

// The context from the pick, once (null if there was none).
export function takeEarlyContext() {
  const context = early;
  early = null;
  return context;
}
