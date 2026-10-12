import { describe, expect, it } from 'vitest';
import { DEFAULT_DRIVETRAIN, Drivetrain, engineTorque, rpmToRad } from '../src/vehicle/drivetrain.js';

const R = 0.46;
const MASS = 1800;
const DT = 1 / 120;

// A car rolling without slip: all wheels spin at v / R, so drive torque becomes force / R.
function simulate(seconds, inputFn, { dt: drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN }), v0 = 0, drag = 0.75 } = {}) {
  let v = v0;
  const log = [];
  for (let t = 0; t < seconds; t += DT) {
    const spins = [v / R, v / R, v / R, v / R];
    const input = inputFn(t, v);
    const torques = drive.update(DT, input, spins, v, R);
    const force = torques.reduce((a, b) => a + b, 0) / R - (input.climb ?? 0) * MASS - drag * v * Math.abs(v) - Math.sign(v) * 0.018 * MASS * 9.81 * (Math.abs(v) > 0.05 ? 1 : 0);
    // The engine's reflected inertia is felt through the clutch torque already; wheels add a little.
    v += (force / (MASS + (4 * 3.5) / (R * R))) * DT;
    log.push({ t, v, rpm: drive.rpm, gear: drive.gear });
  }
  return { v, log, drive };
}

describe('drivetrain', () => {
  it('interpolates the torque curve', () => {
    expect(engineTorque(DEFAULT_DRIVETRAIN, 2600)).toBe(390);
    expect(engineTorque(DEFAULT_DRIVETRAIN, 2200)).toBeCloseTo((360 + 390) / 2, 5);
    expect(engineTorque(DEFAULT_DRIVETRAIN, 100)).toBe(205);
  });

  it('idles with the clutch open at a standstill', () => {
    const { drive, v } = simulate(2, () => ({ throttle: 0, reverseRequest: false }));
    expect(Math.abs(v)).toBeLessThan(0.01);
    expect(drive.rpm).toBeGreaterThan(700);
    expect(drive.rpm).toBeLessThan(1000);
  });

  it('pulls away, shifts up through the gears, and stays under the limiter', () => {
    const { log } = simulate(25, () => ({ throttle: 1, reverseRequest: false }));
    const t100 = log.find((s) => s.v >= 27.78)?.t;
    const maxGear = Math.max(...log.map((s) => s.gear));
    const maxRpm = Math.max(...log.map((s) => s.rpm));
    console.log('0-100 km/h', t100?.toFixed(1), 's; top gear', maxGear, '; max rpm', maxRpm.toFixed(0), '; speed at 25 s', (log.at(-1).v * 3.6).toFixed(0), 'km/h');
    expect(t100).toBeGreaterThan(7);
    expect(t100).toBeLessThan(16);
    expect(maxGear).toBeGreaterThanOrEqual(4);
    expect(maxRpm).toBeLessThan(DEFAULT_DRIVETRAIN.limiterRpm + 300);
  });

  it('holds a gear that can pull up a steep hill instead of hunting', () => {
    // 30°: the slope pulls back at 4.9 m/s², more than 2nd gear can overcome.
    const climb = 9.81 * Math.sin((30 * Math.PI) / 180);
    const { log } = simulate(15, () => ({ throttle: 1, reverseRequest: false, climb, mass: MASS }));
    let shifts = 0;
    for (let i = 1; i < log.length; i++) if (log[i].gear !== log[i - 1].gear) shifts++;
    console.log('30° climb: speed at 15 s', (log.at(-1).v * 3.6).toFixed(0), 'km/h, gear', log.at(-1).gear, ',', shifts, 'gear changes');
    expect(log.at(-1).v).toBeGreaterThan(5);
    expect(shifts).toBeLessThanOrEqual(2);
  });

  it('brakes with the engine when lifting off in gear, and downshifts', () => {
    const drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN });
    simulate(12, () => ({ throttle: 1, reverseRequest: false }), { dt: drive });
    const before = drive.gear;
    const { log } = simulate(6, () => ({ throttle: 0, reverseRequest: false }), { dt: drive, v0: 25 });
    const decel = (25 - log.at(-1).v) / 6;
    console.log('coast from 90 km/h: decel', (decel / 9.81).toFixed(2), 'g; gear', before, '->', log.at(-1).gear, '; speed after 6 s', (log.at(-1).v * 3.6).toFixed(0), 'km/h');
    expect(decel / 9.81).toBeGreaterThan(0.12); // clearly more than drag and rolling alone
    expect(log.at(-1).gear).toBeLessThan(before);
  });

  it('selects reverse at a standstill and backs up', () => {
    const { v, drive } = simulate(4, () => ({ throttle: 1, reverseRequest: true }));
    expect(drive.gear).toBe(-1);
    expect(v).toBeLessThan(-1);
  });

  it('low range multiplies the ratio', () => {
    const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN, low: true });
    d.gear = 1;
    expect(d.ratio()).toBeCloseTo(DEFAULT_DRIVETRAIN.gears[0] * DEFAULT_DRIVETRAIN.finalDrive * DEFAULT_DRIVETRAIN.lowRange, 5);
  });

  it('the idle governor gives no more than the full-load curve when lugged', () => {
    const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN });
    d.gear = 1;
    d.clutch = 1;
    d.engineW = rpmToRad(300);
    d.update(DT, { throttle: 1, reverseRequest: false }, [0, 0, 0, 0], 0, R);
    // (The automatic's torque converter multiplies what the engine gives on top.)
    expect(Math.abs(d.shaftTorque)).toBeLessThanOrEqual(engineTorque(DEFAULT_DRIVETRAIN, 300) * d.converterMultiply * d.ratio(1) * DEFAULT_DRIVETRAIN.efficiency + 1e-6);
  });

  it('held at a standstill at full throttle, the automatic stalls its converter near peak torque and doubles it', () => {
    const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN });
    d.shiftTo(1);
    // The wheels are held (a car stuck in its ruts): they do not turn.
    for (let t = 0; t < 3; t += DT) d.update(DT, { throttle: 1, reverseRequest: false }, [0, 0, 0, 0], 0, R);
    expect(d.rpm).toBeGreaterThan(2150);
    expect(d.rpm).toBeLessThan(2450);
    expect(d.converterMultiply).toBeCloseTo(2, 5);
    // About twice the engine's full-load torque reaches the gearbox output.
    const engine = engineTorque(DEFAULT_DRIVETRAIN, d.rpm);
    expect(d.shaftTorque).toBeGreaterThan(1.5 * engine * d.ratio(1) * DEFAULT_DRIVETRAIN.efficiency);
  });

  it('a manual gearbox pulls away on its clutch, with no torque multiplication', () => {
    const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN, automatic: false });
    d.shiftTo(1);
    for (let t = 0; t < 3; t += DT) d.update(DT, { throttle: 1, reverseRequest: false }, [0, 0, 0, 0], 0, R);
    expect(d.converterMultiply).toBe(1);
    expect(d.shaftTorque).toBeLessThanOrEqual(engineTorque(DEFAULT_DRIVETRAIN, d.rpm) * d.ratio(1) * DEFAULT_DRIVETRAIN.efficiency + 1e-6);
  });

  it('low 4th stalls on a 35° hill that low 2nd climbs', () => {
    const climb = 9.81 * Math.sin((35 * Math.PI) / 180);
    const run = (gear) => {
      const drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN, automatic: false, low: true });
      drive.shiftTo(gear);
      return simulate(10, () => ({ throttle: 1, reverseRequest: false, climb, mass: MASS }), { dt: drive }).v;
    };
    expect(run(4)).toBeLessThan(0);
    expect(run(2)).toBeGreaterThan(1);
  });

  it('open axle splits torque equally; a locked axle feeds the slower wheel', () => {
    const run = (locked) => {
      const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN, rearLock: locked });
      d.engaged.rear = locked; // already engaged (engaging waits for the speeds to line up)
      d.gear = 1;
      d.clutch = 1;
      d.engineW = rpmToRad(2000);
      // Rear-left wheel spinning freely in the air.
      const spins = [5, 5, 25, 5];
      d.smoothSpins = [...spins];
      return d.update(DT, { throttle: 1, reverseRequest: false }, spins, 2.3);
    };
    const open = run(false);
    const locked = run(true);
    expect(open[2]).toBeCloseTo(open[3], 5);
    expect(locked[3]).toBeGreaterThan(locked[2]);
  });

  it('coasts realistically with the quick stop off', () => {
    const drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN, coastStop: 0 });
    simulate(12, () => ({ throttle: 1, reverseRequest: false }), { dt: drive });
    const { log } = simulate(6, () => ({ throttle: 0, reverseRequest: false }), { dt: drive, v0: 25 });
    const decel = (25 - log.at(-1).v) / 6 / 9.81;
    console.log('realistic coast from 90 km/h:', decel.toFixed(3), 'g');
    expect(decel).toBeGreaterThan(0.03);
    expect(decel).toBeLessThan(0.12);
  });

  // The automatic's torque converter: lifting off at speed lets the lock-up go, so the revs sag
  // below road speed (more with the quick stop off), and back on throttle they meet it and lock.
  it('coasts through the torque converter: revs sag off throttle, and lock up again on throttle', () => {
    for (const coastStop of [0, 1]) {
      const drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN, coastStop });
      simulate(8, () => ({ throttle: 1, reverseRequest: false }), { dt: drive });
      const v0 = 20;
      const { log, v } = simulate(2, () => ({ throttle: 0, reverseRequest: false }), { dt: drive, v0 });
      const road = (v / R) * drive.ratio() * (60 / (2 * Math.PI));
      const sag = road - drive.rpm;
      console.log(`coast, quick stop ${coastStop}: ${road.toFixed(0)} rpm at the gearbox, engine ${drive.rpm.toFixed(0)}`);
      expect(drive.locked).toBe(false);
      expect(sag).toBeGreaterThan(coastStop ? 300 : 800);
      expect(drive.rpm).toBeGreaterThan(DEFAULT_DRIVETRAIN.idleRpm - 50);
      // No jolt anywhere along the coast: speed falls smoothly.
      for (let i = 1; i < log.length; i++) expect(log[i - 1].v - log[i].v).toBeLessThan((0.45 * 9.81) / 120);
      const back = simulate(1, () => ({ throttle: 1, reverseRequest: false }), { dt: drive, v0: v });
      expect(drive.locked).toBe(true);
      expect(back.v).toBeGreaterThan(v);
    }
  });

  it('never engages reverse while rolling forward, or a gear that would over-rev', () => {
    const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN, automatic: false });
    // Rolling forward at 13 m/s in 3rd.
    d.gear = 3;
    d.update(DT, { throttle: 0, reverseRequest: false }, [28, 28, 28, 28], 13, R);
    d.shiftTo(-1);
    for (let i = 0; i < 120; i++) d.update(DT, { throttle: 0, reverseRequest: false }, [28, 28, 28, 28], 13, R);
    expect(d.gear).toBe(0);
    // Asking for 1st at 25 m/s would pass 5400 rpm: it takes a higher gear.
    d.shiftTo(1);
    for (let i = 0; i < 120; i++) d.update(DT, { throttle: 0, reverseRequest: false }, [54, 54, 54, 54], 25, R);
    expect(d.gear).toBeGreaterThan(1);
  });

  // Wheels spinning free (in the air, or on no grip): the clutch must bring engine and wheels
  // together without overshooting the light wheel side, and once locked the wheels carry the
  // engine's flywheel (they chattered back and forth every step, worst in low range).
  it('clutch does not chatter against light wheels, in high or low range', () => {
    for (const low of [false, true]) {
      const drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN, low });
      const w = [0, 0, 0, 0];
      // Chatter: the drive torque changing sign on consecutive steps (back, forth, back).
      let chatter = 0;
      const sums = [];
      for (let step = 0; step < 240; step++) {
        const t = drive.update(DT, { throttle: step < 120 ? 1 : 0 }, w, 0, R);
        // The vehicle adds the engine's flywheel to the hubs while the clutch is locked.
        for (let i = 0; i < 4; i++) w[i] += (t[i] / drive.wheelInertia[i]) * DT - w[i] * 0.02 * DT; // a little bearing drag
        sums.push(t.reduce((a, b) => a + b, 0));
        const [a, b, c] = sums.slice(-3);
        if (sums.length >= 3 && Math.min(Math.abs(a), Math.abs(b), Math.abs(c)) > 50 && Math.sign(a) !== Math.sign(b) && Math.sign(b) !== Math.sign(c)) chatter++;
        for (const x of w) expect(Number.isFinite(x)).toBe(true);
      }
      expect(chatter).toBeLessThanOrEqual(2); // was every step (it diverged in low range)
    }
  });

  it('a locker engages only once the speeds across it line up, and the axle lockers drop out at speed', () => {
    const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN, rearLock: true, centerLock: true });
    // Rear-right spinning 10 rad/s faster: the rear locker waits; the centre (axles level) engages.
    for (let i = 0; i < 60; i++) d.updateLocks(DT, [10, 10, 5, 15], 4);
    expect(d.engaged).toEqual({ center: true, front: false, rear: false });
    for (let i = 0; i < 60; i++) d.updateLocks(DT, [10, 10, 9.5, 10.5], 4);
    expect(d.engaged.rear).toBe(true);
    // Above 30 km/h the rear locker lets go; the centre stays.
    d.updateLocks(DT, [25, 25, 25, 25], 10);
    expect(d.engaged).toEqual({ center: true, front: false, rear: false });
    // Switched off: released at once.
    d.params.centerLock = false;
    d.updateLocks(DT, [10, 10, 10, 10], 4);
    expect(d.engaged.center).toBe(false);
  });

  it('a wheel alone feels its own share of the flywheel; locked wheels share it', () => {
    const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN });
    const J = 100;
    const open = d.driveInertiaShares(J);
    // Open centre (40 / 60) and axles: a front wheel turns the shaft by 0.2 of its speed, a rear by 0.3.
    expect(open[0]).toBeCloseTo(J * 0.04);
    expect(open[2]).toBeCloseTo(J * 0.09);
    d.engaged.rear = true;
    expect(d.driveInertiaShares(J)[2]).toBeCloseTo(J * 0.3 * 0.6);
    Object.assign(d.engaged, { center: true, front: true, rear: true });
    const all = d.driveInertiaShares(J);
    expect(all.reduce((a, b) => a + b, 0)).toBeCloseTo(J);
  });

  it('a locked axle carries a wheel in the air with its partner, with no gap left', () => {
    const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN, rearLock: true });
    d.engaged.rear = true;
    d.gear = 1;
    d.clutch = 1;
    d.engineW = rpmToRad(1200);
    // Rear-right in the air (no tyre torque); the others on the ground (a stiff tyre about 2 rad/s).
    const w = [2, 2, 2, 2];
    const gaps = [];
    for (let step = 0; step < 240; step++) {
      const t = d.update(DT, { throttle: 1, reverseRequest: false }, w, 0.86, R);
      for (let i = 0; i < 4; i++) w[i] += ((t[i] + (i === 3 ? 0 : -300 * (w[i] - 2))) / d.wheelInertia[i]) * DT;
      gaps.push(w[3] - w[2]);
    }
    // The clutch slams in at the start; within 0.1 s the locker has the wheels together.
    expect(Math.max(...gaps.slice(12).map(Math.abs))).toBeLessThan(0.6);
    expect(Math.abs(gaps.at(-1))).toBeLessThan(0.01); // held, not lagging behind
    // Open, the free wheel runs away.
    const open = new Drivetrain({ ...DEFAULT_DRIVETRAIN });
    Object.assign(open, { gear: 1, clutch: 1, engineW: rpmToRad(1200) });
    const v = [2, 2, 2, 2];
    for (let step = 0; step < 240; step++) {
      const t = open.update(DT, { throttle: 1, reverseRequest: false }, v, 0.86, R);
      for (let i = 0; i < 4; i++) v[i] += ((t[i] + (i === 3 ? 0 : -300 * (v[i] - 2))) / open.wheelInertia[i]) * DT;
    }
    expect(v[3] - v[2]).toBeGreaterThan(10);
  });

  // GPU tyres hold a round trip's drive torques (from its first step) for all of its steps.
  it('a locked axle holds its wheels together when the torques are held for several steps', () => {
    const run = (torqueSteps) => {
      const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN, rearLock: true });
      Object.assign(d, { gear: 1, clutch: 1, engineW: rpmToRad(1200), torqueSteps });
      d.engaged.rear = true;
      const w = [2, 2, 2, 2];
      const gaps = [];
      let t = [0, 0, 0, 0];
      for (let step = 0; step < 240; step++) {
        const fresh = d.update(DT, { throttle: 1, reverseRequest: false }, w, 0.86, R);
        if (step % 4 === 0) t = [...fresh];
        for (let i = 0; i < 4; i++) w[i] += ((t[i] + (i === 3 ? 0 : -300 * (w[i] - 2))) / d.wheelInertia[i]) * DT;
        gaps.push(w[3] - w[2]);
      }
      return Math.max(...gaps.slice(60).map(Math.abs));
    };
    expect(run(4)).toBeLessThan(0.6);
    // Aimed at a single step, the locker overshoots by the trip's length and swings.
    expect(run(1)).toBeGreaterThan(2);
  });
});
