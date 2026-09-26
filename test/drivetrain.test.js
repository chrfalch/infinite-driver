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
    const torques = drive.update(DT, inputFn(t, v), spins, v, R);
    const force = torques.reduce((a, b) => a + b, 0) / R - drag * v * Math.abs(v) - Math.sign(v) * 0.018 * MASS * 9.81 * (Math.abs(v) > 0.05 ? 1 : 0);
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
    expect(d.ratio()).toBeCloseTo(4.4 * 5.1 * 2.7, 5);
  });

  it('open axle splits torque equally; a locked axle feeds the slower wheel', () => {
    const run = (locked) => {
      const d = new Drivetrain({ ...DEFAULT_DRIVETRAIN, rearLock: locked });
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
});
