// Lights the scene for an hour of the day (render/time-of-day.js): the sun or moon's light and
// direction, the skylight, the sky and haze colours, and the things that come on in the dark (the
// town's windows, the headlight beams, a dimmer glow in powder snow).
import { Color } from 'three/webgpu';
import { setBuildingNight } from './building-mesh.js';
import { sky, worldLook } from './backdrop.js';
import { setHeadlightBeams } from './headlights.js';
import { setPowderGlow } from './soil-particles.js';
import { lightingAt, skyPalette } from './time-of-day.js';

// Haze (near, far, m) in the isometric views and in the low perspective views by day and by night
// (closer in the dark).
const ORTHO_FOG = [125, 210];
const DAY_FOG = [80, 210];
const NIGHT_FOG = [20, 120];
// Darker than this and the headlights cast their beams; the player's lights switch on (or off)
// when the hour is set across it.
const BEAMS_AT = 0.3;
const LIGHTS_ON_AT = 0.5;

export function createDaylight(render, world) {
  const look = worldLook(world);
  const palette = { horizon: new Color(), top: new Color(), background: new Color() };
  const daylight = {
    world,
    hour: 12,
    dark: 0,
    // Toward the light that casts the shadows (the sun, or the moon at night).
    lightDirection: { x: 0, y: 1, z: 0 },
    // The isometric views' plain background, and the horizon the low views' haze fades into.
    background: palette.background,
    horizon: palette.horizon,
    orthoFog: ORTHO_FOG,
    perspectiveFog: [...DAY_FOG],
    // Called with true or false when the hour is set across dusk or dawn.
    onDarkChange: null,
    set(hour) {
      const wasDark = this.dark > LIGHTS_ON_AT;
      const l = lightingAt(hour);
      this.hour = hour;
      this.dark = l.dark;
      this.lightDirection = l.light.direction;
      render.sun.color.copy(l.light.color);
      render.sun.intensity = l.light.intensity;
      render.hemi.color.copy(l.hemi.sky);
      render.hemi.groundColor.copy(l.hemi.ground);
      render.hemi.intensity = l.hemi.intensity;

      skyPalette(l.sunElevation, look.day, look.night, palette);
      sky.horizon.value.copy(palette.horizon);
      sky.top.value.copy(palette.top);
      sky.sun.value.set(l.sun.x, l.sun.y, l.sun.z);
      sky.moon.value.set(l.moon.x, l.moon.y, l.moon.z);
      sky.glow.value.copy(l.light.moon ? BLACK : l.light.color).multiplyScalar(l.glow);
      sky.dark.value = l.dark;
      this.perspectiveFog[0] = DAY_FOG[0] + (NIGHT_FOG[0] - DAY_FOG[0]) * l.dark;
      this.perspectiveFog[1] = DAY_FOG[1] + (NIGHT_FOG[1] - DAY_FOG[1]) * l.dark;

      setBuildingNight(l.dark);
      setHeadlightBeams(l.dark > BEAMS_AT);
      // The powder's scattered glow is only the faint skylight's at night.
      setPowderGlow(1 + (0.08 - 1) * l.dark);
      const isDark = l.dark > LIGHTS_ON_AT;
      if (isDark !== wasDark) this.onDarkChange?.(isDark);
    },
  };
  return daylight;
}
const BLACK = new Color(0, 0, 0);
