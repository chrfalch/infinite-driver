// Roughly a 1.2 t rear-wheel-drive hatchback. Chassis-local axes: +x forward, +y up, +z right.
export const CAR = {
  mass: 1200,
  halfExtents: { x: 2.05, y: 0.32, z: 0.86 },
  // Centre of mass sits low and slightly forward, like a front-engined car.
  centerOfMass: { x: 0.15, y: -0.2, z: 0 },

  wheelRadius: 0.33,
  wheelWidth: 0.22,
  wheelBase: 2.55,
  track: 1.5,
  wheelMountY: -0.12,
  suspensionRestLength: 0.32,
  maxSuspensionTravel: 0.22,
  // Rapier scales these by chassis mass, so they read as spring rate per kg.
  suspensionStiffness: 26,
  suspensionCompression: 1.9,
  suspensionRelaxation: 2.6,
  frictionSlip: 1.35,
  sideFrictionStiffness: 1.0,

  maxEngineForce: 4800, // N at the rear axle, before the power limit
  enginePower: 95000, // W
  reverseForce: 2200,
  maxBrakeForce: 11000, // N across all wheels
  handbrakeForce: 6000, // N on the rear axle
  maxSteer: 0.6, // rad at walking pace
  steerRate: 2.2, // rad/s
  dragCoefficient: 0.42, // 0.5 * rho * Cd * A
  rollingResistance: 0.012,
};
