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
    // Independent suspension limits the track to what its arms allow (see ifsTrackOffset).
    z: (i % 2 === 0 ? -1 : 1) * (car.solidAxles === false ? Math.max(0.85, Math.min(1.5, car.track * 0.5)) : car.track * 0.5),
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
  }
  applyWheelSettings(controller, car);
  return { body, controller };
}

// Settings the controller stores per wheel. Safe to call any time to apply tuning live.
export function applyWheelSettings(controller, car = CAR) {
  for (let i = 0; i < WHEELS.length; i++) {
    controller.setWheelSuspensionRestLength(i, car.suspensionRestLength);
    controller.setWheelMaxSuspensionTravel(i, car.maxSuspensionTravel);
    controller.setWheelSuspensionStiffness(i, car.suspensionStiffness);
    controller.setWheelSuspensionCompression(i, car.suspensionCompression);
    controller.setWheelSuspensionRelaxation(i, car.suspensionRelaxation);
    controller.setWheelMaxSuspensionForce(i, 1e6);
    controller.setWheelFrictionSlip(i, car.frictionSlip);
    controller.setWheelSideFrictionStiffness(i, car.sideFrictionStiffness);
  }
}

// Front wheel angles (left, right) for a mean steering angle.
export function ackermann(steer, car = CAR) {
  if (Math.abs(steer) < 1e-4 || !car.ackermann) return [steer, steer];
  const L = car.wheelBase;
  const half = car.track / 2;
  const R = L / Math.tan(Math.abs(steer)); // turn radius at the axle centre
  const inner = Math.atan(L / (R - half));
  const outer = Math.atan(L / (R + half));
  const k = car.ackermann;
  const mix = (a) => (a * k + Math.abs(steer) * (1 - k)) * Math.sign(steer);
  // Turning left (steer > 0), the left wheel is on the inside.
  return steer > 0 ? [mix(inner), mix(outer)] : [mix(outer), mix(inner)];
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
  // Ackermann: the inner front wheel turns tighter than the outer, so both roll around the same
  // centre (positive steer turns left; wheel 0 is front-left).
  const [left, right] = ackermann(state.steer, car);
  controller.setWheelSteering(0, left);
  controller.setWheelSteering(1, right);

  // Pedals: in a forward gear ▲ drives and ▼ brakes; at a standstill ▼ asks for reverse, and in
  // reverse the roles swap (▼ backs up, ▲ brakes).
  const drivetrain = state.drivetrain;
  const inReverse = drivetrain.gear < 0 || drivetrain.pendingGear === -1;
  let brake = 0;
  let throttle = 0;
  let reverseRequest = false;
  if (!inReverse) {
    if (input.brake > 0) {
      if (speed > 0.5) brake = input.brake * car.maxBrakeForce;
      else reverseRequest = true;
    }
    if (input.throttle > 0) {
      if (speed < -0.5) brake = Math.max(brake, input.throttle * car.maxBrakeForce);
      else throttle = input.throttle;
    }
  } else {
    if (input.throttle > 0) {
      if (speed < -0.5) brake = input.throttle * car.maxBrakeForce;
      else drivetrain.shiftTo(1);
    }
    if (input.brake > 0) {
      if (speed > 0.5) brake = Math.max(brake, input.brake * car.maxBrakeForce);
      else {
        throttle = input.brake;
        reverseRequest = true;
      }
    }
  }

  // Engine, clutch, gearbox, and differentials turn pedal input into torque per wheel. The
  // drivetrain works with the measured rolling radius, not the unloaded tyre radius.
  const radius = controller.tire?.outerRadius ?? car.wheelRadius;
  const rolling = controller.rollingRadius ? controller.rollingRadius() : radius;
  const spins = [0, 1, 2, 3].map((i) => (controller.wheelSpin ? controller.wheelSpin(i) : speed / rolling));
  const torques = drivetrain.update(dt, { throttle, reverseRequest }, spins, speed, rolling);

  // With nothing pressed at walking pace, the clutch is out and there is no engine braking left, so
  // roll gently to a stop and hold there (like a light touch on the brake).
  const idleInput = input.throttle === 0 && input.brake === 0;
  const hold = idleInput && absSpeed < 2 ? car.mass * (absSpeed < 0.4 ? 3 : 1.2) : 0;

  // Rapier applies brake as an impulse per step, so convert from force.
  const frontBrake = (brake * 0.35 + hold * 0.25) * dt;
  const rearBrake = (brake * 0.15 + hold * 0.25 + (input.handbrake ? car.handbrakeForce * 0.5 : 0)) * dt;
  const brakes = [frontBrake, frontBrake, rearBrake, rearBrake];
  // Brake lights: on for the pedal and the handbrake (not for the gentle hold at a standstill).
  state.braking = brake > 0 || input.handbrake;
  for (let i = 0; i < 4; i++) {
    // Rapier's raycast car ignores the brake on a wheel that has engine force, so a braking wheel
    // gets no drive there. (The jointed car brakes through its axle motors and keeps both.)
    const drive = !controller.wheels && brakes[i] > 0 ? 0 : torques[i] / radius;
    controller.setWheelEngineForce(i, drive);
    controller.setWheelBrake(i, brakes[i]);
  }
  // The handbrake locks the rears, so they slide more easily.
  const rearSlip = input.handbrake ? car.frictionSlip * 0.55 : car.frictionSlip;
  controller.setWheelFrictionSlip(2, rearSlip);
  controller.setWheelFrictionSlip(3, rearSlip);

  // Air drag along the velocity, and rolling resistance along the forward ground speed only.
  // Forces are reset every step so nothing stale is left over. The soft tyres lose energy in the
  // rubber and the soil themselves, so they add no extra rolling resistance.
  body.resetForces(true);
  const v = body.linvel();
  const vmag = Math.hypot(v.x, v.y, v.z);
  if (vmag > 0.01) {
    const drag = Math.min(car.dragCoefficient * vmag * vmag, (car.mass * vmag) / dt) / vmag;
    body.addForce({ x: -v.x * drag, y: -v.y * drag, z: -v.z * drag }, true);
  }
  const grounded = [0, 1, 2, 3].some((i) => controller.wheelIsInContact(i));
  // Raycast car: Rapier applies the tyre side forces near the centre of mass, so the body barely
  // rolls. Add the roll moment the side force would make below the centre of mass.
  if (!controller.wheels && grounded && car.rigidBodyRoll > 0) {
    const w = body.angvel();
    const q0 = body.rotation();
    const up = { x: 2 * (q0.x * q0.y - q0.w * q0.z), y: 1 - 2 * (q0.x * q0.x + q0.z * q0.z), z: 2 * (q0.y * q0.z + q0.w * q0.x) };
    const yawRate = w.x * up.x + w.y * up.y + w.z * up.z;
    const lateralAccel = speed * yawRate; // centripetal, toward the turn centre
    const rollMoment = car.rigidBodyRoll * car.mass * lateralAccel * 0.45; // about 0.45 m of arm
    // Body leans away from the turn: a left turn (positive yaw) rolls it to the right (+x torque).
    const fwd = { x: 1 - 2 * (q0.y * q0.y + q0.z * q0.z), y: 2 * (q0.x * q0.y + q0.w * q0.z), z: 2 * (q0.x * q0.z - q0.w * q0.y) };
    body.resetTorques(true);
    body.addTorque({ x: fwd.x * rollMoment, y: fwd.y * rollMoment, z: fwd.z * rollMoment }, true);
  }
  if (!controller.wheels && grounded && absSpeed > 0.05) {
    const q = body.rotation();
    const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
    const fz = 2 * (q.x * q.z - q.w * q.y);
    const fl = Math.hypot(fx, fz) || 1;
    const roll = Math.min(car.rollingResistance * car.mass * 9.81, (car.mass * absSpeed) / dt) * Math.sign(speed);
    body.addForce({ x: (-fx / fl) * roll, y: 0, z: (-fz / fl) * roll }, true);
  }
}
