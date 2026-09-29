// The game's sound on the main thread: the AudioContext, the engine worklet, and the master level.
//
// Browsers start audio only from a user gesture, and iOS Safari is strict: the context is created
// and resumed inside the first tap, click or key press, and resumed again on any later gesture if
// the system stopped it (a phone call, the tab in the background: Safari's "interrupted" state).
// The sound is suspended while the tab is hidden. M toggles it.
//
// The engine worklet reads the physics steps from the shared audio feed (feed.js). If the browser
// cannot share memory with the audio thread, the worklet is driven from the main thread's copy of
// the drivetrain once per frame instead (update()).
import processorUrl from './engine-processor.js?worker&url';
import { onSettingsSaved } from '../settings-store.js';
import { AUDIO, AUDIO_KEY, audioMix, saveAudio } from './config.js';

const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'keydown'];
const FADE = 0.4; // s

// Keys typed into the tuning panel are not shortcuts (as tuning/panel.js isTyping, which this
// module does not import: the engine lab has no panel).
const isTyping = (e) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName) || e.target?.isContentEditable;

export function createAudio({ feed = null } = {}) {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const audio = { ctx: null, node: null, state: 'off', manual: !feed?.shared, update: () => {}, dispose: () => {} };
  if (!Context || typeof AudioWorkletNode === 'undefined') {
    audio.state = 'unsupported';
    return audio;
  }

  let ctx = null;
  let master = null;
  let node = null;
  let staleReports = 0;

  const level = () => (AUDIO.enabled ? AUDIO.volume : 0);
  const fadeTo = (value) => {
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(value, now + FADE);
  };

  async function load() {
    await ctx.audioWorklet.addModule(processorUrl);
    const options = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { mix: audioMix() } };
    try {
      node = new AudioWorkletNode(ctx, 'engine', { ...options, processorOptions: { ...options.processorOptions, feedBuffer: audio.manual ? null : feed.buffer } });
    } catch (error) {
      // The shared buffer could not be sent to the audio thread.
      console.warn('Engine sound: no shared memory with the audio thread, driving it per frame', error);
      audio.manual = true;
      node = new AudioWorkletNode(ctx, 'engine', options);
    }
    node.port.onmessage = (e) => {
      if (e.data.type !== 'status' || audio.manual || !feed) return;
      // The worklet sees no steps though physics writes them: its buffer is a copy, not shared.
      if (e.data.feedSteps === 0 && feed.written() > 0) staleReports++;
      else staleReports = 0;
      if (staleReports >= 2) {
        console.warn('Engine sound: the audio feed does not reach the audio thread, driving it per frame');
        audio.manual = true;
      }
    };
    node.connect(master);
    audio.node = node;
    audio.state = 'running';
    fadeTo(level());
  }

  // Called inside a user gesture.
  function unlock() {
    if (!AUDIO.enabled) return;
    if (!ctx) {
      // iOS: play through the ring/silent switch, like a game or a video (Safari 17+).
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch {
        // Not supported: the silent switch mutes the sound.
      }
      ctx = new Context({ latencyHint: 'interactive' });
      audio.ctx = ctx;
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
      // Older iOS unlocks the output only when something plays inside the gesture.
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      silent.connect(ctx.destination);
      silent.start();
      audio.state = 'loading';
      load().catch((error) => {
        audio.state = 'failed';
        console.warn('Engine sound failed to start', error);
      });
    }
    if (ctx.state !== 'running' && !document.hidden) ctx.resume().catch(() => {});
  }

  const onGesture = (e) => {
    if (e.type === 'keydown' && e.code === 'KeyM' && !e.repeat && !isTyping(e)) {
      AUDIO.enabled = !AUDIO.enabled;
      saveAudio(); // applies it (below)
    }
    unlock();
  };
  const apply = () => {
    if (!ctx) return;
    node?.port.postMessage({ type: 'mix', values: audioMix() });
    fadeTo(level());
    if (AUDIO.enabled && ctx.state !== 'running' && !document.hidden) ctx.resume().catch(() => {});
    if (!AUDIO.enabled) setTimeout(() => !AUDIO.enabled && ctx.state === 'running' && ctx.suspend().catch(() => {}), FADE * 1000 + 50);
  };
  const onVisibility = () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else if (AUDIO.enabled) ctx.resume().catch(() => {});
  };

  for (const type of GESTURES) window.addEventListener(type, onGesture, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  const unsubscribe = onSettingsSaved((key) => key === AUDIO_KEY && apply());

  // Per frame: only needed when the worklet cannot read the shared feed.
  audio.update = (vehicle) => {
    if (!audio.manual || !node || !vehicle?.drivetrain) return;
    const d = vehicle.drivetrain;
    node.port.postMessage({ type: 'manual', values: { rpm: d.rpm ?? 0, fuel: d.fuel ?? 0, exhaustBrake: d.exhaustBrake ?? 0, throttle: d.throttle ?? 0 } });
  };

  audio.dispose = () => {
    for (const type of GESTURES) window.removeEventListener(type, onGesture, { capture: true });
    document.removeEventListener('visibilitychange', onVisibility);
    unsubscribe();
    ctx?.close();
  };
  return audio;
}
