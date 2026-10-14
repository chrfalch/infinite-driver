import { describe, expect, it } from 'vitest';
import { DEFAULT_HOURS, bearingOf, clock, elevationOf, lightingAt, moonDirection, startHour, sunDirection } from '../src/render/time-of-day.js';

// The hour the sun crosses the horizon, searched between a and b.
function crossing(a, b) {
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    if (Math.sign(sunDirection(m).y) === Math.sign(sunDirection(a).y)) a = m;
    else b = m;
  }
  return a;
}

describe('sun', () => {
  it('rises in the east in the morning and sets in the west in the evening', () => {
    const rise = crossing(0, 12);
    const set = crossing(12, 24);
    expect(rise).toBeGreaterThan(4.5);
    expect(rise).toBeLessThan(6.5);
    expect(set).toBeGreaterThan(17.5);
    expect(set).toBeLessThan(19.5);
    // World +x is east, -z north: bearings 90 and 270, within the season's swing toward the north.
    expect(bearingOf(sunDirection(rise))).toBeGreaterThan(60);
    expect(bearingOf(sunDirection(rise))).toBeLessThan(90);
    expect(bearingOf(sunDirection(set))).toBeGreaterThan(270);
    expect(bearingOf(sunDirection(set))).toBeLessThan(300);
    expect(sunDirection(rise).x).toBeGreaterThan(0.8);
    expect(sunDirection(set).x).toBeLessThan(-0.8);
  });

  it('is due south and highest at noon, below the horizon at midnight', () => {
    const noon = sunDirection(12);
    expect(noon.x).toBeCloseTo(0, 6);
    expect(noon.z).toBeGreaterThan(0); // +z is south
    expect(elevationOf(noon)).toBeCloseTo(90 - 37 + 12, 3);
    expect(elevationOf(sunDirection(11))).toBeLessThan(elevationOf(noon));
    expect(elevationOf(sunDirection(0))).toBeLessThan(-30);
  });

  it('moves east to south to west through the day', () => {
    expect(bearingOf(sunDirection(9))).toBeGreaterThan(90);
    expect(bearingOf(sunDirection(9))).toBeLessThan(180);
    expect(bearingOf(sunDirection(15))).toBeGreaterThan(180);
    expect(bearingOf(sunDirection(15))).toBeLessThan(270);
  });
});

describe('moon', () => {
  it('is full: up at night, due south at midnight, opposite the sun', () => {
    expect(elevationOf(moonDirection(0))).toBeGreaterThan(30);
    expect(moonDirection(0).x).toBeCloseTo(0, 6);
    expect(moonDirection(0).z).toBeGreaterThan(0);
    expect(elevationOf(moonDirection(12))).toBeLessThan(-30);
    // Rises in the east around sunset.
    expect(moonDirection(19).x).toBeGreaterThan(0.8);
  });
});

describe('lighting', () => {
  it('is lit by the sun by day and by the moon at night, dark only at night', () => {
    const day = lightingAt(14);
    expect(day.light.moon).toBe(false);
    expect(day.dark).toBe(0);
    expect(day.light.intensity).toBeGreaterThan(3);
    const night = lightingAt(0);
    expect(night.light.moon).toBe(true);
    expect(night.dark).toBe(1);
    expect(night.light.intensity).toBeLessThan(0.2);
    // The shadow-casting light at night comes from the moon's side of the sky.
    expect(night.light.direction.z).toBeGreaterThan(0);
  });

  it('fades smoothly through dusk without jumps in light strength', () => {
    let last = lightingAt(17).light.intensity;
    for (let h = 17; h <= 21; h += 1 / 60) {
      const i = lightingAt(h).light.intensity;
      expect(Math.abs(i - last)).toBeLessThan(0.1);
      last = i;
    }
  });

  it('keeps the shadow-casting light a little above the horizon', () => {
    for (let h = 0; h < 24; h += 0.25) expect(elevationOf(lightingAt(h).light.direction)).toBeGreaterThanOrEqual(6.99);
  });

  it('glows around the sun at sunset, not at noon or midnight', () => {
    expect(lightingAt(18.6).glow).toBeGreaterThan(0.5);
    expect(lightingAt(12).glow).toBe(0);
    expect(lightingAt(0).glow).toBe(0);
  });
});

describe('time setting', () => {
  it('reads ?time= as hours or hh:mm, else the world default', () => {
    expect(startHour('canyon', '?time=18.5')).toBe(18.5);
    expect(startHour('canyon', '?time=06:45')).toBe(6.75);
    expect(startHour('canyon', '?time=25')).toBe(1);
    expect(startHour('town', '')).toBe(DEFAULT_HOURS.town);
    expect(startHour('flat', '')).toBe(14);
  });

  it('formats a clock', () => {
    expect(clock(0)).toBe('00:00');
    expect(clock(13.5)).toBe('13:30');
    expect(clock(23.999)).toBe('00:00');
    expect(clock(24)).toBe('00:00');
  });
});
