import { describe, expect, it } from 'vitest';
import { clearanceElevation } from '../src/camera-clearance.js';

describe('clearanceElevation', () => {
  it('is 0 on flat ground', () => {
    expect(clearanceElevation(() => 0, 0, 0, 0, 0, 80)).toBe(0);
  });

  it('climbs over a wall between the camera and the car', () => {
    // A 20 m wall 10-14 m out along +x (azimuth 0), the side the camera is on.
    const wall = (x) => (x > 10 && x < 14 ? 20 : 0);
    const el = clearanceElevation(wall, 0, 0, 0, 0, 80);
    // The line from 1.5 m above the car has to pass 1 m over the wall's top at about 10 m out.
    expect(el).toBeGreaterThan(Math.atan2(19.5, 14));
    expect(el).toBeLessThan(Math.atan2(19.5, 10));
  });

  it('ignores terrain on the far side of the car and beyond the range', () => {
    const wall = (x) => (x < -10 || x > 90 ? 50 : 0);
    expect(clearanceElevation(wall, 0, 0, 0, 0, 80)).toBe(0);
  });

  it('measures the terrain relative to the car', () => {
    // The car sits on a 30 m plateau; the camera side is level with it.
    expect(clearanceElevation(() => 30, 0, 30, 0, 1.2, 60)).toBe(0);
  });
});
