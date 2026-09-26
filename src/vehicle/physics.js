import { CAR } from './config.js';

export const WHEELS = [
  { name: 'FL', front: true },
  { name: 'FR', front: true },
  { name: 'RL', front: false },
  { name: 'RR', front: false },
];

export function wheelMount(i, car = CAR) {
  const w = WHEELS[i];
  return {
    x: (w.front ? 1 : -1) * car.wheelBase * 0.5,
    y: car.wheelMountY,
    z: (i % 2 === 0 ? -1 : 1) * car.track * 0.5,
  };
}

export function createCarBody(RAPIER, world, position, car = CAR) {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setCanSleep(false)
      .setCcdEnabled(true),
  );

  const { x: hx, y: hy, z: hz } = car.halfExtents;
  const m = car.mass;
  // Box inertia, with a bit more yaw inertia because real mass is spread out along the car.
  const inertia = {
    x: (m / 12) * (4 * hy * hy + 4 * hz * hz) * 1.6,
    y: (m / 12) * (4 * hx * hx + 4 * hz * hz),
    z: (m / 12) * (4 * hx * hx + 4 * hy * hy),
  };
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setMassProperties(m, car.centerOfMass, inertia, { w: 1, x: 0, y: 0, z: 0 })
      .setFriction(0.5)
      .setRestitution(0.05),
    body,
  );

  const controller = world.createVehicleController(body);
  for (let i = 0; i < WHEELS.length; i++) {
    controller.addWheel(
      wheelMount(i, car),
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      car.suspensionRestLength,
      car.wheelRadius,
    );
    controller.setWheelMaxSuspensionTravel(i, car.maxSuspensionTravel);
    controller.setWheelSuspensionStiffness(i, car.suspensionStiffness);
    controller.setWheelSuspensionCompression(i, car.suspensionCompression);
    controller.setWheelSuspensionRelaxation(i, car.suspensionRelaxation);
    controller.setWheelMaxSuspensionForce(i, 1e6);
    controller.setWheelFrictionSlip(i, car.frictionSlip);
    controller.setWheelSideFrictionStiffness(i, car.sideFrictionStiffness);
  }
  return { body, controller };
}

// Converts driver input into wheel forces for one physics substep.
export function applyDriverInput(state, input, dt, car = CAR) {
  const { controller, body } = state;
  const speed = controller.currentVehicleSpeed();
  const absSpeed = Math.abs(speed);

  // Speed-sensitive steering: full lock when parking, much less on the highway.
  const steerLimit = car.maxSteer / (1 + absSpeed * 0.06);
  const target = input.steer * steerLimit;
  const maxDelta = car.steerRate * dt;
  state.steer += Math.max(-maxDelta, Math.min(maxDelta, target - state.steer));
  controller.setWheelSteering(0, state.steer);
  controller.setWheelSteering(1, state.steer);

  let drive = 0;
  let brake = 0;
  if (input.throttle > 0) {
    if (speed < -0.5) brake = input.throttle * car.maxBrakeForce;
    else drive = input.throttle * Math.min(car.maxEngineForce, car.enginePower / Math.max(absSpeed, 1));
  }
  if (input.brake > 0) {
    if (speed > 0.5) brake = Math.max(brake, input.brake * car.maxBrakeForce);
    else drive = -input.brake * car.reverseForce;
  }

  const front = drive * car.frontDriveShare * 0.5;
  const rear = drive * (1 - car.frontDriveShare) * 0.5;
  controller.setWheelEngineForce(0, front);
  controller.setWheelEngineForce(1, front);
  controller.setWheelEngineForce(2, rear);
  controller.setWheelEngineForce(3, rear);

  // Off the accelerator the engine holds the car back through the 4WD driveline.
  const engineBrake = input.throttle === 0 && input.brake === 0 ? car.engineBrakeForce : 0;

  // Rapier applies brake as an impulse per step, so convert from force.
  const frontBrake = (brake * 0.35 + engineBrake * car.frontDriveShare * 0.5) * dt;
  const rearBrake =
    (brake * 0.15 + engineBrake * (1 - car.frontDriveShare) * 0.5 + (input.handbrake ? car.handbrakeForce * 0.5 : 0)) * dt;
  controller.setWheelBrake(0, frontBrake);
  controller.setWheelBrake(1, frontBrake);
  controller.setWheelBrake(2, rearBrake);
  controller.setWheelBrake(3, rearBrake);
  // The handbrake locks the rears, so they slide more easily.
  const rearSlip = input.handbrake ? car.frictionSlip * 0.55 : car.frictionSlip;
  controller.setWheelFrictionSlip(2, rearSlip);
  controller.setWheelFrictionSlip(3, rearSlip);

  // Air drag and rolling resistance.
  const v = body.linvel();
  const vmag = Math.hypot(v.x, v.y, v.z);
  if (vmag > 0.01) {
    const grounded = [0, 1, 2, 3].some((i) => controller.wheelIsInContact(i));
    const resist = car.dragCoefficient * vmag * vmag + (grounded ? car.rollingResistance * car.mass * 9.81 : 0);
    const k = -Math.min(resist, (car.mass * vmag) / dt) / vmag;
    body.resetForces(true);
    body.addForce({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
  }
}
