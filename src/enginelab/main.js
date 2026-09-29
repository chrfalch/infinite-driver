// Engine sound lab (engine-lab.html): the game's engine sound without the game, for tuning by ear.
// Drive and rev modes run the car's drivetrain here on a flat road (or in neutral) and feed the
// sound through the same audio feed as the game; manual mode sets the engine from the sliders.
import GUI from 'lil-gui';
import { createAudio } from '../audio/audio.js';
import { AUDIO, saveAudio } from '../audio/config.js';
import { AudioFeed, createFeedBuffer } from '../audio/feed.js';
import { ENGINE_PRESETS, TURBO_DIESEL_V8 } from '../audio/engine-presets.js';
import { LAYERS } from '../audio/engine-synth.js';
import { GROUND_LAYERS, GROUND_SOUND } from '../audio/ground-synth.js';
import { changedFrom, loadSettings, saveSettings } from '../settings-store.js';
import { DEFAULT_DRIVETRAIN, Drivetrain } from '../vehicle/drivetrain.js';

// The lab tunes the engine picked in the settings (the game's Sound folder, or the picker here).
const BASE = ENGINE_PRESETS[AUDIO.engineType] ?? TURBO_DIESEL_V8;

const DT = 1 / 120;
const R = 0.46;
const MASS = 1800;

const LAB = { mode: 'drive', rpm: 850, fuel: 0.13, exhaustBrake: 0, throttle: false, coastStop: 1, surface: 'gravel road', slide: 0, wheelspin: 0, stoneHits: 0 };

// The ground under the lab's car (as the worlds' height fields answer surfaceAt in wheels.js).
const SURFACES = {
  'gravel road': { world: 'canyon', sample: () => ({ rock: 0, road: 1 }) },
  'soil (some gravel)': { world: 'canyon', sample: () => ({ rock: 0, road: 0 }) },
  'bare rock': { rockAt: () => true },
  'river bed (sand, pebbles)': { rockAt: () => false },
};
// Four wheels rolling at the car's speed on the lab's flat road; the sliders add sliding sideways
// and wheelspin (the rears, as the drive does). What wheels.js reads from the soft car.
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const ORIGIN = { x: 0, y: 0, z: 0 };
const labWheels = {
  wheels: [0, 1, 2, 3].map((i) => ({
    hub: { linvel: () => ({ x: v, y: 0, z: LAB.slide * (v > 0.5 ? 1 : 0) }), rotation: () => IDENTITY, translation: () => ORIGIN },
    tyreLoad: 4400,
    rear: i >= 2,
  })),
  rollingRadius: () => 0.43,
  wheelSpin: (i) => (v + (i >= 2 ? LAB.wheelspin : 0)) / 0.43,
};
const feed = new AudioFeed(createFeedBuffer());
// The preset is sent below (the lab's tuned copy of BASE), so the settings' pick is not applied.
const audio = createAudio({ feed, preset: BASE });
window.__lab = { audio }; // for debugging from the console
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
gui.add(AUDIO, 'engineType', Object.keys(ENGINE_PRESETS)).name('Engine (reloads)').onChange(() => {
  saveAudio();
  location.reload();
});
gui.add(LAB, 'coastStop', 0, 1, 0.05).name('Exhaust brake (drive, rev)').onChange(reset);
const manual = gui.addFolder('Manual');
const manualValues = () => ({ rpm: LAB.rpm, fuel: LAB.fuel, exhaustBrake: LAB.exhaustBrake, throttle: LAB.throttle ? 1 : 0 });
manual.add(LAB, 'rpm', 0, 5600, 10).name('rpm');
manual.add(LAB, 'fuel', 0, 1, 0.01).name('Fuel (load)');
manual.add(LAB, 'exhaustBrake', 0, 1, 0.01).name('Exhaust brake');
manual.add(LAB, 'throttle').name('Throttle (lift = flutter)');
const tyres = gui.addFolder('Tyres and ground (drive, rev)');
tyres.add(LAB, 'surface', Object.keys(SURFACES)).name('Ground');
tyres.add(LAB, 'slide', 0, 6, 0.1).name('Slide sideways (m/s)');
tyres.add(LAB, 'wheelspin', 0, 12, 0.1).name('Rear wheelspin (m/s)');
tyres.add(LAB, 'stoneHits', 0, 30, 1).name('Stones thrown / s');
const levels = gui.addFolder('Levels');
levels.add(AUDIO, 'enabled').name('Sound on (M)').onChange(saveAudio).listen();
levels.add(AUDIO, 'volume', 0, 1, 0.01).name('Volume').onChange(saveAudio);
levels.add(AUDIO, 'engine', 0, 2, 0.05).name('Engine ×').onChange(saveAudio);
levels.add(AUDIO, 'turbo', 0, 3, 0.05).name('Turbo whistle ×').onChange(saveAudio);
levels.add(AUDIO, 'clatter', 0, 3, 0.05).name('Diesel clatter ×').onChange(saveAudio);
levels.add(AUDIO, 'ground', 0, 3, 0.05).name('Tyres & ground ×').onChange(saveAudio);

// The engine model itself, live: every change goes to the worklet and is kept in this browser.
// "Copy preset changes" puts the changed values on the clipboard, to paste into engine-presets.js.
const PRESET_KEY = BASE.cylinders === 4 ? 'drift.enginelab.preset.v1' : `drift.enginelab.preset.${BASE.name}.v1`;
const clone = (x) => JSON.parse(JSON.stringify(x));
const merge = (base, changes) => {
  for (const [k, v] of Object.entries(changes)) {
    if (!(k in base)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) merge(base[k], v);
    else base[k] = v;
  }
  return base;
};
const preset = merge(clone(BASE), loadSettings(PRESET_KEY));
const sendPreset = () => {
  audio.node?.port.postMessage({ type: 'preset', preset: clone(preset) });
  saveSettings(PRESET_KEY, BASE, preset);
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
if (preset.banks) {
  group('Banks (V engine)', [
    [preset, 'collide', 0, 6, 0.05, 'Pulse collision in collector'],
    [preset.bankGain, 0, 0, 1.5, 0.01, 'Left bank level'],
    [preset.bankGain, 1, 0, 1.5, 0.01, 'Right bank level'],
    [preset.bankPipeLengths, 0, 0.5, 8, 0.05, 'Left pipe (m)'],
    [preset.bankPipeLengths, 1, 0.5, 8, 0.05, 'Right pipe (m)'],
    [preset, 'timingJitter', 0, 0.03, 0.001, 'Uneven timing'],
  ]);
}
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
  [preset.turbo.wastegate, 'level', 0, 2, 0.01, 'Wastegate pssh'],
  [preset.turbo.wastegate, 'time', 0.1, 2, 0.05, 'Wastegate pssh time (s)'],
  [preset.turbo.wastegate, 'f', 500, 8000, 50, 'Wastegate pssh pitch (Hz)'],
  [preset.turbo.wastegate, 'q', 0.3, 5, 0.05, 'Wastegate pssh Q'],
  [preset.turbo.wastegate, 'bleed', 0, 0.5, 0.005, 'Wastegate bleed at full boost'],
]);

// The parts of the sound, each with its own level; Solo plays one part alone (at its level).
const LAYER_NAMES = {
  pulses: 'Exhaust pulses (dry)',
  echo: 'Pipe echo',
  silencer1: `Silencer resonance 1 (${preset.muffler[0]?.f} Hz)`,
  silencer2: `Silencer resonance 2 (${preset.muffler[1]?.f} Hz)`,
  silencer3: `Silencer resonance 3 (${preset.muffler[2]?.f} Hz)`,
  block: 'Block ring',
  clatter: 'Diesel clatter',
  rasp: 'Exhaust brake rasp',
  whistle: 'Turbo whistle',
  whoosh: 'Turbo whoosh',
  flutter: 'Lift-off flutter',
  wastegate: 'Wastegate',
  gear: 'Timing gear whine',
};
// Layer levels are part of the preset (preset.layers), so Copy includes them. Solo mutes the
// others at runtime without changing the preset.
const soloChoice = { solo: 'none' };
const groundSolo = { solo: 'none' };
const sendLayers = () => {
  // A tyre or ground solo mutes the whole engine.
  const values = Object.fromEntries(Object.keys(LAYERS).map((k) => [k, (soloChoice.solo === 'none' && groundSolo.solo === 'none') || k === soloChoice.solo ? 1 : 0]));
  audio.node?.port.postMessage({ type: 'layers', values });
};
const layerFolder = gui.addFolder('Layers');
layerFolder.add(soloChoice, 'solo', { 'none (all)': 'none', ...Object.fromEntries(Object.entries(LAYER_NAMES).map(([k, name]) => [name, k])) }).name('Solo').onChange(() => {
  groundSolo.solo = 'none';
  sendLayers();
  sendGroundLayers();
}).listen();
for (const [key, name] of Object.entries(LAYER_NAMES)) layerFolder.add(preset.layers, key, 0, 2, 0.01).name(name).onChange(sendPreset).listen();
layerFolder
  .add({ reset: () => { Object.assign(preset.layers, BASE.layers); soloChoice.solo = 'none'; layerFolder.controllersRecursive().forEach((c) => c.updateDisplay()); sendPreset(); sendLayers(); } }, 'reset')
  .name('Layers back to the preset');
// The tyre and ground sounds: their layers and main levels, live, kept and copied like the engine's.
const GROUND_KEY = 'drift.enginelab.ground.v1';
const ground = merge(clone(GROUND_SOUND), loadSettings(GROUND_KEY));
const sendGround = () => {
  audio.node?.port.postMessage({ type: 'groundPreset', preset: clone(ground) });
  saveSettings(GROUND_KEY, GROUND_SOUND, ground);
};
const sendGroundLayers = () => {
  // An engine solo mutes the tyres and ground.
  const values = Object.fromEntries(Object.keys(GROUND_LAYERS).map((k) => [k, (groundSolo.solo === 'none' && soloChoice.solo === 'none') || k === groundSolo.solo ? 1 : 0]));
  audio.node?.port.postMessage({ type: 'groundLayers', values });
};
const GROUND_NAMES = {
  gravel: 'Gravel crunch',
  soil: 'Soil / sand roll',
  rock: 'Rock roll',
  hum: 'Tread hum',
  scrub: 'Scrub (sliding, loose)',
  squeal: 'Squeal (sliding, rock)',
  spin: 'Wheelspin roar',
  stoneHits: 'Stones hitting the car',
  stoneLand: 'Stones landing on rock',
};
const groundFolder = gui.addFolder('Tyre and ground layers');
groundFolder.add(groundSolo, 'solo', { 'none (all)': 'none', ...Object.fromEntries(Object.entries(GROUND_NAMES).map(([k, name]) => [name, k])) }).name('Solo').onChange(() => {
  soloChoice.solo = 'none';
  sendLayers();
  sendGroundLayers();
}).listen();
for (const [key, name] of Object.entries(GROUND_NAMES)) groundFolder.add(ground.layers, key, 0, 3, 0.01).name(name).onChange(sendGround).listen();
const groundModel = groundFolder.addFolder('Ground model');
for (const [obj, key, min, max, step, label] of [
  [ground.gravel, 'perMetre', 0, 150, 1, 'Gravel clicks per metre'],
  [ground.gravel, 'decay', 0.0002, 0.004, 0.0001, 'Gravel click length (s)'],
  [ground.gravel.high, 'f', 800, 9000, 50, 'Gravel high band (Hz)'],
  [ground.gravel.low, 'f', 200, 4000, 50, 'Gravel low band (Hz)'],
  [ground.soil, 'f', 50, 1500, 10, 'Soil low-pass (Hz)'],
  [ground.rock, 'f', 40, 800, 5, 'Rock drone low-pass (Hz)'],
  [ground.hum, 'blocks', 10, 80, 1, 'Tread blocks around'],
  [ground.hum, 'cutoff', 200, 5000, 50, 'Tread hum low-pass (Hz)'],
  [ground.squeal, 'f', 300, 2500, 10, 'Squeal pitch (Hz)'],
  [ground.squeal, 'q', 2, 60, 1, 'Squeal Q'],
  [ground.stones, 'hitChance', 0, 1, 0.01, 'Share of stones hitting the car'],
  [ground.stones.hitModes[0], 'f', 500, 6000, 50, 'Stone hit ring 1 (Hz)'],
  [ground.stones.hitModes[1], 'f', 500, 8000, 50, 'Stone hit ring 2 (Hz)'],
  [ground, 'gain', 0, 3, 0.05, 'Ground gain'],
]) groundModel.add(obj, key, min, max, step).name(label).onChange(sendGround).listen();
groundModel.close();

const presetActions = {
  copy: async () => {
    const groundChanges = changedFrom(GROUND_SOUND, ground);
    const text = JSON.stringify({ ...changedFrom(BASE, preset), ...(Object.keys(groundChanges).length ? { ground: groundChanges } : {}) }, null, 2);
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
    merge(preset, clone(BASE));
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
    feed.writeStep(simTime, { drivetrain: drive, speed: v, controller: labWheels }, SURFACES[LAB.surface]);
  }
  if (audio.node && !presetSent) {
    presetSent = true;
    sendGround();
    sendGroundLayers();
    audio.node.port.postMessage({ type: 'preset', preset: clone(preset) });
    sendLayers();
  }
  // Stones thrown at the chosen rate.
  const stones = [];
  for (let k = 0; k < LAB.stoneHits / 60; k++) if (Math.random() < LAB.stoneHits / 60 - k) stones.push({ kind: 'throw', size: 0.025 + Math.random() * 0.045, speed: 2 + Math.random() * 6 });
  if (stones.length && audio.node) audio.node.port.postMessage({ type: 'stones', events: stones });
  if (LAB.mode === 'manual') audio.node?.port.postMessage({ type: 'manual', values: manualValues() });
  else audio.update({ drivetrain: drive });
  const d = LAB.mode === 'manual' ? { ...manualValues(), label: '-' } : { rpm: drive.rpm, fuel: drive.fuel, exhaustBrake: drive.exhaustBrake, label: drive.label };
  readout.textContent = [
    `sound    ${audio.state}${audio.ctx ? ` (${audio.ctx.state}, ${audio.ctx.sampleRate} Hz)` : ''}${audio.manual ? ', per frame' : ''}${AUDIO.enabled ? '' : ', OFF (M or Levels → Sound on)'}`,
    `output   peak ${audio.status?.peak?.toFixed(3) ?? '-'} (worklet, last second)${audio.status?.recoveries ? `, ${audio.status.recoveries} NaN recoveries` : ''}`,
    `volume   ${AUDIO.volume.toFixed(2)} × engine ${AUDIO.engine.toFixed(2)}`,
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
