// Engine, clutch, gearbox, and differentials for a 4x4. Pure maths: the vehicle feeds in driver
// input and wheel spin rates each physics step, and gets drive torques per wheel back.
//
// Wheel order matches the vehicle: 0 FL, 1 FR, 2 RL, 3 RR. Spin rates are positive forward (rad/s).

const TWO_PI_60 = (2 * Math.PI) / 60;
export const rpmToRad = (rpm) => rpm * TWO_PI_60;
export const radToRpm = (w) => w / TWO_PI_60;

export const DEFAULT_DRIVETRAIN = Object.freeze({
  // Torque curve at full throttle: [rpm, N·m] pairs, a turbo-diesel feel.
  torqueCurve: [
    [800, 205],
    [1200, 285],
    [1800, 360],
    [2600, 390],
    [3400, 375],
    [4200, 330],
    [5000, 275],
    [5600, 220],
  ],
  idleRpm: 850,
  limiterRpm: 5400,
  engineInertia: 0.28, // kg·m², flywheel and crank
  wheelInertia: 3.5, // kg·m² per wheel about its axle (the GPU tyres' hub carries the whole wheel)
  frictionTorque: 30, // N·m at rest; with the rpm term this is the engine braking
  frictionPerRpm: 0.014, // N·m per rpm (a real diesel's internal friction)
  // Off-throttle slowing, 0 = realistic engine braking (a long coast, about 0.06–0.1 g),
  // 1 = quick stop (a strong exhaust brake and low gears held, about 5 s from 50 km/h).
  coastStop: 1,
  gears: [4.4, 2.6, 1.65, 1.18, 0.88],
  reverse: 4.0,
  // Overall low 4th is about 12 (a Hilux is about 10): it climbs about 30° on torque, so the
  // steepest, rockiest ground wants low 2nd or 1st. Low 1st is about 45.
  finalDrive: 4.1,
  lowRange: 2.5,
  efficiency: 0.9,
  clutchTorque: 700, // N·m the clutch can carry fully engaged
  shiftTime: 0.35, // s with the clutch open during a shift
  upshiftRpm: 3500,
  downshiftRpm: 1500,
  minShiftInterval: 0.9, // s
  launchRpm: 2200, // the automatic clutch is fully in by this engine speed when pulling away
  frontShare: 0.4, // centre differential torque split to the front axle
  centerLock: false,
  frontLock: false,
  rearLock: false,
  // A locked differential drives the speed difference across it toward zero: lockGain of it per
  // step, from both sides' inertia (1 would close it in one step), plus a held torque that grows by
  // lockHold of it per step, so a steady pull (one wheel in the air) is carried with no speed
  // difference left, as a solid locker does. At most lockMaxTorque.
  lockGain: 0.6,
  lockHold: 0.2,
  // Most of the flywheel a wheel hub carries, kg·m² (see setDriveInertia in soft-vehicle.js). The
  // lockers work from the same inertia, so they do not overshoot.
  maxDriveInertia: 60,
  lockMaxTorque: 6000, // N·m a locked differential can move (about a half-shaft's limit)
  // A locker engages once the speeds across it are within lockEngageSpeed (rad/s) for lockEngageTime
  // (its dog teeth line up), so a wheel spinning hard has to slow before it locks. The axle lockers
  // drop out above axleLockMaxSpeed (m/s) and come back below it less 1.5 m/s.
  lockEngageSpeed: 2,
  lockEngageTime: 0.25,
  axleLockMaxSpeed: 8.3,
  automatic: true,
  low: false,
});

// Differential lock stages, stepped through like a real 4x4's switch: open, centre, centre and
// rear, then all three.
export const LOCK_STAGES = ['open', 'centre', 'rear', 'all'];

export function lockStage(params) {
  if (params.frontLock) return 3;
  if (params.rearLock) return 2;
  return params.centerLock ? 1 : 0;
}

export function setLockStage(params, stage) {
  const s = ((stage % LOCK_STAGES.length) + LOCK_STAGES.length) % LOCK_STAGES.length;
  params.centerLock = s >= 1;
  params.rearLock = s >= 2;
  params.frontLock = s >= 3;
}

export function engineTorque(params, rpm) {
  const curve = params.torqueCurve;
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (rpm <= curve[i][0]) {
      const [r0, t0] = curve[i - 1];
      const [r1, t1] = curve[i];
      return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return curve[curve.length - 1][1];
}

// The full-load curve's highest torque.
export function peakTorque(params) {
  return params.torqueCurve.reduce((m, [, t]) => Math.max(m, t), 0);
}

export function frictionTorque(params, rpm) {
  return params.frictionTorque + params.frictionPerRpm * Math.max(0, rpm);
}

// How the quick-stop setting shapes off-throttle behaviour.
export function coastSettings(params) {
  const q = Math.min(1, Math.max(0, params.coastStop ?? 1));
  return {
    exhaustBrake: 180 * q, // extra engine braking torque, N·m
    extraFriction: 0.01 * q, // N·m per rpm on top of the engine's own friction
    coastDownshiftRpm: 1300 + 1400 * q, // off throttle the automatic holds lower gears
    // Off throttle the torque converter's lock-up lets go, and the wheels drive the engine through
    // the fluid: torque = coupling × slip² (slip in rad/s at the engine). Soft, the revs sag toward
    // idle and the car rolls on; stiff, they stay close to road speed and carry the engine braking.
    coupling: 0.004 + 0.026 * q,
  };
}

export class Drivetrain {
  constructor(params = DEFAULT_DRIVETRAIN) {
    this.params = params;
    this.engineW = rpmToRad(params.idleRpm);
    this.gear = 0; // 0 = neutral, -1 = reverse, 1..n forward
    this.clutch = 0; // 0 open, 1 fully engaged
    this.shiftTimer = 0;
    this.sinceShift = 10;
    this.pendingGear = null;
    this.throttle = 0;
    this.torques = [0, 0, 0, 0];
    this.coupledInertia = 0; // kg·m² at the wheels, see update()
    // For the engine sound: fuel injected (drive torque over the curve's peak, 0..1, including the
    // idle governor and shift blips) and how hard the exhaust brake works (0..1).
    this.fuel = 0;
    this.exhaustBrake = 0;
    this.shaftTorque = 0; // N·m out of the gearbox (for the driveline's clunk and whine)
    this.fluidT = 0; // N·m the torque converter's fluid carries (see update())
    // Lockers as engaged (the driver asks through params.centerLock / frontLock / rearLock).
    this.engaged = { center: false, front: false, rear: false };
    this.engageTimers = { center: 0, front: 0, rear: 0 };
    this.lockHeld = { center: 0, front: 0, rear: 0 }; // N·m each locker carries steadily
    // Spin inertia per wheel, kg·m²: the wheel's own plus its share of the engine's flywheel.
    this.wheelInertia = [0, 0, 0, 0].map(() => params.wheelInertia ?? 3.5);
  }

  // Engages or releases the lockers toward what the driver asks for. spins: raw wheel spin rates.
  updateLocks(dt, spins, speed) {
    const p = this.params;
    const front = (spins[0] + spins[1]) / 2;
    const rear = (spins[2] + spins[3]) / 2;
    const fast = Math.abs(speed) > p.axleLockMaxSpeed;
    const slowEnough = Math.abs(speed) < p.axleLockMaxSpeed - 1.5;
    const step = (key, wanted, across, axle) => {
      if (!wanted || (axle && fast)) {
        this.engaged[key] = false;
        this.engageTimers[key] = 0;
        this.lockHeld[key] = 0;
        return;
      }
      if (this.engaged[key]) return;
      const aligned = Math.abs(across) < p.lockEngageSpeed && (!axle || slowEnough);
      this.engageTimers[key] = aligned ? this.engageTimers[key] + dt : 0;
      if (this.engageTimers[key] >= p.lockEngageTime) this.engaged[key] = true;
    };
    step('center', p.centerLock, front - rear, false);
    step('front', p.frontLock, spins[1] - spins[0], true);
    step('rear', p.rearLock, spins[3] - spins[2], true);
  }

  // Each wheel's share of the engine's flywheel while the clutch is locked (J, kg·m² at the
  // wheels). A wheel turns the driveshaft by c of its own speed (open centre: frontShare / 2 for a
  // front wheel, (1 - frontShare) / 2 for a rear one; locked centre: 1/4), so alone it feels J·c².
  // Locked to others, they turn the shaft with it: it feels J·c times the c of all of them (all
  // four locked together share J). Spreading J evenly, as before, made a wheel that broke loose on
  // its own spin up three to six times too slowly.
  driveInertiaShares(J) {
    const p = this.params;
    const e = this.engaged;
    const c = e.center ? [0.25, 0.25, 0.25, 0.25] : [p.frontShare / 2, p.frontShare / 2, (1 - p.frontShare) / 2, (1 - p.frontShare) / 2];
    const axle = (i) => (i < 2 ? e.front : e.rear);
    return c.map((ci, i) => {
      if (axle(i) && e.center && e.front && e.rear) return J * ci; // all four as one
      const group = axle(i) ? c[i] + c[i ^ 1] : ci;
      return J * ci * group;
    });
  }

  get rpm() {
    return radToRpm(this.engineW);
  }

  // Overall ratio from engine to wheels for a gear (0 for neutral).
  ratio(gear = this.gear) {
    const p = this.params;
    if (gear === 0) return 0;
    const box = gear < 0 ? -p.reverse : p.gears[gear - 1];
    return box * p.finalDrive * (p.low ? p.lowRange : 1);
  }

  shiftTo(gear) {
    const p = this.params;
    const target = Math.max(-1, Math.min(p.gears.length, gear));
    if (target === this.gear || this.shiftTimer > 0) return;
    // Straight from neutral or at a standstill there is nothing to wait for.
    this.pendingGear = target;
    this.shiftTimer = this.gear === 0 ? 0.05 : p.shiftTime;
    this.sinceShift = 0;
  }

  // A gear that would drive against the direction of motion, or over-rev the engine at the current
  // road speed, is not engaged: the box stays in neutral, or takes the lowest gear that fits.
  allowedGear(gear) {
    const p = this.params;
    const v = this.lastSpeed ?? 0;
    if (gear < 0 && v > 1) return 0;
    if (gear > 0 && v < -1) return 0;
    let g = gear;
    while (g > 0 && g < p.gears.length && radToRpm(Math.abs((this.lastRoadW ?? 0) * this.ratio(g))) > p.limiterRpm) g++;
    if (g < 0 && radToRpm(Math.abs((this.lastRoadW ?? 0) * this.ratio(g))) > p.limiterRpm) return 0;
    return g;
  }

  // Acceleration (m/s²) full throttle would give in a gear at a road speed, against the slope's
  // pull (input.climb, m/s²) and some rolling loss, for a vehicle of input.mass kg.
  pull(gear, speed, radius, input) {
    const p = this.params;
    const ratio = Math.abs(this.ratio(gear));
    const rpm = Math.max(p.idleRpm, radToRpm(Math.abs(speed / radius) * ratio));
    if (rpm > p.limiterRpm) return -Infinity;
    const wheelForce = (Math.min(engineTorque(p, rpm), p.clutchTorque) * ratio * p.efficiency) / radius;
    return wheelForce / input.mass - input.climb - 0.3;
  }

  shiftUp() {
    this.shiftTo(this.gear < 0 ? 0 : this.gear + 1);
  }

  shiftDown() {
    this.shiftTo(this.gear <= 0 ? -1 : this.gear - 1);
  }

  // One physics step.
  // input: { throttle 0..1, reverseRequest bool, climb, mass, holdInSpin } — the vehicle decides when the driver
  // wants reverse; climb is the slope's pull against the direction of travel (m/s², optional) and
  // mass the vehicle's, so the automatic holds a gear that can pull up a hill.
  // spins: wheel spin rates (rad/s, forward positive). speed: forward vehicle speed (m/s).
  update(dt, input, spins, speed, radius = 0.46) {
    const p = this.params;
    this.sinceShift += dt;
    const throttle = input.throttle;
    this.throttle = throttle;

    // Wheel spin rates from soft tyres ring a little, so the drivetrain sees them smoothed.
    this.smoothSpins ??= [...spins];
    const k = Math.min(1, dt / 0.04);
    for (let i = 0; i < 4; i++) this.smoothSpins[i] += (spins[i] - this.smoothSpins[i]) * k;
    const sp = this.smoothSpins;
    const front = (sp[0] + sp[1]) / 2;
    const rear = (sp[2] + sp[3]) / 2;
    this.updateLocks(dt, spins, speed);
    const locks = this.engaged;
    // Driveshaft speed behind the centre differential (open diff: torque-weighted average).
    const shaftW = locks.center ? (front + rear) / 2 : front * p.frontShare + rear * (1 - p.frontShare);

    const coast = coastSettings(p);
    this.lastSpeed = speed;
    this.lastRoadW = speed / radius;

    // Automatic gear choice from road speed, like a gearbox reading its output shaft; it does not
    // react to momentary wheelspin.
    if (p.automatic && this.shiftTimer <= 0) {
      const roadW = speed / radius;
      const gearboxRpm = (gear) => radToRpm(Math.abs(roadW * this.ratio(gear)));
      if (input.reverseRequest) {
        if (this.gear !== -1 && Math.abs(speed) < 0.8) this.shiftTo(-1);
      } else if (throttle > 0 && this.gear <= 0 && speed > -0.8) {
        this.shiftTo(1);
      } else if (this.gear > 0 && this.sinceShift > p.minShiftInterval) {
        const now = gearboxRpm(this.gear);
        // Upshift on road speed, or on engine speed when the wheels are spinning up with the clutch in.
        // With input.holdInSpin a gear is held while the wheels spin well past the road speed, so
        // wheelspin and a slide under power (a donut) keep their torque instead of an upshift
        // quietly taking it away (traction control by accident).
        const spinning = input.holdInSpin && Math.abs(shaftW * radius) > Math.abs(speed) + 2;
        const revving = this.clutch > 0.95 && this.rpm > p.upshiftRpm + 300 && !spinning;
        const atLimiter = now > p.limiterRpm - 150;
        const climbing = throttle > 0 && input.climb > 0.4 && input.mass > 0; // from about 2.3°
        if ((now > p.upshiftRpm || revving) && this.gear < p.gears.length && throttle > 0 && (atLimiter || !climbing || this.pull(this.gear + 1, speed - Math.sign(speed) * input.climb * p.shiftTime, radius, input) > 0.3)) this.shiftUp();
        // Climbing and slowing in this gear: take the lower one if it does not over-rev.
        else if (climbing && this.gear > 1 && this.pull(this.gear, speed, radius, input) < -0.2 && gearboxRpm(this.gear - 1) < p.upshiftRpm) this.shiftDown();
        else if (this.gear > 1 && now < (throttle > 0 ? p.downshiftRpm : coast.coastDownshiftRpm)) {
          // Only if the lower gear would not over-rev.
          if (gearboxRpm(this.gear - 1) < Math.max(p.upshiftRpm, coast.coastDownshiftRpm + 400)) this.shiftDown();
        }
      }
    }

    // Shift in progress: clutch open until the new gear is in.
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0 && this.pendingGear !== null) {
        this.gear = this.allowedGear(this.pendingGear);
        this.pendingGear = null;
      }
    }

    const ratio = this.ratio();
    const gearboxEngineW = shaftW * ratio; // engine speed the gears ask for
    const aboveIdle = radToRpm(Math.abs(gearboxEngineW)) >= p.idleRpm;
    // The automatic works as a torque converter once rolling in gear. On throttle its lock-up clutch
    // holds engine and gearbox together. Off throttle the lock-up lets go and the wheels drive the
    // engine through the fluid, so its revs sag below road speed; coasting it also changes gear
    // through the fluid, with no declutching or rev-matching blip.
    const coasting = p.automatic && throttle === 0 && this.gear !== 0 && aboveIdle;

    // Automatic clutch: open while shifting on throttle or in neutral; when pulling away it engages
    // with engine speed; once the gearbox side is above idle it stays in.
    const idleW = rpmToRad(p.idleRpm);
    let target = 0;
    if (coasting) target = 1;
    else if (this.shiftTimer <= 0 && this.gear !== 0) {
      if (aboveIdle) target = 1;
      else if (throttle > 0) {
        // Bite progressively (squared), so the engine can rev into its torque before it is loaded.
        const x = Math.min(1, Math.max(0, (this.rpm - p.idleRpm) / (p.launchRpm - p.idleRpm)));
        target = x * x;
      }
      else target = 0; // rolling slowly off throttle: declutch rather than stall
    }
    this.clutch += Math.max(-dt / 0.12, Math.min(dt / 0.25, target - this.clutch));

    // Engine torque: throttle blends the full-load curve; above the limiter fuel is cut.
    const rpmNow = this.rpm;
    let drive = throttle * engineTorque(p, rpmNow);
    // Fuel is cut over the last 100 rpm to the limiter and 100 past it (a hard cut made the drive
    // torque switch on and off every step at the limiter).
    drive *= Math.min(1, Math.max(0, (p.limiterRpm + 100 - rpmNow) / 200));
    // Idle governor keeps the engine running, with no more than the full-load curve (uncapped it
    // gave up to about 550 N·m when the engine was lugged below idle, far past the curve's peak).
    if (rpmNow < p.idleRpm) drive = Math.max(drive, Math.min(engineTorque(p, rpmNow), (p.idleRpm - rpmNow) * 0.8 + frictionTorque(p, rpmNow)));
    // During a shift the engine is blipped (or held back) to the speed the new gear will need, so
    // the clutch engages without a jolt.
    let matching = false;
    if (this.shiftTimer > 0 && this.pendingGear && !coasting) {
      const targetW = Math.min(rpmToRad(p.limiterRpm), Math.max(rpmToRad(p.idleRpm), Math.abs(shaftW * this.ratio(this.pendingGear))));
      const needed = ((targetW - this.engineW) * p.engineInertia) / Math.max(this.shiftTimer, dt) + frictionTorque(p, rpmNow);
      drive = Math.max(0, Math.min(engineTorque(p, rpmNow), needed));
      matching = true;
    }
    const offThrottle = throttle === 0 && !matching;
    // The quick-stop brake is tuned for high range; low range multiplies it at the wheels by the
    // range ratio, past what the tyres can hold (they locked and let go every few steps), so it is
    // divided back out.
    const brake = offThrottle
      ? (coast.exhaustBrake * Math.min(1, Math.max(0, (rpmNow - p.idleRpm) / 600)) + coast.extraFriction * rpmNow) / (p.low ? p.lowRange : 1)
      : 0;
    const engineNet = drive - frictionTorque(p, rpmNow) - brake;
    this.fuel = Math.min(1, Math.max(0, drive) / peakTorque(p));
    this.exhaustBrake = coast.exhaustBrake > 0 && offThrottle ? Math.min(1, Math.max(0, (rpmNow - p.idleRpm) / 600)) * Math.min(1, coast.exhaustBrake / 180) : 0;

    // Clutch torque from engine to gearbox: stiff when the speeds match, capped by capacity.
    // In reverse the ratio is negative, so gearboxEngineW is positive when backing up.
    const slipW = this.engineW - gearboxEngineW;
    const capacity = p.clutchTorque * this.clutch;
    let clutchT = 0;
    // Locked: the clutch is fully in and the two sides turn together. The engine then simply
    // follows the gearbox and passes its net torque through. (Locking it with a stiff torque every
    // step made the light wheels and the heavy engine fight each other.)
    // It locks when the speeds come close (within 120 rpm, or 1.5 rad/s at the wheels in a low gear,
    // where wheel speed ripple on rough ground is multiplied by the ratio), or cross, and then stays
    // locked however fast the wheels change speed (free-spinning wheels change the gearbox speed by
    // more than that in one step, which unlocked it, and the slipping clutch then yanked them
    // back: a chatter every few steps).
    // Back on throttle after a coast, the fluid carries the engine while it flares up to the
    // gearbox's speed, and the lock-up clutch takes over from there.
    const flaring = p.automatic && this.clutch > 0.98 && this.shiftTimer <= 0 && aboveIdle && !this.locked && slipW < 0;
    const fluid = coasting || flaring;
    const canLock = this.clutch > 0.98 && ratio !== 0 && Math.abs(engineNet) <= capacity && !coasting;
    const close = Math.abs(slipW) < Math.max(rpmToRad(120), 1.5 * Math.abs(ratio));
    const crossed = this.lastSlipW !== undefined && Math.sign(slipW) !== Math.sign(this.lastSlipW);
    const locked = canLock && (this.locked || close || crossed);
    this.locked = locked;
    this.lastSlipW = slipW;
    const wheelsI = ratio !== 0 ? (4 * (p.wheelInertia ?? 3.5)) / (ratio * ratio) : 0;
    if (locked) {
      clutchT = engineNet;
      this.engineW = Math.max(rpmToRad(200), gearboxEngineW);
    } else {
      if (ratio !== 0 && capacity > 0) {
        // Slipping: the clutch pulls the two speeds together with at most its capacity, and never
        // more than it takes to match them this step. Both sides move: the engine, and the four
        // wheels as the engine sees them through the gears (their inertia over the ratio squared,
        // far lighter than the engine in a low gear). Matching with the engine's inertia alone
        // overshot the light wheel side, so wheels and clutch chattered back and forth every step,
        // and worse in low range.
        const pairI = (p.engineInertia * wheelsI) / (p.engineInertia + wheelsI);
        const lockT = (slipW * pairI) / dt + (engineNet * pairI) / p.engineInertia;
        clutchT = Math.max(-capacity, Math.min(capacity, lockT));
        // The fluid carries less than the clutch could, and no more than brings the speeds together
        // this step (the same overshoot as above, against light wheels in a low gear).
        // The fluid's torque builds over a moment (0.25 s), and it never holds the car back harder
        // than the engine would braking at the gearbox's speed, so a coast downshift, which doubles
        // the slip at once and has to spin the engine up, eases into the lower gear.
        if (fluid) {
          const gearboxRpm = radToRpm(Math.abs(gearboxEngineW));
          const overrun = frictionTorque(p, gearboxRpm) + coast.exhaustBrake + coast.extraFriction * gearboxRpm;
          const fluidT = Math.max(-overrun, coast.coupling * slipW * Math.abs(slipW));
          this.fluidT += (fluidT - this.fluidT) * Math.min(1, dt / 0.25);
          clutchT = Math.max(Math.min(0, clutchT), Math.min(Math.max(0, clutchT), this.fluidT));
        }
      }
      this.engineW += ((engineNet - clutchT) / p.engineInertia) * dt;
      this.engineW = Math.max(rpmToRad(200), this.engineW);
    }

    // Locked, the engine's flywheel turns with the wheels: through the gears it weighs its inertia
    // times the ratio squared (about 570 kg·m² in low first), shared by the wheels. The vehicle
    // adds it to the wheel hubs, so a wheel that lifts off revs up and slows at the engine's pace
    // instead of flying up and back each step.
    if (!fluid) this.fluidT = clutchT; // the fluid takes over from what the clutch carried
    this.coupledInertia = locked ? p.engineInertia * ratio * ratio : 0;
    const shares = this.driveInertiaShares(this.coupledInertia);
    const I = this.wheelInertia;
    for (let i = 0; i < 4; i++) I[i] = (p.wheelInertia ?? 3.5) + Math.min(p.maxDriveInertia ?? Infinity, shares[i]);

    // Torque into the gearbox output; reverse flips the sign via the ratio. The open differentials
    // split it (centre by frontShare, each axle equally); a locked one adds a torque that closes
    // the speed difference across it. Lockers read the raw wheel speeds: smoothed, they lagged and
    // let a wheel run away before they caught it.
    const shaftT = clutchT * ratio * p.efficiency;
    this.shaftTorque = shaftT;
    const t = this.torques;
    t.fill(0);
    let frontT = shaftT * p.frontShare;
    let rearT = shaftT * (1 - p.frontShare);
    if (locks.center) {
      const lock = this.lockTorque('center', dt, (spins[0] + spins[1]) / 2 - (spins[2] + spins[3]) / 2, I[0] + I[1], I[2] + I[3]);
      frontT += lock;
      rearT -= lock;
    }
    this.splitAxle(t, 0, 1, frontT, spins, locks.front && 'front', dt);
    this.splitAxle(t, 2, 3, rearT, spins, locks.rear && 'rear', dt);
    return t;
  }

  // Torque a locked differential moves from the faster side (speed difference `diff`, rad/s, side
  // A minus side B) to the slower one, given the inertia each side has about the differential
  // (iA, iB, kg·m²). Positive speeds up side A.
  lockTorque(key, dt, diff, iA, iB) {
    const p = this.params;
    const pair = (iA * iB) / (iA + iB);
    const max = p.lockMaxTorque;
    const held = Math.max(-max, Math.min(max, this.lockHeld[key] - (p.lockHold * pair * diff) / dt));
    this.lockHeld[key] = held;
    return Math.max(-max, Math.min(max, held - (p.lockGain * pair * diff) / dt));
  }

  // Open differential: equal torque both sides. Locked (`lock` names the locker): equal torque
  // plus a lock torque toward the slower wheel.
  splitAxle(out, a, b, torque, spins, lock, dt) {
    out[a] += torque / 2;
    out[b] += torque / 2;
    if (lock) {
      const t = this.lockTorque(lock, dt, spins[a] - spins[b], this.wheelInertia[a], this.wheelInertia[b]);
      out[a] += t;
      out[b] -= t;
    }
  }

  // Name for the HUD: R, N, 1..5, with L for low range.
  get label() {
    const g = this.pendingGear ?? this.gear;
    const name = g < 0 ? 'R' : g === 0 ? 'N' : String(g);
    return this.params.low ? `L${name}` : name;
  }
}
