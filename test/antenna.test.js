import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { WHIP, createWhip, stepWhip, whipBend, whipPoint } from '../src/render/antenna.js';

const DT = 1 / 60;
const UP = new Vector3(0, 1, 0);
const deg = (r) => (r * 180) / Math.PI;

// Drives the base along x with the given speed (m/s) as a function of time.
function drive(whip, base, seconds, speedAt, t0 = 0, up = UP) {
  for (let t = t0; t < t0 + seconds; t += DT) {
    base.x += speedAt(t) * DT;
    stepWhip(whip, base, up, DT);
  }
}

describe('whip antenna', () => {
  it('stands straight on a parked, level car', () => {
    const base = new Vector3(0, 1, 0);
    const whip = createWhip(base, UP);
    drive(whip, base, 3, () => 0);
    expect(deg(whipBend(whip))).toBeLessThan(0.01);
    expect(whip.tip.distanceTo(base)).toBeCloseTo(WHIP.length, 5);
  });

  it('leans back at speed and rings when the car stops dead', () => {
    const base = new Vector3();
    const whip = createWhip(base, UP);
    drive(whip, base, 4, (t) => Math.min(12, t * 6));
    // Air drag holds it back, behind the base.
    expect(deg(whipBend(whip))).toBeGreaterThan(10);
    expect(whip.tip.x).toBeLessThan(base.x);
    // A sudden stop throws it forward, then it swings back and forth and settles.
    let forward = 0;
    let swings = 0;
    let last = Math.sign(whip.tip.x - base.x);
    for (let t = 0; t < 3; t += DT) {
      stepWhip(whip, base, UP, DT);
      const dx = whip.tip.x - base.x;
      forward = Math.max(forward, dx);
      if (Math.sign(dx) !== last) swings++;
      last = Math.sign(dx);
    }
    expect(forward).toBeGreaterThan(0.3);
    expect(swings).toBeGreaterThanOrEqual(4);
    drive(whip, base, 15, () => 0);
    expect(deg(whipBend(whip))).toBeLessThan(1);
  });

  it('bends downhill when the car stands on a slope', () => {
    const base = new Vector3();
    const tilted = new Vector3(0.3, 1, 0).normalize(); // chassis rolled, up leans toward +x
    const whip = createWhip(base, tilted);
    drive(whip, base, 6, () => 0, 0, tilted);
    expect(whip.tip.x).toBeGreaterThan(base.x + WHIP.length * tilted.x);
  });

  it('snaps back upright when the car is teleported', () => {
    const base = new Vector3();
    const whip = createWhip(base, UP);
    drive(whip, base, 1, () => 15);
    base.set(100, 5, 0);
    stepWhip(whip, base, UP, DT);
    expect(whipBend(whip)).toBe(0);
    expect(whip.tip.distanceTo(base)).toBeCloseTo(WHIP.length, 5);
  });

  it('draws a whip that leaves the base straight up and ends at the tip', () => {
    const base = new Vector3();
    const whip = createWhip(base, UP);
    drive(whip, base, 2, (t) => t * 6);
    const p0 = whipPoint(whip, 0, new Vector3());
    const p1 = whipPoint(whip, 0.02, new Vector3());
    const end = whipPoint(whip, 1, new Vector3());
    expect(p0.distanceTo(whip.base)).toBeLessThan(1e-9);
    expect(end.distanceTo(whip.tip)).toBeLessThan(1e-9);
    expect(p1.clone().sub(p0).normalize().dot(UP)).toBeGreaterThan(0.99);
  });
});
