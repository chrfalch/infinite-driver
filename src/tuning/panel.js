import GUI from 'lil-gui';
import { CONTROLS, DEFAULT_CONTROLS, saveControls } from '../controls.js';
import { Deformation, Input, IsPlayer, Physics, Tracks, Vehicle, View } from '../ecs/traits.js';
import { paint } from '../render/car-mesh.js';
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
import { TIRE_REBUILD_KEYS, updateSoftTire } from '../tire/soft-tire.js';
import { applyWheelSettings } from '../vehicle/physics.js';
import { DRIVETRAIN, resetDrivetrain, saveDrivetrain } from '../vehicle/config.js';
import { rebuildCar, respawnCar } from '../vehicle/spawn.js';

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
    ],
  ],
  [
    'Tyres',
    [
      ['frictionSlip', 'Grip (friction slip)', 0.2, 5, 0.05, 'wheels'],
      ['sideFrictionStiffness', 'Side grip stiffness', 0.1, 3, 0.05, 'wheels'],
      ['wheelRadius', 'Wheel radius (m)', 0.25, 0.8, 0.01, 'rebuild'],
      ['wheelWidth', 'Wheel width (m)', 0.15, 0.6, 0.01, 'rebuild'],
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
    rebuildTimer = setTimeout(() => rebuildCar(world), 150);
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
      resetDrivetrain();
      Object.assign(CONTROLS, DEFAULT_CONTROLS);
      saveControls();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      applyWheels();
      rebuildCar(world);
    },
    respawn: () => respawnCar(world, heightAt),
    lab: () => (location.href = '/tire-lab.html'),
  };

  const copyButton = gui.add(actions, 'copy').name('Copy settings');
  gui.add(actions, 'reset').name('Reset to defaults');
  gui.add(actions, 'respawn').name('Respawn car (R)');
  gui.add(actions, 'lab').name('Open soft tyre lab →');

  const controls = gui.addFolder('Controls');
  controls
    .add(CONTROLS, 'latchAccelerator')
    .name('Tap accelerator to latch')
    .onChange(() => {
      saveControls();
      world.get(Input).engineOn = false;
    });

  controls
    .add(CAR, 'softTires')
    .name('Soft tyres')
    .onChange(() => {
      saveCar();
      rebuildCar(world);
    });
  const suspension = { independent: !CAR.solidAxles };
  controls
    .add(suspension, 'independent')
    .name('Independent suspension (off = solid axles)')
    .onChange(() => {
      CAR.solidAxles = !suspension.independent;
      saveCar();
      rebuildCar(world);
    });
  controls
    .add(CAR, 'gpuTires')
    .name('GPU tyres (TypeGPU)')
    .onChange(() => {
      saveCar();
      rebuildCar(world);
    });
  controls
    .add(CONTROLS, 'showBody')
    .name('Show body (off = see axles)')
    .onChange(() => {
      saveControls();
      applyBodyVisibility(world);
    });
  applyBodyVisibility(world);
  controls
    .add(CONTROLS, 'performance')
    .name('Performance preset')
    .onChange(() => {
      saveControls();
      rebuildCar(world);
    });

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

  // Soft tyre settings: most apply live to the four tyres, size and mesh rebuild the car.
  const softFolder = gui.addFolder('Soft tyres');
  const onTire = (key) => () => {
    saveTire();
    if (!CAR.softTires) return;
    if (TIRE_REBUILD_KEYS.includes(key)) scheduleRebuild();
    else {
      const car = world.queryFirst(IsPlayer, Vehicle);
      const { controller } = car.get(Vehicle);
      const rapier = world.get(Physics).rapier;
      controller.wheels?.forEach((w) => updateSoftTire(rapier, w.soft, TIRE));
    }
  };
  for (const [key, label, min, max, step] of [
    ['inflation', 'Air pressure (inflation ×)', 0.8, 1.3, 0.01],
    ['airStiffness', 'Air stiffness (Hz)', 20, 800, 10],
    ['carcassStiffness', 'Carcass / cords (Hz)', 20, 800, 10],
    ['sidewallStiffness', 'Sidewall bending (Hz)', 0, 120, 1],
    ['shapeMemory', 'Shape memory (Hz)', 0, 120, 1],
    ['damping', 'Damping ratio', 0, 2, 0.05],
    ['friction', 'Rubber friction', 0.2, 2, 0.05],
    ['rubberMass', 'Rubber mass (kg)', 2, 40, 1],
    ['outerRadius', 'Outer radius (m)', 0.3, 0.8, 0.01],
    ['rimRadius', 'Rim radius (m)', 0.15, 0.6, 0.01],
    ['width', 'Width (m)', 0.12, 0.6, 0.01],
    ['segmentsAround', 'Segments around', 12, 48, 1],
    ['segmentsAcross', 'Segments across', 4, 16, 1],
    ['beadRings', 'Bead width (rings)', 0, 2, 1],
    ['substeps', 'Solver substeps', 0, 6, 1],
    ['pgsIterations', 'Solver iterations', 0, 6, 1],
  ]) {
    softFolder.add(TIRE, key, min, max, step).name(label).onChange(onTire(key));
  }
  softFolder.close();

  // Drivetrain: read live every step.
  const dt = gui.addFolder('Drivetrain');
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
    ['coastDownshiftRpm', 'Coasting downshift rpm', 900, 3500, 50],
    ['idleRpm', 'Idle rpm', 600, 1200, 10],
    ['limiterRpm', 'Rev limiter rpm', 3500, 7000, 50],
    ['frictionPerRpm', 'Engine friction per rpm', 0, 0.05, 0.001],
    ['exhaustBrake', 'Exhaust brake (N·m)', 0, 250, 5],
    ['engineInertia', 'Engine inertia (kg·m²)', 0.05, 1, 0.01],
    ['clutchTorque', 'Clutch capacity (N·m)', 200, 2000, 10],
    ['shiftTime', 'Shift time (s)', 0.05, 1, 0.05],
  ]) {
    dt.add(DRIVETRAIN, key, min, max, step).name(label).onChange(saveDrivetrain);
  }
  dt.close();

  // Ground: softness sinks the GPU tyres into the soil; tracks are drawn in every tyre mode.
  const ground = gui.addFolder('Ground');
  ground
    .add(GROUND, 'softness', 0, 1, 0.05)
    .name('Softness (GPU tyres)')
    .onChange(() => {
      saveGround();
      const solver = world.queryFirst(IsPlayer, Vehicle)?.get(Vehicle).controller.gpu?.solver;
      if (solver) solver.setParams(effectiveGpuTire(GPU_TIRE, CONTROLS.performance), world.get(Physics).step);
    });
  ground.add(GROUND, 'tracks').name('Tyre tracks').onChange(saveGround);
  ground
    .add(
      {
        clear: () => {
          world.get(Tracks).renderer?.clear();
          world.get(Deformation)?.map?.clear();
        },
      },
      'clear',
    )
    .name('Clear tracks and ruts');

  // GPU tyre settings: most apply live, mesh and mass rebuild the car.
  addGpuTireFolder(gui, world, scheduleRebuild);

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

const GPU_REBUILD_KEYS = ['segmentsAround', 'segmentsAcross', 'beadRings', 'rubberMass'];

function addGpuTireFolder(gui, world, scheduleRebuild) {
  const folder = gui.addFolder('GPU tyres');
  const apply = (key) => () => {
    saveGpuTire();
    if (GPU_REBUILD_KEYS.includes(key)) return scheduleRebuild();
    const car = world.queryFirst(IsPlayer, Vehicle);
    const solver = car?.get(Vehicle).controller.gpu?.solver;
    if (solver) solver.setParams(effectiveGpuTire(GPU_TIRE, CONTROLS.performance), world.get(Physics).step);
  };
  for (const [key, label, min, max, step] of [
    ['pressureKpa', 'Air pressure (kPa)', 10, 300, 5],
    ['substeps', 'Substeps per step', 1, 16, 1],
    ['iterations', 'Solver passes per substep', 1, 24, 1],
    ['cordStiffness', 'Cords (per pass)', 0, 1, 0.05],
    ['shearStiffness', 'Shear (per pass)', 0, 1, 0.05],
    ['bendStiffness', 'Bending (per pass)', 0, 1, 0.01],
    ['shapeStiffness', 'Shape memory (per pass)', 0, 0.3, 0.005],
    ['beadPull', 'Bead grip on rim (per pass)', 0.05, 1, 0.05],
    ['damping', 'Damping (1/s)', 0, 30, 0.5],
    ['friction', 'Rubber friction', 0.2, 2, 0.05],
    ['contactRadius', 'Tread thickness (m)', 0.005, 0.06, 0.005],
    ['rubberMass', 'Rubber mass (kg)', 2, 40, 1],
    ['segmentsAround', 'Segments around', 16, 48, 1],
    ['segmentsAcross', 'Segments across', 6, 10, 1],
    ['beadRings', 'Bead width (rings)', 0, 2, 1],
  ]) {
    folder.add(GPU_TIRE, key, min, max, step).name(label).onChange(apply(key));
  }
  folder.close();
  return folder;
}

// Body panels share the paint material; hiding them shows the frame and running gear.
export function applyBodyVisibility(world) {
  const car = world.queryFirst(IsPlayer, Vehicle);
  const object = car?.get(View)?.object;
  object?.traverse((o) => {
    if (o.isMesh && o.material === paint) o.visible = CONTROLS.showBody;
  });
}
