// How high the camera has to look down from to see the car over the terrain in between. Mesas and
// ridges between the camera and the car (follow mode swings the camera behind the car, often over a
// canyon wall) would otherwise hide it; the camera climbs to this angle and eases back down after.

const SAMPLES = 40;
const NEAR = 3; // m from the car where the terrain starts to count (the car's own slope is below)
const EYE = 1.5; // m above the car's origin the camera has to see (the body, not just the wheels)
const MARGIN = 1; // m the line of sight keeps above the ground

// The lowest elevation (radians above the horizon) from which the line of sight to a point `EYE`
// above (x, y, z), coming in from the horizontal direction `azimuth` (offset (cos az, sin az) points
// from the car to the camera), clears the ground out to `range` metres. 0 when nothing is in the way.
export function clearanceElevation(heightAt, x, y, z, azimuth, range) {
  const cx = Math.cos(azimuth);
  const cz = Math.sin(azimuth);
  const eye = y + EYE;
  let best = 0;
  if (!(range > NEAR)) return best;
  for (let i = 0; i < SAMPLES; i++) {
    // Denser near the car, where a small bump already blocks a wide angle.
    const t = (i + 1) / SAMPLES;
    const s = NEAR + (range - NEAR) * t * t;
    const rise = heightAt(x + cx * s, z + cz * s) + MARGIN - eye;
    if (rise > 0) best = Math.max(best, Math.atan2(rise, s));
  }
  return best;
}
