// Engine sound lab (engine-lab.html): the game's engine sound without the game, for tuning by ear.
// Drive and rev modes run the car's drivetrain here on a flat road (or in neutral) and feed the
// sound through the same audio feed as the game; manual mode sets the engine from the sliders.
import GUI from 'lil-gui';
import { createAudio } from '../audio/audio.js';
import { AUDIO, saveAudio } from '../audio/config.js';
import { AudioFeed, createFeedBuffer } from '../audio/feed.js';
import { TURBO_DIESEL_I4 } from '../audio/engine-presets.js';
import { changedFrom, loadSettings, saveSettings } from '../settings-store.js';
import { DEFAULT_DRIVETRAIN, Drivetrain } from '../vehicle/drivetrain.js';

const DT = 1 / 120;
const R = 0.46;
const MASS = 1800;

const LAB = { mode: 'drive', rpm: 850, fuel: 0.13, exhaustBrake: 0, throttle: false, coastStop: 1 };
const feed = new AudioFeed(createFeedBuffer());
const audio = createAudio({ feed });
let drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN });
let v = 0;
let simTime = 0;
let held = false;

const reset = () => {
  drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN, automatic: LAB.mode === 'drive', coastStop: LAB.coastStop });
  v = 0;
};

const gui = new GUI({ title: 'Engine sound' });
gui.domElement.classList.add('tuning');
gui.add(LAB, 'mode', ['drive', 'rev', 'manual']).name('Mode').onChange(() => {
  reset();
  if (LAB.mode !== 'manual') audio.node?.port.postMessage({ type: 'feed' });
});
gui.add(LAB, 'coastStop', 0, 1, 0.05).name('Exhaust brake (drive, rev)').onChange(reset);
const manual = gui.addFolder('Manual');
const manualValues = () => ({ rpm: LAB.rpm, fuel: LAB.fuel, exhaustBrake: LAB.exhaustBrake, throttle: LAB.throttle ? 1 : 0 });
manual.add(LAB, 'rpm', 0, 5600, 10).name('rpm');
manual.add(LAB, 'fuel', 0, 1, 0.01).name('Fuel (load)');
manual.add(LAB, 'exhaustBrake', 0, 1, 0.01).name('Exhaust brake');
manual.add(LAB, 'throttle').name('Throttle (lift = flutter)');
const levels = gui.addFolder('Levels');
levels.add(AUDIO, 'enabled').name('Sound on (M)').onChange(saveAudio).listen();
levels.add(AUDIO, 'volume', 0, 1, 0.01).name('Volume').onChange(saveAudio);
levels.add(AUDIO, 'engine', 0, 2, 0.05).name('Engine ×').onChange(saveAudio);
levels.add(AUDIO, 'turbo', 0, 3, 0.05).name('Turbo whistle ×').onChange(saveAudio);
levels.add(AUDIO, 'clatter', 0, 3, 0.05).name('Diesel clatter ×').onChange(saveAudio);

// The engine model itself, live: every change goes to the worklet and is kept in this browser.
// "Copy preset changes" puts the changed values on the clipboard, to paste into engine-presets.js.
const PRESET_KEY = 'drift.enginelab.preset.v1';
const clone = (x) => JSON.parse(JSON.stringify(x));
const merge = (base, changes) => {
  for (const [k, v] of Object.entries(changes)) {
    if (!(k in base)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) merge(base[k], v);
    else base[k] = v;
  }
  return base;
};
const preset = merge(clone(TURBO_DIESEL_I4), loadSettings(PRESET_KEY));
const sendPreset = () => {
  audio.node?.port.postMessage({ type: 'preset', preset: clone(preset) });
  saveSettings(PRESET_KEY, TURBO_DIESEL_I4, preset);
};
const model = gui.addFolder('Engine model (live)');
const group = (title, rows) => {
  const f = model.addFolder(title);
  for (const [obj, key, min, max, step, label] of rows) f.add(obj, key, min, max, step).name(label).onChange(sendPreset).listen();
  f.close();
};
group('Exhaust pulses', [
  [preset, 'spike', 0, 2, 0.05, 'Blowdown spike'],
  [preset, 'spikeTime', 0.0001, 0.002, 0.00005, 'Spike time (s)'],
  [preset, 'bodyShare', 0.03, 0.6, 0.01, 'Pulse length (share)'],
  [preset, 'motoring', 0, 1, 0.01, 'Strength with no fuel'],
  [preset, 'ampJitter', 0, 0.6, 0.01, 'Random per firing'],
  [preset, 'wander', 0, 1, 0.01, 'Slow wander'],
]);
group('Pipe', [
  [preset.pipe, 'feedback', -0.9, 0.9, 0.01, 'Echo (− = open end)'],
  [preset.pipe, 'length', 0.5, 6, 0.05, 'Length (m)'],
  [preset.pipe, 'damping', 0, 0.95, 0.01, 'Echo dullness'],
]);
group('Silencer', [
  ...preset.muffler.flatMap((m, i) => [
    [m, 'f', 30, 600, 1, `Resonance ${i + 1} (Hz)`],
    [m, 'q', 0.3, 8, 0.1, `Resonance ${i + 1} Q`],
    [m, 'gain', 0, 2, 0.01, `Resonance ${i + 1} level`],
  ]),
  [preset, 'drive', 0.1, 8, 0.1, 'Overdrive'],
  [preset.rough, 'amount', 0, 1, 0.01, 'Turbulence'],
  [preset.rough, 'frequency', 20, 1000, 5, 'Turbulence band (Hz)'],
]);
group('Tone', [
  [preset.tone, 'base', 50, 2000, 10, 'Low-pass base (Hz)'],
  [preset.tone, 'load', 0, 5000, 10, 'Low-pass + load (Hz)'],
  [preset.tone, 'perRpm', 0, 2, 0.01, 'Low-pass + per rpm'],
  [preset.tone, 'q', 0.3, 4, 0.05, 'Low-pass Q'],
  [preset, 'topCut', 1000, 16000, 100, 'Top cut (Hz)'],
  [preset, 'gain', 0.1, 3, 0.05, 'Output gain'],
]);
group('Block and clatter', [
  [preset.block, 'f', 100, 3000, 10, 'Block ring (Hz)'],
  [preset.block, 'gain', 0, 2, 0.01, 'Block ring level'],
  [preset.clatter, 'level', 0, 2, 0.01, 'Clatter level'],
  [preset.clatter, 'decay', 0.0002, 0.005, 0.0001, 'Clatter decay (s)'],
]);
group('Turbo', [
  [preset.turbo, 'whine', 0, 0.3, 0.005, 'Whistle'],
  [preset.turbo, 'whine2', 0, 1.5, 0.01, 'Second tone'],
  [preset.turbo, 'whineMin', 500, 8000, 50, 'Whistle at no boost (Hz)'],
  [preset.turbo, 'whineMax', 1000, 14000, 50, 'Whistle at full boost (Hz)'],
  [preset.turbo, 'hiss', 0, 0.8, 0.01, 'Whoosh'],
  [preset.turbo, 'hissQ', 0.2, 5, 0.05, 'Whoosh Q'],
  [preset.turbo, 'flutter', 0, 1, 0.01, 'Lift-off flutter'],
  [preset.turbo, 'upTime', 0.1, 3, 0.05, 'Spool-up time (s)'],
]);
const presetActions = {
  copy: async () => {
    const text = JSON.stringify(changedFrom(TURBO_DIESEL_I4, preset), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      copyButton.name('Copied ✓');
    } catch {
      console.log(text);
      copyButton.name('Copy failed, see console');
    }
    setTimeout(() => copyButton.name('Copy preset changes'), 1800);
  },
  reset: () => {
    merge(preset, clone(TURBO_DIESEL_I4));
    sendPreset();
  },
};
const copyButton = model.add(presetActions, 'copy').name('Copy preset changes');
model.add(presetActions, 'reset').name('Reset engine model');
// The worklet starts with the built-in preset; send the kept one once it is running.
let presetSent = false;

const THROTTLE_KEYS = ['KeyW', 'ArrowUp'];
window.addEventListener('keydown', (e) => THROTTLE_KEYS.includes(e.code) && (held = true));
window.addEventListener('keyup', (e) => THROTTLE_KEYS.includes(e.code) && (held = false));
window.addEventListener('blur', () => (held = false));
// The on-screen throttle, for phones.
const pedal = document.getElementById('throttle');
pedal.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  held = true;
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) pedal.addEventListener(type, () => (held = false));

// Physics steps on the wall clock, as the game does.
const readout = document.getElementById('readout');
let last = performance.now();
let acc = 0;
const frame = (now) => {
  acc = Math.min(acc + (now - last) / 1000, 0.1);
  last = now;
  while (acc >= DT) {
    acc -= DT;
    const throttle = held ? 1 : 0;
    const torques = drive.update(DT, { throttle, reverseRequest: false }, [v / R, v / R, v / R, v / R], v, R);
    if (LAB.mode === 'drive') {
      const force = torques.reduce((a, b) => a + b, 0) / R - 0.75 * v * Math.abs(v) - (v > 0.05 ? 0.018 * MASS * 9.81 : 0);
      v = Math.max(0, v + (force / (MASS + (4 * 3.5) / (R * R))) * DT);
    }
    simTime += DT;
    feed.writeStep(simTime, { drivetrain: drive, speed: v });
  }
  if (audio.node && !presetSent) {
    presetSent = true;
    audio.node.port.postMessage({ type: 'preset', preset: clone(preset) });
  }
  if (LAB.mode === 'manual') audio.node?.port.postMessage({ type: 'manual', values: manualValues() });
  else audio.update({ drivetrain: drive });
  const d = LAB.mode === 'manual' ? { ...manualValues(), label: '-' } : { rpm: drive.rpm, fuel: drive.fuel, exhaustBrake: drive.exhaustBrake, label: drive.label };
  readout.textContent = [
    `sound    ${audio.state}${audio.ctx ? ` (${audio.ctx.state}, ${audio.ctx.sampleRate} Hz)` : ''}${audio.manual ? ', per frame' : ''}`,
    `rpm      ${Math.round(d.rpm)}`,
    `gear     ${d.label}`,
    `fuel     ${d.fuel.toFixed(2)}`,
    `exh brk  ${d.exhaustBrake.toFixed(2)}`,
    `speed    ${(v * 3.6).toFixed(0)} km/h`,
  ].join('\n');
  requestAnimationFrame(frame);
};
reset();
requestAnimationFrame(frame);
