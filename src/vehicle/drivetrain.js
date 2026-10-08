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
    // Driveshaft speed behind the centre differential (open diff: torque-weighted average).
    const shaftW = p.centerLock ? (front + rear) / 2 : front * p.frontShare + rear * (1 - p.frontShare);

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
        // With input.holdInSpin (snow) a gear is held while the wheels spin well past the road
        // speed, so a slide under power (a donut) keeps its torque instead of shifting it away.
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

    // Automatic clutch: open while shifting or in neutral; when pulling away it engages with
    // engine speed; once the gearbox side is above idle it stays in.
    const idleW = rpmToRad(p.idleRpm);
    let target = 0;
    if (this.shiftTimer <= 0 && this.gear !== 0) {
      const gearboxRpm = radToRpm(Math.abs(gearboxEngineW));
      if (gearboxRpm >= p.idleRpm) target = 1;
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
    if (this.shiftTimer > 0 && this.pendingGear) {
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
    const canLock = this.clutch > 0.98 && ratio !== 0 && Math.abs(engineNet) <= capacity;
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
      }
      this.engineW += ((engineNet - clutchT) / p.engineInertia) * dt;
      this.engineW = Math.max(rpmToRad(200), this.engineW);
    }

    // Locked, the engine's flywheel turns with the wheels: through the gears it weighs its inertia
    // times the ratio squared (about 570 kg·m² in low first), shared by the wheels. The vehicle
    // adds it to the wheel hubs, so a wheel that lifts off revs up and slows at the engine's pace
    // instead of flying up and back each step.
    this.coupledInertia = locked ? p.engineInertia * ratio * ratio : 0;

    // Torque into the gearbox output; reverse flips the sign via the ratio.
    const shaftT = clutchT * ratio * p.efficiency;
    this.shaftTorque = shaftT;
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
