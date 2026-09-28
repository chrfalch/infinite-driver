import { DEFAULT_DRIVETRAIN } from './drivetrain.js';
import { loadSettings, saveSettings } from '../settings-store.js';

// A short-wheelbase 4x4, roughly 1.8 t. Chassis-local axes: +x forward, +y up, +z right.
export const DEFAULT_CAR = Object.freeze({
  // Soft-body tyres on a fully jointed car; false uses Rapier's raycast vehicle with rigid wheels.
  softTires: true,
  // Run the soft tyres on the GPU (TypeGPU compute) instead of Rapier's soft bodies.
  gpuTires: true,
  // Beam axles front and rear (articulating); false gives independent suspension at each corner.
  solidAxles: false,
  mass: 1800,
  // Physics box for the body tub and frame. The wheels stick out past it.
  halfExtents: { x: 1.95, y: 0.34, z: 0.6 },
  // Centre of mass sits low and slightly forward, like a front-engined car.
  centerOfMass: { x: 0.2, y: -0.15, z: 0 },

  wheelRadius: 0.46,
  wheelWidth: 0.34,
  wheelBase: 2.7,
  track: 2.1,
  wheelMountY: -0.08,
  // Wheel alignment, independent suspension (degrees). Camber and toe are the spindle's angles on
  // its upright; caster is the front kingpin's lean back. The car's links still move the wheel as
  // it travels, so the camber at rest also follows the ride height (about +0.6° by default).
  camber: 0, // top of the wheel out is positive
  caster: 5.71, // front only; the rear kingpins are upright
  toeFront: 0, // toe-in is positive (the front of the wheel points in)
  toeRear: 0,
  suspensionRestLength: 0.52,
  maxSuspensionTravel: 0.36,
  // Rapier scales these by chassis mass, so they read as spring rate per kg.
  suspensionStiffness: 15,
  suspensionCompression: 1.3,
  suspensionRelaxation: 1.9,
  frictionSlip: 1.25,
  sideFrictionStiffness: 1.0,

  maxBrakeForce: 16500, // N across all wheels
  handbrakeForce: 16000, // N on the rear axle, enough to hold the rears against the engine
  maxSteer: 0.62, // rad at walking pace
  steerRate: 2.0, // rad/s
  steeringWheelRatio: 9,
  ackermann: 1, // 0 = both front wheels at the same angle, 1 = full Ackermann geometry
  antiDive: 0.4, // share of braking/acceleration pitch taken by the suspension links
  rollStiffness: 1, // solid axles: roll stiffness relative to coil-overs at 80% of the track
  pinionReaction: 1, // solid axles: drive torque twists the axle and rolls the chassis (0 = off)
  rigidBodyRoll: 0.6, // raycast car: body roll from cornering (0 = flat, like Rapier's default) // visual: steering wheel turns this much more than the road wheels
  dragCoefficient: 0.75, // 0.5 * rho * Cd * A, boxy body
  rollingResistance: 0.018,
});

// v2: saves only changed values (v1 held full copies with stale defaults).
const STORAGE_KEY = 'drift.car.v2';
const clone = (value) => JSON.parse(JSON.stringify(value));

const loadSaved = () => loadSettings(STORAGE_KEY);

// Only known keys are taken from saved settings, so stale values cannot break the car.
function merge(target, source) {
  for (const key of Object.keys(target)) {
    if (!(key in source)) continue;
    if (typeof target[key] === 'object') merge(target[key], source[key] ?? {});
    else if (typeof source[key] === typeof target[key]) target[key] = source[key];
  }
  return target;
}

// The live, tunable settings. Systems read from this object every step.
export const CAR = merge(clone(DEFAULT_CAR), loadSaved());

// The game uses the GPU tyres; an older saved choice of tyre model is ignored. For tests,
// ?tires=soft (Rapier soft bodies) or ?tires=rigid (raycast wheels) still selects the others.
CAR.softTires = DEFAULT_CAR.softTires;
CAR.gpuTires = DEFAULT_CAR.gpuTires;
const tiresParam = globalThis.location ? new URLSearchParams(globalThis.location.search).get('tires') : null;
if (tiresParam === 'rigid') CAR.softTires = false;
if (tiresParam === 'soft' || tiresParam === 'gpu') {
  CAR.softTires = true;
  CAR.gpuTires = tiresParam === 'gpu';
}

export function saveCar() {
  saveSettings(STORAGE_KEY, DEFAULT_CAR, CAR);
}

export function resetCar() {
  merge(CAR, clone(DEFAULT_CAR));
  saveCar();
}

export function importCar(settings) {
  merge(CAR, settings);
  saveCar();
}

// Drivetrain settings (see drivetrain.js), persisted like the car settings.
const DRIVETRAIN_KEY = 'drift.drivetrain.v2';
export const DRIVETRAIN = merge(clone(DEFAULT_DRIVETRAIN), loadSettings(DRIVETRAIN_KEY));
export function saveDrivetrain() {
  saveSettings(DRIVETRAIN_KEY, DEFAULT_DRIVETRAIN, DRIVETRAIN);
}
export function resetDrivetrain() {
  merge(DRIVETRAIN, clone(DEFAULT_DRIVETRAIN));
  saveDrivetrain();
}
