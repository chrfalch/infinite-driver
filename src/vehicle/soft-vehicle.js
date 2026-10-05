import { TIRE } from '../tire/config.js';
import { MAX_TIRES } from '../tire/gpu-tire-solver.js';
import { GROUP, createSoftTire, groups } from '../tire/soft-tire.js';
import { CAR, DRIVETRAIN } from './config.js';
import { WHEELS, frameStretch, wheelMount } from './physics.js';
import { DESIGN_WHEEL_MOUNT_Y, IFS_ARM_LIMIT, IFS_RACK, ifsCorner, ifsRack, ifsSpindleLift, ifsSpringOffset, spindleAlignment } from './frame-geometry.js';

const DOWN = { x: 0, y: -1, z: 0 };
const UP = { x: 0, y: 1, z: 0 };
const AXLE = { x: 0, y: 0, z: 1 };
const ORIGIN = { x: 0, y: 0, z: 0 };
// Hub inertia (kg·m²); the axle is local z.
const HUB_INERTIA = { x: 0.5, y: 0.5, z: 0.7 };
const HUB_INERTIA_GPU = { x: 2.5, y: 2.5, z: Number(globalThis.location ? new URLSearchParams(globalThis.location.search).get('hubI') ?? 3.5 : 3.5) };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const MAX_DRIVE_INERTIA = 60; // kg·m² per hub, see setDriveInertia
// Rotational inertia (kg·m²) of the strut and knuckle links. A point-like link is far lighter
// than the hub and tyre it carries, and the joint solver then cannot pass the steering torque
// through it: the knuckle slips and one front wheel barely steers. Realistic uprights fix that.
const LINK_INERTIA = 1;
const STEER_STIFFNESS = 4e5;
const STEER_DAMPING = 8e3;
// Steering arm: the tie rod end sits this far (m) from the kingpin, so rack travel ≈ arm × sin(angle).
const IFS_STEER_ARM = 0.14;
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
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
// World position of a point given in a body's local frame.
function worldPoint(body, local) {
  const t = body.translation();
  const r = rotate(body.rotation(), local);
  return { x: t.x + r.x, y: t.y + r.y, z: t.z + r.z };
}
// World velocity of a body's point at world position p.
function pointVelocity(body, p) {
  const t = body.translation();
  const v = body.linvel();
  const w = body.angvel();
  const c = cross(w, sub(p, t));
  return { x: v.x + c.x, y: v.y + c.y, z: v.z + c.z };
}
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
// Each axle's springs and dampers are rated for the load it carries. The centre of mass sits
// forward of the middle, so equal springs would leave the nose low; scaled like this, both ends
// compress the same and the car sits level. Returns the factor on the per-corner rate.
function axleLoadFactor(front, car) {
  const share = 0.5 + (car.centerOfMass?.x ?? 0) / car.wheelBase;
  return 2 * (front ? share : 1 - share);
}

export class JointedVehicle {
  constructor(RAPIER, world, chassis, car = CAR, tire = TIRE, { gpuTires = null } = {}) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.body = chassis;
    this.car = car;
    // Collider handle -> what hit (a wheel index for a rim, 'chassis'), for the sound.
    this.soundColliders = new Map();
    this.rackGeo = ifsRack(car); // the rack moves with the front of the frame (wheelbase)
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
    this.rack = this.solid ? null : this.createRack();
    for (let i = 0; i < WHEELS.length; i++) {
      const mount = wheelMount(i, car);
      // Independent suspension (see ifsSpindleLift): taller uprights put the wheel centre lower, and
      // the spring offset raises the wheel's rest position. The car is built at the design point
      // and settles to the new height, so the arms and coil-overs follow instead of the springs
      // starting preloaded (bouncy). Suspension length is measured from the wheel centre, so the
      // mount moves down with the spindle lift.
      if (!this.solid) mount.y = DESIGN_WHEEL_MOUNT_Y + ifsSpringOffset(car) - ifsSpindleLift(car);
      const front = WHEELS[i].front;
      const localHub = this.solid
        ? { x: mount.x, y: mount.y - car.suspensionRestLength, z: mount.z }
        : ifsCorner(i, car).wheel;
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
      let ifs = null;
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
        ifs = this.createCorner(i);
        strut = ifs.upright;
        knuckle = ifs.upright;
      }

      // Hub on the axle; the tyre's bead is pinned to it. With independent suspension it turns
      // with its upright's spindle (camber and toe).
      const hubRotation = this.solid ? q : multiply(q, spindleAlignment(i, car));
      const hub = world.createRigidBody(
        this.RAPIER.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(hubRotation).setCanSleep(false),
      );
      // The rim only meets the ground if the tyre is squashed flat. Its contact forces are reported
      // for the sound (a rim strike; see systems/physics.js).
      const rim = world.createCollider(
        this.RAPIER.ColliderDesc.cylinder(tire.width / 2 - 0.03, tire.rimRadius - 0.02)
          .setActiveEvents(this.RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(300)
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

      this.soundColliders.set(rim.handle, this.wheels.length);
      this.wheels.push({
        mount,
        front,
        strut,
        knuckle,
        // The body at the wheel centre, used to measure suspension travel.
        center: solidAxle ? (front ? knuckle : hub) : strut,
        ifs,
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

  // A dynamic link body at chassis-local point `local`, turned with the chassis (and by `turn`,
  // a chassis-frame rotation).
  createLink(local, mass, inertia, turn = IDENTITY) {
    const { RAPIER, world, body: chassis } = this;
    const q = multiply(chassis.rotation(), turn);
    const p = chassis.translation();
    const w = rotate(q, local);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x + w.x, p.y + w.y, p.z + w.z).setRotation(q).setCanSleep(false),
    );
    world.createCollider(
      RAPIER.ColliderDesc.ball(0.04).setMassProperties(mass, ORIGIN, { x: inertia, y: inertia, z: inertia }, IDENTITY).setCollisionGroups(groups(0, 0)),
      body,
    );
    this.bodies.push(body);
    return body;
  }

  joint(data, a, b) {
    const j = this.world.createImpulseJoint(data, a, b, true);
    j.setContactsEnabled(false);
    this.joints.push(j);
    return j;
  }

  // Independent suspension: a steering rack across the nose box, sliding sideways on the chassis.
  // The rack and tie rods are heavier than the real parts: with a 4 kg rack and 2 kg tie rods the
  // joint solver could not hold the rack at its limits against tyres gripping the ground at a
  // standstill, and the wheels turned only half way to full lock (about 23° of 45°).
  createRack() {
    const rack = this.createLink(this.rackGeo.center, 20, 1.5);
    const slide = this.joint(this.RAPIER.JointData.prismatic(this.rackGeo.center, ORIGIN, AXLE), this.body, rack);
    // The rack is held at the steering position by the joint's limits (a hard constraint): a
    // position motor is too soft against the tyres' aligning torque and the wheels steer late.
    slide.setLimits(0, 0);
    return { body: rack, slide, target: 0 };
  }

  // One double A-arm corner: lower and upper arms hinged on the chassis, an upright on two ball
  // joints, and a tie rod from the rack (front) or the chassis (rear, a fixed toe link).
  createCorner(i) {
    const { RAPIER, body: chassis } = this;
    const G = ifsCorner(i, this.car);
    const lower = this.createLink(G.lowerBall, 8, 0.6);
    const upper = this.createLink(G.upperBall, 5, 0.4);
    // The upright is built turned by the spindle's camber and toe; its ball joints and steering
    // arm stay where they are, so their anchors on it are turned back by the same amount.
    const align = spindleAlignment(i, this.car);
    const upright = this.createLink(G.wheel, 10, 0.6, align);
    const onUpright = (p) => rotate(conjugate(align), sub(p, G.wheel));
    const hinge = (inner, ball, arm) => {
      const pivot = midpoint(inner[0], inner[1]);
      const d = sub(inner[0], inner[1]);
      const len = Math.hypot(d.x, d.y, d.z);
      const axis = { x: d.x / len, y: d.y / len, z: d.z / len };
      const j = this.joint(RAPIER.JointData.revolute(pivot, sub(pivot, ball), axis), chassis, arm);
      j.setLimits(-IFS_ARM_LIMIT, IFS_ARM_LIMIT);
      return { joint: j, pivot, axis };
    };
    const lowerHinge = hinge(G.lowerInner, G.lowerBall, lower);
    const upperHinge = hinge(G.upperInner, G.upperBall, upper);
    // Upper arm travel is limited by the lower arm; give it room so it never binds first.
    upperHinge.joint.setLimits(-IFS_ARM_LIMIT * 1.6, IFS_ARM_LIMIT * 1.6);
    this.joint(RAPIER.JointData.spherical(ORIGIN, onUpright(G.lowerBall)), lower, upright);
    this.joint(RAPIER.JointData.spherical(ORIGIN, onUpright(G.upperBall)), upper, upright);
    const tieMid = midpoint(G.tieInner, G.tieOuter);
    const tie = this.createLink(tieMid, 6, 0.5);
    const tieOnUpright = onUpright(G.tieOuter);
    this.joint(RAPIER.JointData.spherical(sub(G.tieOuter, tieMid), tieOnUpright), tie, upright);
    if (G.front) {
      this.joint(RAPIER.JointData.spherical(sub(G.tieInner, this.rackGeo.center), sub(G.tieInner, tieMid)), this.rack.body, tie);
    } else {
      this.joint(RAPIER.JointData.spherical(G.tieInner, sub(G.tieInner, tieMid)), chassis, tie);
    }
    return { G, lower, upper, upright, tie, tieOnUpright, lowerHinge, upperHinge, shockLocal: sub(G.shockBottom, G.lowerBall) };
  }

  // Coil-over force for one double A-arm corner. The wheel rate (and bump/rebound damping) is the
  // same as the other suspensions'; the spring and damper act along the shock between the chassis
  // and the lower arm, so their force is the wheel force divided by the motion ratio.
  applyCoilOver(w, dt, qc, pc) {
    const { car } = this;
    const c = w.ifs;
    const top = worldPoint(this.body, c.G.shockTop);
    const bottom = worldPoint(c.lower, c.shockLocal);
    const d = sub(bottom, top);
    const L = Math.hypot(d.x, d.y, d.z) || 1;
    const u = { x: d.x / L, y: d.y / L, z: d.z / L };
    // Motion ratio from the lower arm's rotation: shock length change per wheel lift.
    const axis = rotate(qc, c.lowerHinge.axis);
    const pivot = worldPoint(this.body, c.lowerHinge.pivot);
    const ball = c.lower.translation();
    const up = rotate(qc, UP);
    const dL = dot(u, cross(axis, sub(bottom, pivot)));
    const dY = dot(up, cross(axis, sub(ball, pivot)));
    const ratio = Math.max(0.2, Math.abs(dY) > 1e-6 ? Math.abs(dL / dY) : 0.65);
    w.motionRatio = ratio;
    // Wheel force: spring from the rest length, damping from the travel speed (as the sliders).
    const load = axleLoadFactor(w.front, car);
    const k = car.suspensionStiffness * car.mass * load;
    const speed = w.travelSpeed ?? 0;
    const damping = (speed < 0 ? car.suspensionCompression : car.suspensionRelaxation) * car.mass * load;
    const wheelForce = k * (car.suspensionRestLength - w.suspensionLength) - damping * speed;
    const f = Math.max(-2e4, Math.min(6e4, wheelForce)) / ratio;
    c.lower.addForceAtPoint({ x: u.x * f, y: u.y * f, z: u.z * f }, bottom, true);
    this.body.addForceAtPoint({ x: -u.x * f, y: -u.y * f, z: -u.z * f }, top, true);
    w.shockLength = L;
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
    // The carrier turns with the chassis (the slider locks its rotation), so its inertia only adds
    // to the chassis'. A tiny value leaves a 1500:2 inertia ratio across the slider, and Rapier's
    // solver then settles with the car leaning about 1.7° at rest; 200 is still small next to the
    // chassis but lets the joints converge.
    const carrier = make(10, { x: 200, y: 200, z: 200 });
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
    return { beam, carrier, slider, roll, mid, front: WHEELS[a].front, springSpan: track * 0.8 * Math.sqrt(car.rollStiffness ?? 1), length: car.suspensionRestLength, rollAngle: 0 };
  }

  applySpringSettings() {
    const { car } = this;
    const k = car.suspensionStiffness * car.mass; // N/m per corner, as Rapier's raycast car scales it
    for (const w of this.wheels) {
      const load = axleLoadFactor(w.front, car);
      w.slider?.setLimits(car.suspensionRestLength - car.maxSuspensionTravel, car.suspensionRestLength + 0.08);
      w.slider?.configureMotorPosition(car.suspensionRestLength, k * load, car.suspensionCompression * car.mass * load);
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
    const load = axleLoadFactor(axle.front, car);
    const k = car.suspensionStiffness * car.mass * load;
    const half = axle.springSpan / 2;
    const heaveDamp = (heaveSpeed < 0 ? car.suspensionCompression : car.suspensionRelaxation) * car.mass * load;
    const rollDamp = (Math.abs(rollSpeed) > 0 ? (car.suspensionCompression + car.suspensionRelaxation) / 2 : car.suspensionCompression) * car.mass * load;
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
    if (this.rack && w.front) {
      // One rack steers both wheels: its travel follows the mean angle, and the steering arms'
      // geometry gives each wheel its own angle (Ackermann).
      w.steering = angle;
      const mean = (this.wheels[0].steering + (this.wheels[1]?.steering ?? angle)) / 2;
      const target = -IFS_STEER_ARM * Math.sin(mean);
      const clamped = Math.max(-IFS_RACK.travel, Math.min(IFS_RACK.travel, target));
      if (Math.abs(clamped - this.rack.target) > 1e-6) {
        this.rack.target = clamped;
        this.rack.slide.setLimits(clamped, clamped);
      }
      return;
    }
    if (!w.steer || Math.abs(w.steering - angle) < 1e-5) return;
    w.steering = angle;
    w.steer.configureMotorPosition(angle, STEER_STIFFNESS, STEER_DAMPING);
  }
  // The measured steering angle of the knuckle on its strut, not the commanded one.
  wheelSteering(i) {
    const w = this.wheels[i];
    if (w.ifs) {
      const rel = multiply(conjugate(this.body.rotation()), w.ifs.upright.rotation());
      return 2 * Math.atan2(rel.y, rel.w);
    }
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
  // Double A-arm points of corner i in the chassis frame, read from the physics links (for drawing).
  suspensionPose(i) {
    const w = this.wheels[i];
    const c = w.ifs;
    if (!c) return null;
    const qcInv = conjugate(this.body.rotation());
    const pc = this.body.translation();
    const local = (p) => rotate(qcInv, sub(p, pc));
    const G = c.G;
    return {
      lowerInner: G.lowerInner,
      upperInner: G.upperInner,
      lowerBall: local(c.lower.translation()),
      upperBall: local(c.upper.translation()),
      tieInner: G.front ? local(worldPoint(this.rack.body, sub(G.tieInner, this.rackGeo.center))) : G.tieInner,
      tieOuter: local(worldPoint(c.upright, c.tieOnUpright)),
      shockTop: G.shockTop,
      shockBottom: local(worldPoint(c.lower, c.shockLocal)),
      spindle: local(c.upright.translation()),
      rack: this.rack ? local(this.rack.body.translation()) : null,
    };
  }

  // Extra spin inertia per wheel from the engine's flywheel while the clutch is locked (see
  // Drivetrain.coupledInertia). Capped at MAX_DRIVE_INERTIA: the full share in low first (about
  // 250 kg·m²) on a hub jointed to a ~10 kg knuckle was more than Rapier's joint solver could hold
  // steady, and the hub shook.
  // With GPU tyres the flywheel is not put on the Rapier hub: a body with 25 times the inertia about
  // its axle as across it precesses far faster than the step (about 1200 rad/s at 50 rad/s of
  // spin), Rapier's gyroscopic step then blows any wobble up, and the tyre folds inside out on its
  // bead (a wheel spinning in a snow bank in low gear). The flywheel only resists the spin, so the
  // hub gets its share of the spin torques instead (see spinShare) and the GPU hub step uses the
  // whole inertia. Rapier's soft tyres pass their torque through joints, so they keep it on the hub.
  setDriveInertia(share) {
    const perWheel = Math.min(MAX_DRIVE_INERTIA, share);
    for (const w of this.wheels) {
      if (Math.abs(perWheel - (w.driveInertia ?? 0)) <= 0.02 * Math.max(1, perWheel)) continue;
      w.driveInertia = perWheel;
      if (!this.gpu) w.hub.setAdditionalMassProperties(1e-4, ORIGIN, { x: 0, y: 0, z: perWheel }, IDENTITY, true);
    }
  }

  // Share of a spin torque that turns the Rapier hub; the rest turns the engine's flywheel (GPU tyres).
  spinShare(w) {
    if (!this.gpu) return 1;
    return HUB_INERTIA_GPU.z / (HUB_INERTIA_GPU.z + (w.driveInertia ?? 0));
  }

  // The GPU tyre's force and torque on hub `w`. About the axle the hub takes its share of the
  // torque (see spinShare); the flywheel's share of the brake reacts on the knuckle, as the
  // caliper holds the whole wheel. The brake torque on the wheel and flywheel is worked out as the
  // GPU hub step does: it stops the spin relative to the knuckle if it can, else it slips.
  applyHubTyre(w, fx, fy, fz, tx, ty, tz) {
    w.tyreLoad = fy; // N, upward: what the ground carries (the sound reads it)
    w.hub.resetForces(true);
    w.hub.addForce({ x: fx, y: fy, z: fz }, true);
    const share = this.spinShare(w);
    const a = w.spinAxis;
    if (share < 1 && a) {
      const along = tx * a.x + ty * a.y + tz * a.z;
      const cut = along * (1 - share);
      tx -= a.x * cut;
      ty -= a.y * cut;
      tz -= a.z * cut;
      if (w.brakeTorque > 0) {
        const I = HUB_INERTIA_GPU.z + w.driveInertia;
        const dt = this.stepDt;
        const sum = along + w.driveTorque;
        const rel = w.relSpin + (dt * sum) / I;
        const brake = Math.abs(rel) <= (dt * w.brakeTorque) / I ? -((w.relSpin * I) / dt + sum) : -Math.sign(rel) * w.brakeTorque;
        const r = -(1 - share) * brake;
        w.knuckle.addTorque({ x: a.x * r, y: a.y * r, z: a.z * r }, true);
      }
    }
    w.hub.addTorque({ x: tx, y: ty, z: tz }, true);
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
  // Effective rolling radius of a loaded soft tyre (measured about 0.92–0.94 of the unloaded
  // radius); the drivetrain and slip logic use it instead of the unloaded radius.
  rollingRadius() {
    return this.tire.outerRadius * 0.925;
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
    this.stepDt = dt;
    // Chassis and axle torques are rebuilt every step (Rapier keeps added torques until reset).
    this.body.resetTorques(true);
    for (const axle of this.axles) axle.beam.resetTorques(true);
    this.applyLinkTorques(dt, qc);
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
      if (w.ifs) {
        w.ifs.lower.resetForces(true);
        w.ifs.lower.resetTorques(true);
      }
    }
    for (const w of this.wheels) {
      // Suspension length from the wheel centre's position in the chassis frame.
      const s = (w.center ?? w.strut).translation();
      const local = rotate(qcInv, { x: s.x - pc.x, y: s.y - pc.y, z: s.z - pc.z });
      const length = w.mount.y - local.y;
      const speed = (length - w.suspensionLength) / dt;
      w.suspensionLength = length;
      w.travelSpeed = speed;
      if (w.ifs) this.applyCoilOver(w, dt, qc, pc);
      // Bump and rebound damping differ, so pick by direction of travel.
      const load = axleLoadFactor(w.front, car);
      const damping = (speed < 0 ? car.suspensionCompression : car.suspensionRelaxation) * car.mass * load;
      w.slider?.configureMotorPosition(car.suspensionRestLength, car.suspensionStiffness * car.mass * load, damping);

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
      // With GPU tyres the hub takes only its share of both (see spinShare).
      const radius = this.tire.outerRadius;
      const torque = -w.engineForce * radius;
      const share = this.spinShare(w);
      w.spinAxis = spinAxis;
      w.relSpin = spin;
      w.driveTorque = torque;
      w.brakeTorque = ((w.brakeImpulse ?? 0) / dt) * radius;
      w.axleJoint.setMotorMaxForce(w.brakeTorque * share);
      const t = { x: spinAxis.x * torque, y: spinAxis.y * torque, z: spinAxis.z * torque };
      w.hub.addTorque({ x: t.x * share, y: t.y * share, z: t.z * share }, true);
      // The drive's reaction goes where the differential is: the axle beam (solid) or, with
      // independent suspension, the chassis that carries the differential.
      (w.ifs ? this.body : w.knuckle).addTorque({ x: -t.x, y: -t.y, z: -t.z }, true);
    }
  }

  // Torques the suspension links and axles put into the chassis:
  // - anti-dive / anti-squat: link geometry takes part of the pitch from braking and acceleration;
  // - pinion reaction (solid axles): the propshaft's drive torque twists each axle one way and the
  //   chassis the other, so the body leans a little under power and one wheel unloads.
  applyLinkTorques(dt, qc) {
    const { car } = this;
    const fwd = rotate(qc, { x: 1, y: 0, z: 0 });
    const side = rotate(qc, { x: 0, y: 0, z: 1 });
    const v = this.body.linvel();
    const vf = v.x * fwd.x + v.y * fwd.y + v.z * fwd.z;
    const raw = (vf - (this.lastForward ?? vf)) / dt;
    this.lastForward = vf;
    this.accel = (this.accel ?? 0) + (raw - (this.accel ?? 0)) * Math.min(1, dt / 0.06);
    const add = (body, axis, torque) => body.addTorque({ x: axis.x * torque, y: axis.y * torque, z: axis.z * torque }, true);
    // Braking (accel < 0) dives the nose; the links push it back up (+z is nose-up).
    const pitch = -(car.antiDive ?? 0) * this.body.mass() * this.accel * 0.45;
    if (pitch) {
      add(this.body, side, pitch);
      for (const axle of this.axles) add(axle.beam, side, -pitch / this.axles.length);
    }
    if (this.solid && car.pinionReaction) {
      const radius = this.tire.outerRadius;
      this.axles.forEach((axle, a) => {
        const [i, j] = a === 0 ? [0, 1] : [2, 3];
        const input = ((this.wheels[i].engineForce + this.wheels[j].engineForce) * radius) / DRIVETRAIN.finalDrive;
        // Under power the chassis rolls to the right (+x torque), the axle the other way.
        const t = car.pinionReaction * input;
        add(this.body, fwd, t);
        add(axle.beam, fwd, -t);
      });
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

  // Hub states plus what the GPU needs to move each hub between the steps of one multi-step
  // dispatch: the spin axis and inertia, this step's drive torque and brake limit (held for the
  // batch), and the knuckle's spin rate (the brake stops the hub relative to it).
  hubBatchStates(dt) {
    const radius = this.tire.outerRadius;
    return this.hubStates().map((state, i) => {
      const w = this.wheels[i];
      const axis = rotate(w.knuckle.rotation(), AXLE);
      const wk = w.knuckle.angvel();
      return {
        ...state,
        spinAxis: axis,
        inertia: HUB_INERTIA_GPU.z + (w.driveInertia ?? 0),
        driveTorque: -(w.engineForce ?? 0) * radius,
        brakeTorque: ((w.brakeImpulse ?? 0) / dt) * radius,
        knuckleSpin: wk.x * axis.x + wk.y * axis.y + wk.z * axis.z,
      };
    });
  }

  // Runs `steps` GPU tyre steps in one round trip. Returns the force log; apply record j with
  // applyTyreForces(log, j) before Rapier's step j.
  stepTyresBatch(steps, dt, { readPositions = false } = {}) {
    return this.gpu.solver.step(this.hubBatchStates(dt), { readPositions, steps });
  }

  applyTyreForces(f, step = 0) {
    const o = step * MAX_TIRES * 8;
    this.wheels.forEach((w, t) => {
      const k = o + t * 8;
      this.applyHubTyre(w, f[k], f[k + 1], f[k + 2], f[k + 4], f[k + 5], f[k + 6]);
    });
  }

  // Runs the GPU tyres for one step and applies their forces to the hubs (added on top of the
  // drive and brake torques from updateVehicle).
  async stepTyres({ readPositions = false } = {}) {
    if (!this.gpu) return;
    let f;
    if (this.gpu.pipelined) {
      // Pipelined: use the forces from the step submitted last time (the GPU worked on them while
      // Rapier stepped and the frame ran), then queue this step. Costs one step of force latency
      // but the main thread no longer waits for the GPU on every step.
      const pending = this.pendingTyres;
      if (pending) f = await pending;
      // A rebuild can destroy the solver while a readback is still queued; ignore that failure.
      this.pendingTyres = this.gpu.solver.submit(this.hubStates(), { readPositions }).catch(() => null);
      if (!f) return;
    } else {
      f = await this.gpu.solver.step(this.hubStates(), { readPositions });
    }
    this.wheels.forEach((w, t) => {
      const k = t * 8;
      this.applyHubTyre(w, f[k], f[k + 1], f[k + 2], f[k + 4], f[k + 5], f[k + 6]);
    });
  }

  dispose() {
    this.gpu?.solver.destroy();
    for (const soft of this.softBodies) this.world.removeSoftBody(soft);
    for (const joint of this.joints) this.world.removeImpulseJoint(joint, false);
    for (const body of this.bodies) this.world.removeRigidBody(body);
  }
}

// The car is built already turned to `rotation` and moving with `linvel`/`angvel`: every link is
// placed from the chassis pose, so turning only the chassis afterwards would tear the joints apart.
export function createSoftCarBody(RAPIER, world, position, car = CAR, tire = TIRE, options = {}) {
  const { rotation = { x: 0, y: 0, z: 0, w: 1 }, linvel = { x: 0, y: 0, z: 0 }, angvel = { x: 0, y: 0, z: 0 } } = options;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setRotation(rotation).setCanSleep(false),
  );
  // The collision box grows with the frame when the wheelbase stretches it.
  const hx = car.halfExtents.x + frameStretch(car);
  const { y: hy, z: hz } = car.halfExtents;
  // The jointed car's axles, hubs, knuckles, and tyres add mass; the chassis gets the rest so the
  // whole car weighs car.mass.
  // Independent: per corner lower arm 8, upper 5, upright 10, tie rod 6, hub 22 kg, plus the 20 kg rack.
  const unsprung = car.solidAxles ? 292 : 224;
  const m = Math.max(600, car.mass - unsprung);
  const inertia = {
    x: (m / 12) * (4 * hy * hy + 4 * hz * hz) * 1.6,
    y: (m / 12) * (4 * hx * hx + 4 * hz * hz),
    z: (m / 12) * (4 * hx * hx + 4 * hy * hy),
  };
  const chassis = world.createCollider(
    RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setMassProperties(m, car.centerOfMass, inertia, { w: 1, x: 0, y: 0, z: 0 })
      .setFriction(0.5)
      .setRestitution(0.05)
      .setCollisionGroups(groups(GROUP.CHASSIS, GROUP.WORLD))
      // Its contact forces are reported for the sound (hits and scrapes; see systems/physics.js).
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(300),
    body,
  );
  const controller = new JointedVehicle(RAPIER, world, body, car, tire, options);
  controller.soundColliders.set(chassis.handle, 'chassis');
  // Every part moves with the chassis as one rigid body: v = v0 + ω × r.
  for (const part of [body, ...controller.bodies]) {
    const t = part.translation();
    const r = { x: t.x - position.x, y: t.y - position.y, z: t.z - position.z };
    part.setLinvel({ x: linvel.x + angvel.y * r.z - angvel.z * r.y, y: linvel.y + angvel.z * r.x - angvel.x * r.z, z: linvel.z + angvel.x * r.y - angvel.y * r.x }, true);
    part.setAngvel(angvel, true);
  }
  // Wheels already roll at the car's speed (forward rolling is a negative spin about the axle).
  const fwd = rotate(rotation, { x: 1, y: 0, z: 0 });
  const roll = -(linvel.x * fwd.x + linvel.y * fwd.y + linvel.z * fwd.z) / controller.rollingRadius();
  if (roll) {
    const axis = rotate(rotation, AXLE);
    for (const w of controller.wheels) w.hub.setAngvel({ x: angvel.x + axis.x * roll, y: angvel.y + axis.y * roll, z: angvel.z + axis.z * roll }, true);
  }
  controller.gpu?.solver.reset(controller.hubStates());
  return { body, controller };
}

// Height of the chassis origin above the ground for a car standing on soft tyres.
export function softCarRideHeight(car = CAR, tire = TIRE) {
  // Independent: the car is built with its wheels at the design point (see JointedVehicle).
  if (!car.solidAxles) return tire.outerRadius - ifsCorner(0, car).wheel.y + 0.05;
  return tire.outerRadius + car.suspensionRestLength - car.wheelMountY + 0.05;
}
