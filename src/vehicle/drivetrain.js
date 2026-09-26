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
  frictionTorque: 30, // N·m at rest; with the rpm term this is the engine braking
  frictionPerRpm: 0.024, // N·m per rpm
  exhaustBrake: 150, // extra N·m of engine braking off throttle (diesel exhaust brake)
  gears: [4.4, 2.6, 1.65, 1.18, 0.88],
  reverse: 4.0,
  finalDrive: 5.1,
  lowRange: 2.7,
  efficiency: 0.9,
  clutchTorque: 700, // N·m the clutch can carry fully engaged
  shiftTime: 0.35, // s with the clutch open during a shift
  upshiftRpm: 3500,
  downshiftRpm: 1500,
  coastDownshiftRpm: 2700, // off throttle the automatic holds lower gears for engine braking
  minShiftInterval: 0.9, // s
  launchRpm: 1600, // the automatic clutch is fully in by this engine speed when pulling away
  frontShare: 0.4, // centre differential torque split to the front axle
  centerLock: false,
  frontLock: false,
  rearLock: false,
  lockStiffness: 900, // N·m per rad/s of speed difference across a locked differential
  lockMaxTorque: 4000, // N·m a locked differential can move
  automatic: true,
  low: false,
});

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

export function frictionTorque(params, rpm) {
  return params.frictionTorque + params.frictionPerRpm * Math.max(0, rpm);
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

  shiftUp() {
    this.shiftTo(this.gear < 0 ? 0 : this.gear + 1);
  }

  shiftDown() {
    this.shiftTo(this.gear <= 0 ? -1 : this.gear - 1);
  }

  // One physics step.
  // input: { throttle 0..1, reverseRequest bool } — the vehicle decides when the driver wants reverse.
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
    // Driveshaft speed behind the centre differential (open diff: torque-weighted average).
    const shaftW = p.centerLock ? (front + rear) / 2 : front * p.frontShare + rear * (1 - p.frontShare);

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
        const revving = this.clutch > 0.95 && this.rpm > p.upshiftRpm + 300;
        if ((now > p.upshiftRpm || revving) && this.gear < p.gears.length && throttle > 0) this.shiftUp();
        else if (this.gear > 1 && now < (throttle > 0 ? p.downshiftRpm : p.coastDownshiftRpm)) {
          // Only if the lower gear would not over-rev.
          if (gearboxRpm(this.gear - 1) < Math.max(p.upshiftRpm, p.coastDownshiftRpm + 400)) this.shiftDown();
        }
      }
    }

    // Shift in progress: clutch open until the new gear is in.
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0 && this.pendingGear !== null) {
        this.gear = this.pendingGear;
        this.pendingGear = null;
      }
    }

    const ratio = this.ratio();
    const gearboxEngineW = shaftW * ratio; // engine speed the gears ask for

    // Automatic clutch: open while shifting or in neutral; when pulling away it engages with
    // engine speed; once the gearbox side is above idle it stays in.
    const idleW = rpmToRad(p.idleRpm);
    let target = 0;
    if (this.shiftTimer <= 0 && this.gear !== 0) {
      const gearboxRpm = radToRpm(Math.abs(gearboxEngineW));
      if (gearboxRpm >= p.idleRpm) target = 1;
      else if (throttle > 0) target = Math.min(1, Math.max(0, (this.rpm - p.idleRpm) / (p.launchRpm - p.idleRpm)));
      else target = 0; // rolling slowly off throttle: declutch rather than stall
    }
    this.clutch += Math.max(-dt / 0.12, Math.min(dt / 0.25, target - this.clutch));

    // Engine torque: throttle blends the full-load curve; above the limiter fuel is cut.
    const rpmNow = this.rpm;
    let drive = throttle * engineTorque(p, rpmNow);
    if (rpmNow > p.limiterRpm) drive = 0;
    // Idle governor keeps the engine running.
    if (rpmNow < p.idleRpm) drive = Math.max(drive, (p.idleRpm - rpmNow) * 0.8 + frictionTorque(p, rpmNow));
    // During a shift the engine is blipped (or held back) to the speed the new gear will need, so
    // the clutch engages without a jolt.
    let matching = false;
    if (this.shiftTimer > 0 && this.pendingGear) {
      const targetW = Math.min(rpmToRad(p.limiterRpm), Math.max(rpmToRad(p.idleRpm), Math.abs(shaftW * this.ratio(this.pendingGear))));
      const needed = ((targetW - this.engineW) * p.engineInertia) / Math.max(this.shiftTimer, dt) + frictionTorque(p, rpmNow);
      drive = Math.max(0, Math.min(engineTorque(p, rpmNow), needed));
      matching = true;
    }
    const brake = throttle > 0 || matching ? 0 : p.exhaustBrake * Math.min(1, Math.max(0, (rpmNow - p.idleRpm) / 600));
    const engineNet = drive - frictionTorque(p, rpmNow) - brake;

    // Clutch torque from engine to gearbox: stiff when the speeds match, capped by capacity.
    // In reverse the ratio is negative, so gearboxEngineW is positive when backing up.
    const slipW = this.engineW - gearboxEngineW;
    const capacity = p.clutchTorque * this.clutch;
    let clutchT = 0;
    // Locked: the clutch is fully in and the two sides turn together. The engine then simply
    // follows the gearbox and passes its net torque through. (Locking it with a stiff torque every
    // step made the light wheels and the heavy engine fight each other.)
    const locked = this.clutch > 0.98 && Math.abs(slipW) < rpmToRad(120) && ratio !== 0 && Math.abs(engineNet) <= capacity;
    if (locked) {
      clutchT = engineNet;
      this.engineW = Math.max(rpmToRad(200), gearboxEngineW);
    } else {
      if (ratio !== 0 && capacity > 0) {
        // Slipping: the clutch pulls the two speeds together with at most its capacity, and never
        // more than it takes to match them this step.
        const lockT = (slipW * p.engineInertia) / dt + engineNet;
        clutchT = Math.max(-capacity, Math.min(capacity, lockT));
      }
      this.engineW += ((engineNet - clutchT) / p.engineInertia) * dt;
      this.engineW = Math.max(rpmToRad(200), this.engineW);
    }

    // Torque into the gearbox output; reverse flips the sign via the ratio.
    const shaftT = clutchT * ratio * p.efficiency;
    const t = this.torques;
    t.fill(0);
    if (shaftT !== 0) {
      let frontT = shaftT * p.frontShare;
      let rearT = shaftT * (1 - p.frontShare);
      if (p.centerLock) {
        // Locked centre: push torque toward the slower axle.
        const lock = Math.max(-p.lockMaxTorque, Math.min(p.lockMaxTorque, p.lockStiffness * (rear - front)));
        frontT += lock / 2;
        rearT -= lock / 2;
      }
      splitAxle(t, 0, 1, frontT, sp, p.frontLock, p);
      splitAxle(t, 2, 3, rearT, sp, p.rearLock, p);
    }
    // A locked axle also resists speed differences with no engine torque.
    if (shaftT === 0) {
      if (p.frontLock) splitAxle(t, 0, 1, 0, sp, true, p);
      if (p.rearLock) splitAxle(t, 2, 3, 0, sp, true, p);
    }
    return t;
  }

  // Name for the HUD: R, N, 1..5, with L for low range.
  get label() {
    const g = this.pendingGear ?? this.gear;
    const name = g < 0 ? 'R' : g === 0 ? 'N' : String(g);
    return this.params.low ? `L${name}` : name;
  }
}

// Open differential: equal torque both sides. Locked: equal torque plus a correction toward the
// slower wheel.
function splitAxle(out, a, b, torque, spins, locked, p) {
  out[a] += torque / 2;
  out[b] += torque / 2;
  if (locked) {
    const lock = Math.max(-p.lockMaxTorque, Math.min(p.lockMaxTorque, p.lockStiffness * (spins[b] - spins[a])));
    out[a] += lock / 2;
    out[b] -= lock / 2;
  }
}
