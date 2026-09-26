// A short-wheelbase 4x4, roughly 1.8 t. Chassis-local axes: +x forward, +y up, +z right.
export const DEFAULT_CAR = Object.freeze({
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
  suspensionRestLength: 0.52,
  maxSuspensionTravel: 0.36,
  // Rapier scales these by chassis mass, so they read as spring rate per kg.
  suspensionStiffness: 15,
  suspensionCompression: 1.3,
  suspensionRelaxation: 1.9,
  frictionSlip: 1.25,
  sideFrictionStiffness: 1.0,

  frontDriveShare: 0.4, // permanent 4WD, rear biased
  maxEngineForce: 8200, // N at the wheels, before the power limit
  enginePower: 130000, // W
  reverseForce: 3600,
  maxBrakeForce: 16500, // N across all wheels
  engineBrakeForce: 4200, // N off throttle, about 0.26 g with drag and rolling resistance
  handbrakeForce: 8000, // N on the rear axle
  maxSteer: 0.62, // rad at walking pace
  steerRate: 2.0, // rad/s
  steeringWheelRatio: 9, // visual: steering wheel turns this much more than the road wheels
  dragCoefficient: 0.75, // 0.5 * rho * Cd * A, boxy body
  rollingResistance: 0.018,
});

const STORAGE_KEY = 'drift.car.v1';
const clone = (value) => JSON.parse(JSON.stringify(value));

function loadSaved() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

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

export function saveCar() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(CAR));
  } catch {
    // Storage can be unavailable (private mode); tuning still works for this session.
  }
}

export function resetCar() {
  merge(CAR, clone(DEFAULT_CAR));
  saveCar();
}

export function importCar(settings) {
  merge(CAR, settings);
  saveCar();
}
