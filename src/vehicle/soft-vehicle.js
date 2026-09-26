import { TIRE } from '../tire/config.js';
import { GROUP, createSoftTire, groups } from '../tire/soft-tire.js';
import { CAR } from './config.js';
import { WHEELS, wheelMount } from './physics.js';

const DOWN = { x: 0, y: -1, z: 0 };
const UP = { x: 0, y: 1, z: 0 };
const AXLE = { x: 0, y: 0, z: 1 };
const ORIGIN = { x: 0, y: 0, z: 0 };
// Hub inertia (kg·m²); the axle is local z.
const HUB_INERTIA = { x: 0.5, y: 0.5, z: 0.7 };
const HUB_INERTIA_GPU = { x: 2.5, y: 2.5, z: Number(globalThis.location ? new URLSearchParams(globalThis.location.search).get('hubI') ?? 3.5 : 3.5) };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
// Rotational inertia (kg·m²) of the strut and knuckle links. A point-like link is far lighter
// than the hub and tyre it carries, and the joint solver then cannot pass the steering torque
// through it: the knuckle slips and one front wheel barely steers. Realistic uprights fix that.
const LINK_INERTIA = 1;
const STEER_STIFFNESS = 4e5;
const STEER_DAMPING = 8e3;
// Brake motor gain (N·m per rad/s); the brake torque caps it, like pad friction.
const BRAKE_GRIP = 2e5;

// Quaternion helpers on plain {x, y, z, w} objects.
function rotate(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
const conjugate = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
function multiply(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

// A fully jointed car whose hubs carry soft-body tyres. It exposes the subset of Rapier's
// DynamicRayCastVehicleController API that the rest of the game uses, so both cars are
// driven, drawn, and tuned by the same systems.
export class JointedVehicle {
  constructor(RAPIER, world, chassis, car = CAR, tire = TIRE, { gpuTires = null } = {}) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.body = chassis;
    this.car = car;
    this.tire = tire;
    this.wheels = [];
    this.bodies = [];
    this.joints = [];
    this.softBodies = [];
    // With GPU tyres the hubs get their tyre forces from the GPU solver each step.
    this.gpu = gpuTires;

    const p = chassis.translation();
    const q = chassis.rotation();
    const noCollide = groups(0, 0);
    this.solid = !!car.solidAxles;
    this.axles = this.solid ? [this.createSolidAxle(0, 1), this.createSolidAxle(2, 3)] : [];
    for (let i = 0; i < WHEELS.length; i++) {
      const mount = wheelMount(i, car);
      const front = WHEELS[i].front;
      const localHub = { x: mount.x, y: mount.y - car.suspensionRestLength, z: mount.z };
      const worldHub = rotate(q, localHub);
      const at = { x: p.x + worldHub.x, y: p.y + worldHub.y, z: p.z + worldHub.z };
      const makeBody = (mass) => {
        const body = world.createRigidBody(
          this.RAPIER.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(q).setCanSleep(false),
        );
        world.createCollider(
          this.RAPIER.ColliderDesc.ball(0.05)
            .setMassProperties(mass, ORIGIN, { x: LINK_INERTIA, y: LINK_INERTIA, z: LINK_INERTIA }, IDENTITY)
            .setCollisionGroups(noCollide),
          body,
        );
        this.bodies.push(body);
        return body;
      };

      // Suspension. Independent: a slider straight down from each mount. Solid: the wheel hangs
      // off the end of its axle beam, which carries the springs (see createSolidAxle).
      let strut;
      let slider = null;
      let knuckle;
      let steer = null;
      const solidAxle = this.solid ? this.axles[i < 2 ? 0 : 1] : null;
      if (solidAxle) {
        strut = solidAxle.beam;
        const end = { x: 0, y: 0, z: mount.z };
        if (front) {
          knuckle = makeBody(8);
          steer = world.createImpulseJoint(this.RAPIER.JointData.revolute(end, ORIGIN, UP), strut, knuckle, true);
          steer.setContactsEnabled(false);
          steer.configureMotorModel(this.RAPIER.MotorModel.ForceBased);
          this.joints.push(steer);
        } else {
          knuckle = strut;
        }
      } else {
        strut = makeBody(8);
        slider = world.createImpulseJoint(this.RAPIER.JointData.prismatic(mount, ORIGIN, DOWN), chassis, strut, true);
        slider.setContactsEnabled(false);
        slider.configureMotorModel(this.RAPIER.MotorModel.ForceBased);
        this.joints.push(slider);
        knuckle = strut;
        if (front) {
          knuckle = makeBody(8);
          steer = world.createImpulseJoint(this.RAPIER.JointData.revolute(ORIGIN, ORIGIN, UP), strut, knuckle, true);
          steer.setContactsEnabled(false);
          steer.configureMotorModel(this.RAPIER.MotorModel.ForceBased);
          this.joints.push(steer);
        }
      }

      // Hub on the axle; the tyre's bead is pinned to it.
      const hub = world.createRigidBody(
        this.RAPIER.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(q).setCanSleep(false),
      );
      // The rim only meets the ground if the tyre is squashed flat.
      world.createCollider(
        this.RAPIER.ColliderDesc.cylinder(tire.width / 2 - 0.03, tire.rimRadius - 0.02)
          .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 })
          // GPU tyres carry their rubber outside Rapier, so the hub holds a whole wheel's spin
          // inertia; that also keeps the once-per-step torque exchange with the GPU stable.
          .setMassProperties(22, ORIGIN, gpuTires ? HUB_INERTIA_GPU : HUB_INERTIA, { x: 0, y: 0, z: 0, w: 1 })
          .setFriction(0.6)
          .setCollisionGroups(groups(GROUP.RIM, GROUP.WORLD)),
        hub,
      );
      this.bodies.push(hub);
      // On a solid rear axle the hub turns on the beam end; otherwise on its knuckle's centre.
      const seat = solidAxle && !front ? { x: 0, y: 0, z: mount.z } : ORIGIN;
      const axle = world.createImpulseJoint(this.RAPIER.JointData.revolute(seat, ORIGIN, AXLE), knuckle, hub, true);
      axle.setContactsEnabled(false);
      // The axle joint's motor is the brake: it drives the relative spin to zero with at most the
      // brake torque, solved inside the physics step, so a braked wheel holds without chatter.
      axle.configureMotorModel(this.RAPIER.MotorModel.ForceBased);
      axle.configureMotorVelocity(0, BRAKE_GRIP);
      axle.setMotorMaxForce(0);
      this.joints.push(axle);

      // Right-side tyres are mirror images of the left, like a real pair.
      let soft = null;
      let mesh = null;
      if (!gpuTires) {
        ({ soft, mesh } = createSoftTire(this.RAPIER, world, hub, tire, { mirror: mount.z > 0 }));
        this.softBodies.push(soft);
      }

      this.wheels.push({
        mount,
        front,
        strut,
        knuckle,
        // The body at the wheel centre, used to measure suspension travel.
        center: solidAxle ? (front ? knuckle : hub) : strut,
        hub,
        axleJoint: axle,
        slider,
        steer,
        soft,
        mesh,
        steering: 0,
        engineForce: 0,
        brakeForce: 0,
        suspensionLength: car.suspensionRestLength,
        rotation: 0,
      });
    }
    this.applySpringSettings();
  }

  // A beam axle for wheels a and b: chassis → vertical slider → carrier → roll hinge → beam.
  // The slider carries both corners' springs; the roll hinge lets the axle articulate, with the
  // roll stiffness two coil-overs at the spring spacing would give.
  createSolidAxle(a, b) {
    const { RAPIER, world, body: chassis, car } = this;
    const ma = wheelMount(a, car);
    const mb = wheelMount(b, car);
    const mid = { x: (ma.x + mb.x) / 2, y: ma.y, z: 0 };
    const q = chassis.rotation();
    const p = chassis.translation();
    const local = { x: mid.x, y: mid.y - car.suspensionRestLength, z: 0 };
    const wp = rotate(q, local);
    const at = { x: p.x + wp.x, y: p.y + wp.y, z: p.z + wp.z };
    const make = (mass, inertia) => {
      const b = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(q).setCanSleep(false));
      world.createCollider(RAPIER.ColliderDesc.ball(0.05).setMassProperties(mass, ORIGIN, inertia, IDENTITY).setCollisionGroups(groups(0, 0)), b);
      this.bodies.push(b);
      return b;
    };
    const carrier = make(10, { x: 2, y: 2, z: 2 });
    const track = Math.abs(ma.z - mb.z);
    const beamI = (60 * track * track) / 12;
    const beam = make(60, { x: beamI, y: beamI, z: 1.5 });
    // The differential can hit rocks.
    world.createCollider(
      RAPIER.ColliderDesc.ball(0.15).setTranslation(0, 0.02, track * 0.06).setMass(0.01).setFriction(0.4).setCollisionGroups(groups(GROUP.CHASSIS, GROUP.WORLD)),
      beam,
    );
    const slider = world.createImpulseJoint(RAPIER.JointData.prismatic(mid, ORIGIN, DOWN), chassis, carrier, true);
    slider.setContactsEnabled(false);
    slider.configureMotorModel(RAPIER.MotorModel.ForceBased);
    // Roll about the car's forward axis (+x).
    const roll = world.createImpulseJoint(RAPIER.JointData.revolute(ORIGIN, ORIGIN, { x: 1, y: 0, z: 0 }), carrier, beam, true);
    roll.setContactsEnabled(false);
    roll.configureMotorModel(RAPIER.MotorModel.ForceBased);
    this.joints.push(slider, roll);
    return { beam, carrier, slider, roll, mid, springSpan: track * 0.5, length: car.suspensionRestLength, rollAngle: 0 };
  }

  applySpringSettings() {
    const { car } = this;
    const k = car.suspensionStiffness * car.mass; // N/m per corner, as Rapier's raycast car scales it
    for (const w of this.wheels) {
      w.slider?.setLimits(car.suspensionRestLength - car.maxSuspensionTravel, car.suspensionRestLength + 0.08);
      w.slider?.configureMotorPosition(car.suspensionRestLength, k, car.suspensionCompression * car.mass);
      w.steer?.configureMotorPosition(w.steering, STEER_STIFFNESS, STEER_DAMPING);
    }
    for (const axle of this.axles) {
      axle.slider.setLimits(car.suspensionRestLength - car.maxSuspensionTravel, car.suspensionRestLength + 0.08);
      // Articulation limit: about ±20°, typical of a long-travel beam axle.
      axle.roll.setLimits(-0.35, 0.35);
      this.configureAxleSprings(axle, 0, 0);
    }
  }

  // Two corner springs as one vertical spring plus a roll spring; damping picks bump or rebound.
  configureAxleSprings(axle, heaveSpeed, rollSpeed) {
    const { car } = this;
    const k = car.suspensionStiffness * car.mass;
    const half = axle.springSpan / 2;
    const heaveDamp = (heaveSpeed < 0 ? car.suspensionCompression : car.suspensionRelaxation) * car.mass;
    const rollDamp = (Math.abs(rollSpeed) > 0 ? (car.suspensionCompression + car.suspensionRelaxation) / 2 : car.suspensionCompression) * car.mass;
    axle.slider.configureMotorPosition(car.suspensionRestLength, 2 * k, 2 * heaveDamp);
    axle.roll.configureMotorPosition(0, 2 * k * half * half, 2 * rollDamp * half * half);
  }

  // ---- The raycast-controller surface used by the game ----
  numWheels() {
    return this.wheels.length;
  }
  chassis() {
    return this.body;
  }
  currentVehicleSpeed() {
    const v = this.body.linvel();
    const forward = rotate(this.body.rotation(), { x: 1, y: 0, z: 0 });
    return v.x * forward.x + v.y * forward.y + v.z * forward.z;
  }
  setWheelSteering(i, angle) {
    const w = this.wheels[i];
    if (!w.steer || Math.abs(w.steering - angle) < 1e-5) return;
    w.steering = angle;
    w.steer.configureMotorPosition(angle, STEER_STIFFNESS, STEER_DAMPING);
  }
  // The measured steering angle of the knuckle on its strut, not the commanded one.
  wheelSteering(i) {
    const w = this.wheels[i];
    if (!w.steer) return 0;
    const rel = multiply(conjugate(w.strut.rotation()), w.knuckle.rotation());
    return 2 * Math.atan2(rel.y, rel.w);
  }
  // The hub's pose in the chassis frame, read from the physics bodies, so the drawn rim always
  // sits exactly where the soft tyre's bead is pinned: `position` of the hub, `steer` (the
  // knuckle's rotation in the chassis frame), and `spin` (the hub's rotation on the knuckle).
  wheelHubPose(i) {
    const w = this.wheels[i];
    const qcInv = conjugate(this.body.rotation());
    const pc = this.body.translation();
    const h = w.hub.translation();
    const kq = w.knuckle.rotation();
    return {
      position: rotate(qcInv, { x: h.x - pc.x, y: h.y - pc.y, z: h.z - pc.z }),
      steer: multiply(qcInv, kq),
      spin: multiply(conjugate(kq), w.hub.rotation()),
    };
  }
  setWheelEngineForce(i, force) {
    this.wheels[i].engineForce = force;
  }
  wheelEngineForce(i) {
    return this.wheels[i].engineForce;
  }
  // The game passes brake as an impulse per step (force × dt), like Rapier's controller.
  setWheelBrake(i, impulse) {
    this.wheels[i].brakeImpulse = impulse;
  }
  wheelBrake(i) {
    return this.wheels[i].brakeImpulse ?? 0;
  }
  wheelSuspensionLength(i) {
    return this.wheels[i].suspensionLength;
  }
  // Wheel spin rate relative to its knuckle, rad/s, positive when rolling forward.
  wheelSpin(i) {
    return this.wheels[i].spinRate ?? 0;
  }
  wheelRotation(i) {
    return this.wheels[i].rotation;
  }
  wheelIsInContact(i) {
    return this.wheels[i].suspensionLength < this.car.suspensionRestLength + 0.05;
  }
  // Spring settings are applied together; per-wheel tyre grip comes from the soft tyre itself.
  setWheelSuspensionRestLength() {
    this.dirty = true;
  }
  setWheelMaxSuspensionTravel() {
    this.dirty = true;
  }
  setWheelSuspensionStiffness() {
    this.dirty = true;
  }
  setWheelSuspensionCompression() {
    this.dirty = true;
  }
  setWheelSuspensionRelaxation() {
    this.dirty = true;
  }
  setWheelMaxSuspensionForce() {}
  setWheelFrictionSlip() {}
  setWheelSideFrictionStiffness() {}

  updateVehicle(dt) {
    if (this.dirty) {
      this.applySpringSettings();
      this.dirty = false;
    }
    const { car } = this;
    const qc = this.body.rotation();
    const pc = this.body.translation();
    const qcInv = conjugate(qc);
    for (const axle of this.axles) {
      const c = axle.carrier.translation();
      const local = rotate(qcInv, { x: c.x - pc.x, y: c.y - pc.y, z: c.z - pc.z });
      const length = axle.mid.y - local.y;
      const heave = (length - axle.length) / dt;
      axle.length = length;
      const rel = multiply(conjugate(axle.carrier.rotation()), axle.beam.rotation());
      const angle = 2 * Math.atan2(rel.x, rel.w);
      const rollSpeed = (angle - axle.rollAngle) / dt;
      axle.rollAngle = angle;
      this.configureAxleSprings(axle, heave, rollSpeed);
    }
    for (const w of this.wheels) {
      w.hub.resetTorques(true);
      w.knuckle.resetTorques(true);
    }
    for (const w of this.wheels) {
      // Suspension length from the wheel centre's position in the chassis frame.
      const s = (w.center ?? w.strut).translation();
      const local = rotate(qcInv, { x: s.x - pc.x, y: s.y - pc.y, z: s.z - pc.z });
      const length = w.mount.y - local.y;
      const speed = (length - w.suspensionLength) / dt;
      w.suspensionLength = length;
      // Bump and rebound damping differ, so pick by direction of travel.
      const damping = (speed < 0 ? car.suspensionCompression : car.suspensionRelaxation) * car.mass;
      w.slider?.configureMotorPosition(car.suspensionRestLength, car.suspensionStiffness * car.mass, damping);

      // Hub spin relative to its knuckle, about the axle.
      const rel = multiply(conjugate(w.knuckle.rotation()), w.hub.rotation());
      const spinAxis = rotate(w.knuckle.rotation(), AXLE);
      const wHub = w.hub.angvel();
      const wKnuckle = w.knuckle.angvel();
      const spin =
        (wHub.x - wKnuckle.x) * spinAxis.x + (wHub.y - wKnuckle.y) * spinAxis.y + (wHub.z - wKnuckle.z) * spinAxis.z;
      w.rotation = -2 * Math.atan2(rel.z, rel.w);
      w.spinRate = -spin; // forward rolling is a negative spin about the axle

      // Engine: forward drive rolls the wheel about -axle; its reaction goes into the knuckle (and
      // through it the chassis). Brakes are the axle joint's motor, capped at the brake torque.
      const radius = this.tire.outerRadius;
      const torque = -w.engineForce * radius;
      w.axleJoint.setMotorMaxForce(((w.brakeImpulse ?? 0) / dt) * radius);
      const t = { x: spinAxis.x * torque, y: spinAxis.y * torque, z: spinAxis.z * torque };
      w.hub.addTorque(t, true);
      w.knuckle.addTorque({ x: -t.x, y: -t.y, z: -t.z }, true);
    }
  }

  hubStates() {
    return this.wheels.map((w) => ({
      position: w.hub.translation(),
      rotation: w.hub.rotation(),
      linvel: w.hub.linvel(),
      angvel: w.hub.angvel(),
      mirror: w.mount.z > 0 ? -1 : 1,
    }));
  }

  // Runs the GPU tyres for one step and applies their forces to the hubs (added on top of the
  // drive and brake torques from updateVehicle).
  async stepTyres({ readPositions = false } = {}) {
    if (!this.gpu) return;
    const f = await this.gpu.solver.step(this.hubStates(), { readPositions });
    this.wheels.forEach((w, t) => {
      w.hub.resetForces(true);
      w.hub.addForce({ x: f[t * 8], y: f[t * 8 + 1], z: f[t * 8 + 2] }, true);
      w.hub.addTorque({ x: f[t * 8 + 4], y: f[t * 8 + 5], z: f[t * 8 + 6] }, true);
    });
  }

  dispose() {
    this.gpu?.solver.destroy();
    for (const soft of this.softBodies) this.world.removeSoftBody(soft);
    for (const joint of this.joints) this.world.removeImpulseJoint(joint, false);
    for (const body of this.bodies) this.world.removeRigidBody(body);
  }
}

export function createSoftCarBody(RAPIER, world, position, car = CAR, tire = TIRE, options = {}) {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setCanSleep(false),
  );
  const { x: hx, y: hy, z: hz } = car.halfExtents;
  const m = car.mass;
  const inertia = {
    x: (m / 12) * (4 * hy * hy + 4 * hz * hz) * 1.6,
    y: (m / 12) * (4 * hx * hx + 4 * hz * hz),
    z: (m / 12) * (4 * hx * hx + 4 * hy * hy),
  };
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setMassProperties(m, car.centerOfMass, inertia, { w: 1, x: 0, y: 0, z: 0 })
      .setFriction(0.5)
      .setRestitution(0.05)
      .setCollisionGroups(groups(GROUP.CHASSIS, GROUP.WORLD)),
    body,
  );
  const controller = new JointedVehicle(RAPIER, world, body, car, tire, options);
  controller.gpu?.solver.reset(controller.hubStates());
  return { body, controller };
}

// Height of the chassis origin above the ground for a car standing on soft tyres.
export function softCarRideHeight(car = CAR, tire = TIRE) {
  return tire.outerRadius + car.suspensionRestLength - car.wheelMountY + 0.05;
}
