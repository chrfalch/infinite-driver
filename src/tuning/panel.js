import GUI from 'lil-gui';
import { CONTROLS, DEFAULT_CONTROLS, saveControls } from '../controls.js';
import { Deformation, Input, IsPlayer, Physics, Render, Soil, Tracks, Vehicle } from '../ecs/traits.js';
import { applyQuality, resolveQuality } from '../render/quality.js';
import { CAR, DEFAULT_CAR, resetCar, saveCar } from '../vehicle/config.js';
import {
  GPU_TIRE,
  GROUND,
  TIRE,
  effectiveGpuTire,
  resetGpuTire,
  resetGround,
  resetTire,
  saveGpuTire,
  saveGround,
  saveTire,
} from '../tire/config.js';
import { applyWheelSettings } from '../vehicle/physics.js';
import { DRIVETRAIN, resetDrivetrain, saveDrivetrain } from '../vehicle/config.js';
import { requestRebuild, requestRespawn } from '../vehicle/spawn.js';
import { setGravelAmount } from '../render/terrain-mesh.js';
import { WORLDS, saveWorld, worldMode } from '../world.js';
import { AUDIO, resetAudio, saveAudio } from '../audio/config.js';
import { ENGINE_PRESETS } from '../audio/engine-presets.js';

// [path, label, min, max, step, apply] — apply is 'live' (read every step), 'wheels' (pushed to
// the Rapier controller), or 'rebuild' (shape or mass: the car is rebuilt in place).
const GROUPS = [
  [
    'Brakes & resistance',
    [
      ['maxBrakeForce', 'Brake force (N)', 2000, 40000, 250, 'live'],
      ['handbrakeForce', 'Handbrake force (N)', 0, 20000, 250, 'live'],
      ['dragCoefficient', 'Air drag (½ρCdA)', 0, 3, 0.01, 'live'],
      ['rollingResistance', 'Rolling resistance', 0, 0.1, 0.001, 'live'],
    ],
  ],
  [
    'Steering',
    [
      ['maxSteer', 'Max steer angle (rad)', 0.1, 1, 0.01, 'live'],
      ['steerRate', 'Steer speed (rad/s)', 0.2, 8, 0.1, 'live'],
      ['steeringWheelRatio', 'Steering wheel ratio', 1, 20, 0.5, 'live'],
      ['ackermann', 'Ackermann geometry', 0, 1, 0.05, 'live'],
    ],
  ],
  [
    'Suspension',
    [
      ['suspensionStiffness', 'Spring stiffness', 2, 60, 0.5, 'wheels'],
      ['suspensionCompression', 'Damping (bump)', 0, 10, 0.05, 'wheels'],
      ['suspensionRelaxation', 'Damping (rebound)', 0, 10, 0.05, 'wheels'],
      ['suspensionRestLength', 'Rest length (m)', 0.1, 1, 0.01, 'wheels'],
      ['maxSuspensionTravel', 'Max travel (m)', 0.05, 0.8, 0.01, 'wheels'],
      ['antiDive', 'Anti-dive / anti-squat', 0, 1, 0.05, 'live'],
      ['rollStiffness', 'Solid-axle roll stiffness ×', 0.2, 3, 0.05, 'rebuild'],
      ['pinionReaction', 'Axle torque reaction', 0, 2, 0.05, 'live'],
      // Wheel alignment (independent suspension).
      ['camber', 'Camber (°)', -5, 5, 0.1, 'rebuild'],
      ['caster', 'Caster (°)', 0, 12, 0.1, 'rebuild'],
      ['toeFront', 'Toe-in front (°)', -2, 2, 0.05, 'rebuild'],
      ['toeRear', 'Toe-in rear (°)', -2, 2, 0.05, 'rebuild'],
    ],
  ],
  [
    'Body & mass',
    [
      ['mass', 'Mass (kg)', 400, 5000, 10, 'rebuild'],
      ['centerOfMass.x', 'CoM forward (m)', -1, 1, 0.01, 'rebuild'],
      ['centerOfMass.y', 'CoM height (m)', -0.8, 0.8, 0.01, 'rebuild'],
    ],
  ],
  [
    'Geometry',
    [
      ['wheelBase', 'Wheelbase (m)', 1.6, 4, 0.01, 'rebuild'],
      ['track', 'Track width (m)', 1.2, 3, 0.01, 'rebuild'],
      ['wheelMountY', 'Wheel mount height (m)', -0.4, 0.3, 0.01, 'rebuild'],
      ['halfExtents.x', 'Body half length (m)', 1, 3, 0.01, 'rebuild'],
      ['halfExtents.y', 'Body half height (m)', 0.15, 0.8, 0.01, 'rebuild'],
      ['halfExtents.z', 'Body half width (m)', 0.3, 1.2, 0.01, 'rebuild'],
    ],
  ],
];

function resolve(root, path) {
  const keys = path.split('.');
  const last = keys.pop();
  return [keys.reduce((o, k) => o[k], root), last];
}

// Only the values that differ from the defaults, as a nested object.
function changedSettings() {
  const out = {};
  for (const [, params] of GROUPS) {
    for (const [path] of params) {
      const [obj, key] = resolve(CAR, path);
      const [def] = resolve(DEFAULT_CAR, path);
      if (obj[key] === def[key]) continue;
      const keys = path.split('.');
      let o = out;
      keys.slice(0, -1).forEach((k) => (o = o[k] ??= {}));
      o[key] = obj[key];
    }
  }
  return out;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers that block the async clipboard API.
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export function createTuningPanel(world, { heightAt }) {
  const gui = new GUI({ title: 'Car tuning' });
  gui.domElement.classList.add('tuning');
  let rebuildTimer = null;

  const scheduleRebuild = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => requestRebuild(world), 150);
  };

  const applyWheels = () => {
    world.query(IsPlayer, Vehicle).forEach((car) => applyWheelSettings(car.get(Vehicle).controller));
  };

  const actions = {
    copy: async () => {
      const text = JSON.stringify({ changed: changedSettings(), controls: CONTROLS, ground: GROUND, drivetrain: DRIVETRAIN, car: CAR, tire: TIRE, gpuTire: GPU_TIRE }, null, 2);
      const ok = await copyText(text);
      copyButton.name(ok ? 'Copied ✓' : 'Copy failed, see console');
      if (!ok) console.log(text);
      setTimeout(() => copyButton.name('Copy settings'), 1800);
    },
    reset: () => {
      resetCar();
      resetTire();
      resetGpuTire();
      resetGround();
      setGravelAmount(GROUND.gravel);
      resetDrivetrain();
      resetAudio();
      Object.assign(CONTROLS, DEFAULT_CONTROLS);
      saveControls();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      applyWheels();
      requestRebuild(world);
    },
    respawn: () => requestRespawn(world, heightAt),
  };

  // World picker: a new world needs a fresh start (both workers build their terrain at load).
  const worldChoice = { mode: worldMode() };
  gui
    .add(worldChoice, 'mode', WORLDS)
    .name('World')
    .onChange((mode) => {
      saveWorld(mode);
      const url = new URL(location.href);
      url.searchParams.delete('terrain');
      location.href = url.href;
    });
  const copyButton = gui.add(actions, 'copy').name('Copy settings');
  gui.add(actions, 'reset').name('Reset to defaults');
  gui.add(actions, 'respawn').name('Respawn car (R)');

  const controls = gui.addFolder('Controls');
  controls
    .add(CONTROLS, 'latchAccelerator')
    .name('Tap accelerator to latch')
    .onChange(() => {
      saveControls();
      world.get(Input).engineOn = false;
    });

  const suspension = { independent: !CAR.solidAxles };
  controls
    .add(suspension, 'independent')
    .name('Independent suspension (off = solid axles)')
    .onChange(() => {
      CAR.solidAxles = !suspension.independent;
      saveCar();
      requestRebuild(world);
    });
  controls
    .add(CONTROLS, 'graphics', ['auto', 'high', 'low'])
    .name('Graphics quality')
    .onChange(() => {
      saveControls();
      const render = world.get(Render);
      render.quality = applyQuality(render.renderer, render.sun, resolveQuality());
      render.resize();
    });
  controls
    .add(CONTROLS, 'performance')
    .name('Performance preset')
    .onChange(() => {
      saveControls();
      requestRebuild(world);
    });
  // P toggles it too (systems/input.js), so the checkbox follows the value.
  controls.add(CONTROLS, 'showPerf').name('Show perf stats (P)').onChange(saveControls).listen();

  for (const [title, params] of GROUPS) {
    const folder = gui.addFolder(title);
    for (const [path, label, min, max, step, mode] of params) {
      const [obj, key] = resolve(CAR, path);
      folder
        .add(obj, key, min, max, step)
        .name(label)
        .onChange(() => {
          saveCar();
          if (mode === 'wheels') applyWheels();
          if (mode === 'rebuild') scheduleRebuild();
        });
    }
    folder.close();
  }

  // Tyres: pressure, grip and mass apply live; size, mass and mesh rebuild the car.
  addTireFolder(gui, world, scheduleRebuild);

  // Drivetrain: read live every step.
  const dt = gui.addFolder('Drivetrain');
  dt.add(DRIVETRAIN, 'coastStop', 0, 1, 0.05).name('Quick stop off throttle (0 = realistic)').onChange(saveDrivetrain);
  dt.add(DRIVETRAIN, 'automatic').name('Automatic gearbox (Q/E = manual)').onChange(saveDrivetrain);
  dt.add(DRIVETRAIN, 'low').name('Low range (L)').onChange(saveDrivetrain);
  dt.add(DRIVETRAIN, 'centerLock').name('Lock centre diff').onChange(saveDrivetrain);
  dt.add(DRIVETRAIN, 'frontLock').name('Lock front diff').onChange(saveDrivetrain);
  dt.add(DRIVETRAIN, 'rearLock').name('Lock rear diff').onChange(saveDrivetrain);
  const torqueScale = { value: 1 };
  const baseCurve = DRIVETRAIN.torqueCurve.map(([r, t]) => [r, t]);
  dt.add(torqueScale, 'value', 0.3, 3, 0.05)
    .name('Engine torque ×')
    .onChange(() => {
      DRIVETRAIN.torqueCurve.forEach((pt, i) => (pt[1] = baseCurve[i][1] * torqueScale.value));
      saveDrivetrain();
    });
  for (const [key, label, min, max, step] of [
    ['finalDrive', 'Final drive ratio', 2.5, 8, 0.05],
    ['lowRange', 'Low range ratio', 1.5, 4, 0.05],
    ['frontShare', 'Front torque share', 0, 1, 0.05],
    ['upshiftRpm', 'Upshift rpm', 2000, 5200, 50],
    ['downshiftRpm', 'Downshift rpm', 900, 3000, 50],
    ['idleRpm', 'Idle rpm', 600, 1200, 10],
    ['limiterRpm', 'Rev limiter rpm', 3500, 7000, 50],
    ['frictionPerRpm', 'Engine friction per rpm', 0, 0.05, 0.001],
    ['engineInertia', 'Engine inertia (kg·m²)', 0.05, 1, 0.01],
    ['clutchTorque', 'Clutch capacity (N·m)', 200, 2000, 10],
    ['shiftTime', 'Shift time (s)', 0.05, 1, 0.05],
  ]) {
    dt.add(DRIVETRAIN, key, min, max, step).name(label).onChange(saveDrivetrain);
  }
  dt.close();

  // Sound: applied live by audio/audio.js when saved. M toggles it, so the checkbox follows.
  const sound = gui.addFolder('Sound');
  sound.add(AUDIO, 'enabled').name('Sound on (M)').onChange(saveAudio).listen();
  sound.add(AUDIO, 'engineType', Object.keys(ENGINE_PRESETS)).name('Engine sound').onChange(saveAudio);
  sound.add(AUDIO, 'volume', 0, 1, 0.01).name('Volume').onChange(saveAudio);
  sound.add(AUDIO, 'engine', 0, 2, 0.05).name('Engine ×').onChange(saveAudio);
  sound.add(AUDIO, 'turbo', 0, 3, 0.05).name('Turbo whistle ×').onChange(saveAudio);
  sound.add(AUDIO, 'clatter', 0, 3, 0.05).name('Diesel clatter ×').onChange(saveAudio);
  sound.add(AUDIO, 'ground', 0, 3, 0.05).name('Tyres & ground ×').onChange(saveAudio);
  sound.add(AUDIO, 'car', 0, 3, 0.05).name('Driveline, body & wind ×').onChange(saveAudio);
  sound.close();

  // Ground: softness sinks the tyres into the soil; gravel is what the tread rolls over.
  const ground = gui.addFolder('Ground');
  ground
    .add(GROUND, 'softness', 0, 1, 0.05)
    .name('Soil softness')
    .onChange(() => {
      saveGround();
      const solver = world.queryFirst(IsPlayer, Vehicle)?.get(Vehicle).controller.gpu?.solver;
      if (solver) solver.setParams(effectiveGpuTire(GPU_TIRE, CONTROLS.performance), world.get(Physics).step);
    });
  ground
    .add(GROUND, 'gravel', 0, 1, 0.05)
    .name('Gravel')
    .onChange(() => {
      saveGround();
      const solver = world.queryFirst(IsPlayer, Vehicle)?.get(Vehicle).controller.gpu?.solver;
      if (solver) solver.setParams(effectiveGpuTire(GPU_TIRE, CONTROLS.performance), world.get(Physics).step);
      setGravelAmount(GROUND.gravel);
    });
  ground.add(GROUND, 'tracks').name('Tyre tracks').onChange(saveGround);
  ground
    .add(
      {
        clear: () => {
          world.get(Tracks).renderer?.clear();
          world.get(Deformation)?.map?.clear();
          world.get(Soil)?.particles?.clear();
        },
      },
      'clear',
    )
    .name('Clear tracks and ruts');

  addKeysFolder(gui);

  // Give the keyboard back to the car once a value is committed.
  gui.onFinishChange(() => {
    if (isTyping({ target: document.activeElement })) document.activeElement.blur();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && !isTyping(e)) actions.respawn();
  });
  return gui;
}

export function isTyping(e) {
  const tag = e.target?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;
}

const KEYS = [
  ['W / ↑', 'Accelerate (hold)'],
  ['S / ↓', 'Brake, reverse'],
  ['A D / ← →', 'Steer'],
  ['Q E', 'Shift down / up'],
  ['L', 'Low range (when slow)'],
  ['Space', 'Handbrake'],
  ['R', 'Respawn'],
  ['C', 'Follow camera on / off (tap)'],
  ['C + arrows', 'Turn and tilt the camera'],
  ['P', 'Perf stats on / off'],
  ['M', 'Sound on / off'],
  ['Drag', 'Turn the camera; double-click resets'],
  ['Wheel / pinch', 'Zoom'],
];

// The key legend, as the last section of the panel.
function addKeysFolder(gui) {
  const folder = gui.addFolder('Keys');
  const table = document.createElement('table');
  table.className = 'keys';
  for (const [key, action] of KEYS) {
    const row = table.insertRow();
    const k = document.createElement('kbd');
    k.textContent = key;
    row.insertCell().append(k);
    row.insertCell().textContent = action;
  }
  folder.$children.append(table);
  return folder;
}

const GPU_REBUILD_KEYS = ['segmentsAround', 'segmentsAcross', 'beadRings', 'rubberMass'];

// One folder for the tyres (the GPU soft-body tyres): the everyday settings at the top, the solver
// in a closed sub-folder. Size lives in TIRE (shared with the tyre meshes), the rest in GPU_TIRE.
function addTireFolder(gui, world, scheduleRebuild) {
  const folder = gui.addFolder('Tyres');
  const apply = (key) => () => {
    saveGpuTire();
    if (GPU_REBUILD_KEYS.includes(key)) return scheduleRebuild();
    const car = world.queryFirst(IsPlayer, Vehicle);
    const solver = car?.get(Vehicle).controller.gpu?.solver;
    if (solver) solver.setParams(effectiveGpuTire(GPU_TIRE, CONTROLS.performance), world.get(Physics).step);
  };
  for (const [key, label, min, max, step] of [
    ['pressureKpa', 'Air pressure (kPa)', 10, 300, 5],
    ['friction', 'Rubber friction', 0.2, 2, 0.05],
    ['rubberMass', 'Rubber mass (kg)', 2, 40, 1],
    ['sidewallBulge', 'Sidewall bulge', 0, 3, 0.05],
  ]) {
    folder.add(GPU_TIRE, key, min, max, step).name(label).onChange(apply(key));
  }
  const resize = () => {
    saveTire();
    scheduleRebuild();
  };
  for (const [key, label, min, max, step] of [
    ['outerRadius', 'Outer radius (m)', 0.3, 0.8, 0.01],
    ['rimRadius', 'Rim radius (m)', 0.15, 0.6, 0.01],
    ['width', 'Width (m)', 0.12, 0.6, 0.01],
  ]) {
    folder.add(TIRE, key, min, max, step).name(label).onChange(resize);
  }

  const solver = folder.addFolder('Tyre solver (advanced)');
  for (const [key, label, min, max, step] of [
    ['stepsPerTrip', 'Physics steps per GPU round trip', 1, 4, 1],
    ['substeps', 'Substeps per step', 1, 16, 1],
    ['iterations', 'Solver passes per substep', 1, 24, 1],
    ['cordStiffness', 'Cords (per pass)', 0, 1, 0.05],
    ['shearStiffness', 'Shear (per pass)', 0, 1, 0.05],
    ['bendStiffness', 'Bending (per pass)', 0, 1, 0.01],
    ['shapeStiffness', 'Shape memory (per pass)', 0, 0.3, 0.005],
    ['beadPull', 'Bead grip on rim (per pass)', 0.05, 1, 0.05],
    ['beltStretch', 'Belt stretch (0 = off)', 0, 0.2, 0.005],
    ['beltPull', 'Belt pull', 0.05, 1, 0.05],
    ['treadBend', 'Tread stiffness', 0, 0.3, 0.01],
    ['damping', 'Damping (1/s)', 0, 30, 0.5],
    ['contactRadius', 'Tread thickness (m)', 0.005, 0.06, 0.005],
    ['segmentsAround', 'Segments around', 16, 48, 1],
    ['segmentsAcross', 'Segments across', 6, 10, 1],
    ['beadRings', 'Bead width (rings)', 0, 2, 1],
  ]) {
    solver.add(GPU_TIRE, key, min, max, step).name(label).onChange(apply(key));
  }
  solver.close();
  folder.close();
  return folder;
}
