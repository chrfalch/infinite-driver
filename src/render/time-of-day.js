// Time of day: where the sun and moon are at a given hour, and the light and sky colours that go
// with it. World axes: +x is east, -z is north (as on the minimap), +y is up.
//
// The sun follows a simple solar model at a fixed latitude and date: it rises in the east, is due
// south at noon and sets in the west. The moon is full, opposite the sun: it rises in the east at
// dusk, is due south at midnight and sets in the west at dawn. Everything else (light colour and
// strength, the sky and haze, the stars, whether it is dark enough for headlights) follows the
// sun's elevation, so each world has one palette for day and one for night, and twilight in
// between is shared.
import { Color } from 'three/webgpu';
import { loadSettings } from '../settings-store.js';

const RAD = Math.PI / 180;

// A canyon-country latitude in late spring: sunrise about 05:20 a little north of east, the sun
// 65° up in the south at noon, sunset about 18:40 a little north of west. Hours are local solar time.
export const SUN = Object.freeze({ latitude: 37, declination: 12 });

// The unit vector toward a body at `declination` seen at `hour` (hour angle 0 = due south at 12:00).
function skyDirection(hour, declination, latitude) {
  const h = (hour - 12) * 15 * RAD;
  const d = declination * RAD;
  const p = latitude * RAD;
  const east = -Math.cos(d) * Math.sin(h);
  const north = Math.sin(d) * Math.cos(p) - Math.cos(d) * Math.cos(h) * Math.sin(p);
  const up = Math.sin(d) * Math.sin(p) + Math.cos(d) * Math.cos(h) * Math.cos(p);
  return { x: east, y: up, z: -north };
}

export function sunDirection(hour, { latitude, declination } = SUN) {
  return skyDirection(hour, declination, latitude);
}

// The full moon: 12 hours behind the sun, on the opposite side of the equator.
export function moonDirection(hour, { latitude, declination } = SUN) {
  return skyDirection(hour + 12, -declination, latitude);
}

export const elevationOf = (dir) => Math.asin(Math.max(-1, Math.min(1, dir.y))) / RAD;
// Compass bearing in degrees (0 north, 90 east).
export const bearingOf = (dir) => ((Math.atan2(dir.x, -dir.z) / RAD) + 360) % 360;

// Hour as "hh:mm".
export function clock(hour) {
  const m = Math.round((((hour % 24) + 24) % 24) * 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// The hour each world starts at until the player picks another: the canyon and the river in the
// afternoon, the snowfield and the town at night (as they were made).
export const DEFAULT_HOURS = Object.freeze({ canyon: 15.5, river: 14, snow: 22.5, town: 22.5 });
const STORAGE_KEY = 'drift.time.v1';

// ?time=<hours> (e.g. 18.5, or 18:30) overrides the saved hour for this page load.
export function startHour(world, search = globalThis.location?.search ?? '') {
  const param = new URLSearchParams(search).get('time');
  if (param !== null) {
    const [h, m = 0] = param.split(':').map(Number);
    const hour = h + m / 60;
    if (Number.isFinite(hour)) return ((hour % 24) + 24) % 24;
  }
  const saved = loadSettings(STORAGE_KEY)[world];
  return typeof saved === 'number' ? saved : (DEFAULT_HOURS[world] ?? 14);
}

export function saveHour(world, hour) {
  try {
    const all = loadSettings(STORAGE_KEY);
    if (hour === (DEFAULT_HOURS[world] ?? 14)) delete all[world];
    else all[world] = hour;
    if (Object.keys(all).length) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all));
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); the hour then lasts for this session.
  }
}

// Twilight, the same in every world: the sky's colours at sunset and in the blue hour after it.
const SUNSET = { horizon: new Color('#f2a36c'), top: new Color('#4d6aa6'), background: new Color('#dcb7a0') };
const BLUE_HOUR = { horizon: new Color('#4b5679'), top: new Color('#141d3a'), background: new Color('#2b3249') };
// A night sky for worlds that do not have their own.
export const NIGHT_SKY = { horizon: new Color('#151d2b'), top: new Color('#02040a'), background: new Color('#0b111c') };

// Light keyed by the sun's elevation (degrees): skylight colours and strength.
const HEMI = [
  [-14, '#41557c', '#1d2638', 0.13],
  [-6, '#56659a', '#272e44', 0.22],
  [0, '#f0b9a0', '#5a4c46', 0.5],
  [8, '#ffe3c4', '#6c6f58', 0.8],
  [20, '#fff6e8', '#6f7d5e', 0.9],
].map(([e, sky, ground, intensity]) => ({ e, sky: new Color(sky), ground: new Color(ground), intensity }));
// Sunlight colour by elevation: red at the horizon, golden low down, white-warm high up.
const SUN_COLOR = [
  [0, '#ff7d40'],
  [6, '#ffbe82'],
  [14, '#ffe2bd'],
  [25, '#fff1dc'],
].map(([e, c]) => ({ e, c: new Color(c) }));
export const SUN_INTENSITY = 3.2;
export const MOON_INTENSITY = 0.15;
const MOON_COLOR = new Color('#a9bde6');
// Shadows from a sun lower than this stretch across the whole shadow box; the light keeps at least
// this elevation (the sky still shows the sun where it really is).
const MIN_LIGHT_ELEVATION = 7;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Interpolates a table of keyframes sorted by `e`.
function keyed(table, e, pick, out) {
  if (e <= table[0].e) return pick(table[0], out, null, 0);
  for (let i = 1; i < table.length; i++) {
    if (e <= table[i].e) return pick(table[i - 1], out, table[i], smooth(table[i - 1].e, table[i].e, e));
  }
  return pick(table[table.length - 1], out, null, 0);
}

// The sky palette (horizon, top, isometric background) at a sun elevation, between the world's
// day and night palettes through the shared sunset and blue hour.
export function skyPalette(e, day, night, out = { horizon: new Color(), top: new Color(), background: new Color() }) {
  const stops = [
    { e: -14, p: night },
    { e: -6, p: BLUE_HOUR },
    { e: 0, p: SUNSET },
    { e: 12, p: day },
  ];
  return keyed(stops, e, (a, o, b, t) => {
    for (const key of ['horizon', 'top', 'background']) {
      o[key].copy(a.p[key]);
      if (b) o[key].lerp(b.p[key], t);
    }
    return o;
  }, out);
}

// Everything the scene needs at `hour`: the directional light (toward the light, its colour and
// intensity; the sun by day, the moon by night), the skylight, the sun and moon in the sky, how dark
// it is (0 day .. 1 night) and how strong the sunset glow is around the sun.
export function lightingAt(hour, options = SUN) {
  const sun = sunDirection(hour, options);
  const moon = moonDirection(hour, options);
  const sunE = elevationOf(sun);
  const moonE = elevationOf(moon);
  const dark = smooth(-1, -9, sunE);
  const sunIntensity = SUN_INTENSITY * smooth(-1, 12, sunE);
  const moonIntensity = MOON_INTENSITY * smooth(0, 8, moonE) * dark;
  const byMoon = moonIntensity > sunIntensity;
  const body = byMoon ? moon : sun;
  const lightColor = byMoon ? MOON_COLOR.clone() : keyed(SUN_COLOR, sunE, (a, o, b, t) => (b ? o.copy(a.c).lerp(b.c, t) : o.copy(a.c)), new Color());
  const hemi = keyed(
    HEMI,
    sunE,
    (a, o, b, t) => {
      o.sky.copy(a.sky);
      o.ground.copy(a.ground);
      o.intensity = a.intensity;
      if (b) {
        o.sky.lerp(b.sky, t);
        o.ground.lerp(b.ground, t);
        o.intensity += (b.intensity - a.intensity) * t;
      }
      return o;
    },
    { sky: new Color(), ground: new Color(), intensity: 0 },
  );
  return {
    sun,
    moon,
    sunElevation: sunE,
    light: { direction: liftAbove(body, MIN_LIGHT_ELEVATION), color: lightColor, intensity: byMoon ? moonIntensity : sunIntensity, moon: byMoon },
    hemi,
    dark,
    // Sunset glow: strongest with the sun at the horizon, gone 15° up and in full night.
    glow: smooth(15, 2, sunE) * smooth(-10, -2, sunE),
  };
}

// The same compass direction as `dir`, but at least `minDeg` above the horizon.
function liftAbove(dir, minDeg) {
  const e = Math.max(elevationOf(dir), minDeg) * RAD;
  const flat = Math.hypot(dir.x, dir.z) || 1;
  return { x: (dir.x / flat) * Math.cos(e), y: Math.sin(e), z: (dir.z / flat) * Math.cos(e) };
}
