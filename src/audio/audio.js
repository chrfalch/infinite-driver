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
import { ENGINE_PRESETS, TURBO_DIESEL_V8 } from './engine-presets.js';

// The engine sound picked in the settings.
export const currentPreset = () => ENGINE_PRESETS[AUDIO.engineType] ?? TURBO_DIESEL_V8;

// Safari starts audio only from some of these (click, mouseup, keyup, touchend), Chrome from
// others (pointerdown, mousedown, keydown); all of them try.
const GESTURES = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchend', 'keydown', 'keyup'];
const FADE = 0.4; // s

// Keys typed into the tuning panel are not shortcuts (as tuning/panel.js isTyping, which this
// module does not import: the engine lab has no panel).
const isTyping = (e) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName) || e.target?.isContentEditable;

// A small button that shows the sound's state and starts it (a click is a gesture every browser
// accepts), or mutes it once it plays. It shows why when the sound cannot start.
function createSoundButton(audio) {
  const button = document.createElement('button');
  button.className = 'sound-button';
  button.style.cssText =
    'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:20;padding:6px 12px;border:0;border-radius:14px;' +
    'background:rgba(40,34,24,0.72);color:#fff;font:600 12px/1.2 system-ui,sans-serif;cursor:pointer;max-width:80vw;';
  document.body.append(button);
  button.addEventListener('click', () => {
    // Off: on again. Playing: off. Otherwise (not started, or stopped by the browser): start.
    const playing = audio.state === 'running' && audio.ctx?.state === 'running';
    if (!AUDIO.enabled || playing) {
      AUDIO.enabled = !AUDIO.enabled;
      saveAudio();
    }
    audio.unlock();
  });
  let shownSince = performance.now();
  let last = '';
  const refresh = () => {
    const ctxState = audio.ctx?.state;
    let label;
    if (audio.state === 'unsupported') label = 'No Web Audio in this browser';
    else if (audio.state === 'failed') label = `Sound failed: ${audio.error ?? 'unknown error'} (click to retry)`;
    else if (!AUDIO.enabled) label = '🔇 Sound off (M)';
    else if (audio.state === 'off') label = '🔈 Click for sound';
    else if (audio.state === 'loading') label = '🔈 Starting sound…';
    else if (ctxState !== 'running') label = `🔈 Sound ${ctxState} — click to start`;
    else label = '🔊 Sound on (M)';
    if (label !== last) {
      last = label;
      button.textContent = label;
      shownSince = performance.now();
    }
    // Out of the way once it plays.
    button.style.opacity = label.startsWith('🔊') && performance.now() - shownSince > 3000 ? '0.35' : '1';
  };
  refresh();
  const timer = setInterval(refresh, 300);
  return () => {
    clearInterval(timer);
    button.remove();
  };
}

export function createAudio({ feed = null, preset = null, button = true } = {}) {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  // preset: a fixed engine preset (the engine lab); otherwise the one picked in the settings.
  const audio = { ctx: null, node: null, state: 'off', manual: !feed?.shared, preset, update: () => {}, dispose: () => {} };
  audio.unlock = () => {};
  const removeButton = button && typeof document !== 'undefined' ? createSoundButton(audio) : () => {};
  if (!Context || typeof AudioWorkletNode === 'undefined' || !globalThis.isSecureContext) {
    audio.state = 'unsupported';
    console.warn('[sound] unsupported:', { AudioContext: !!Context, AudioWorkletNode: typeof AudioWorkletNode !== 'undefined', secure: globalThis.isSecureContext });
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

  // Each step of starting the sound is logged, so a browser that stays silent shows where it stopped.
  const log = (...args) => console.info('[sound]', ...args);

  async function load() {
    log('loading the engine worklet', processorUrl);
    await ctx.audioWorklet.addModule(processorUrl);
    log('worklet loaded');
    const options = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { mix: audioMix(), preset: audio.preset ?? currentPreset() } };
    try {
      node = new AudioWorkletNode(ctx, 'engine', { ...options, processorOptions: { ...options.processorOptions, feedBuffer: audio.manual ? null : feed.buffer } });
    } catch (error) {
      // The shared buffer could not be sent to the audio thread.
      console.warn('Engine sound: no shared memory with the audio thread, driving it per frame', error);
      audio.manual = true;
      node = new AudioWorkletNode(ctx, 'engine', options);
    }
    node.port.onmessage = (e) => {
      if (e.data.type === 'status') audio.status = e.data;
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
    log('engine playing:', (audio.preset ?? currentPreset()).name, audio.manual ? '(per frame)' : '(shared feed)', 'context', ctx.state, ctx.sampleRate, 'Hz');
    fadeTo(level());
  }

  // Called inside a user gesture.
  function unlock() {
    if (!AUDIO.enabled) return;
    // After a failure, start over on the next gesture.
    if (audio.state === 'failed') {
      ctx?.close().catch(() => {});
      ctx = null;
    }
    if (!ctx) {
      // iOS: play through the ring/silent switch, like a game or a video (Safari 17+).
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch {
        // Not supported: the silent switch mutes the sound.
      }
      ctx = new Context({ latencyHint: 'interactive' });
      audio.ctx = ctx;
      log('context created on', lastGesture, '- state', ctx.state);
      ctx.onstatechange = () => log('context state', ctx.state);
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
        audio.error = String(error?.message ?? error);
        console.warn('Engine sound failed to start', error);
      });
    }
    if (ctx.state !== 'running' && !document.hidden) {
      ctx.resume().then(
        () => log('resumed on', lastGesture, '- state', ctx.state),
        (error) => {
          audio.resumeError = String(error?.message ?? error);
          log('resume refused on', lastGesture, audio.resumeError);
        },
      );
    }
  }
  audio.unlock = unlock;

  let lastGesture = '';
  const onGesture = (e) => {
    lastGesture = e.type;
    if (e.type === 'keydown' && e.code === 'KeyM' && !e.repeat && !isTyping(e)) {
      AUDIO.enabled = !AUDIO.enabled;
      saveAudio(); // applies it (below)
    }
    unlock();
  };
  let engineType = AUDIO.engineType;
  const apply = () => {
    if (!ctx) return;
    node?.port.postMessage({ type: 'mix', values: audioMix() });
    if (AUDIO.engineType !== engineType && !audio.preset) node?.port.postMessage({ type: 'preset', preset: currentPreset() });
    engineType = AUDIO.engineType;
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

  // Per frame: stones thrown and landing (soil.sounds, taken and cleared), and the engine's state
  // when the worklet cannot read the shared feed.
  audio.update = (vehicle, soil = null) => {
    if (soil?.sounds?.length) {
      if (node && ctx?.state === 'running') {
        node.port.postMessage({ type: 'stones', events: soil.sounds });
        audio.stonesSent = (audio.stonesSent ?? 0) + soil.sounds.length;
      }
      soil.sounds = [];
    }
    if (!audio.manual || !node || !vehicle?.drivetrain) return;
    const d = vehicle.drivetrain;
    node.port.postMessage({ type: 'manual', values: { rpm: d.rpm ?? 0, fuel: d.fuel ?? 0, exhaustBrake: d.exhaustBrake ?? 0, throttle: d.throttle ?? 0 } });
  };

  audio.dispose = () => {
    for (const type of GESTURES) window.removeEventListener(type, onGesture, { capture: true });
    document.removeEventListener('visibilitychange', onVisibility);
    unsubscribe();
    removeButton();
    ctx?.close();
  };
  return audio;
}
