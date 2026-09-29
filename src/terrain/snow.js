// Snowfield: a wide, flat plain under fresh snow. For now the world is only the snow itself, so the
// work goes into how it drives: the tyres sink into fresh snow, pack it down into ruts that are
// firmer and slicker than the snow around them, and throw fine powder when they spin or slide.
//
// The ground under the snow is flat but for long, low wind drifts (a few cm over tens of metres),
// so the plain is not a dead-flat table. Everything else about snow lives in SNOW below and in the
// systems that read it (tyre solver, compaction, spray, the snow surface mesh).
import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from './height.js';

// How snow behaves under a tyre. Stiffness is per tyre particle, like the solver's soil spring:
// fresh powder gives a few cm under the tread (on top of the rut it packs), packed snow is about as
// firm as the solver's hard ground. Grip is a share of the tyre's friction setting. With these the
// buggy (45 kPa tyres) sinks about 10 cm at rest, reaches ~30 km/h in 6 s on full throttle with the
// rear wheels spinning, and brakes and corners at about 0.35 g (0.7 g and more on hard ground).
export const SNOW = Object.freeze({
  depth: 0.3, // m of fresh snow
  packDepth: 0.17, // m: fresh snow packs down to about 45 % of its depth, so ruts end this deep
  packRate: 30, // 1/s: how fast the snow under the tread packs (fast; snow does not wait)
  bearing: 140, // kPa a fully packed rut bears (see compactSoil): 45 kPa tyres sink ~10 cm
  bermShare: 0.12, // share of the packed snow pushed up beside the rut
  freshStiffness: 450, // N/m per particle
  packedStiffness: 22000, // N/m per particle (capped at the solver's stable limit)
  rebound: 0.12, // share of the push kept as the tread lifts: packed snow does not spring back
  freshGrip: 0.36, // x the tyre's friction setting: rubber on fresh snow (with the lugs biting)
  packedGrip: 0.2, // x the tyre's friction setting: polished, packed snow in a rut
  maxSink: 0.22, // m below the (packed) surface a particle may go before it is stopped
  chassisFriction: 0.3, // chassis and body sliding on snow (Rapier colliders)
});

export function createSnowField(seed = 2024) {
  const noise = createNoise2D(mulberry32(seed));
  const drifts = createNoise2D(mulberry32(seed + 1));
  // Long drifts, stretched across the wind (from +x), and a broad, slow swell.
  const heightAt = (x, z) => noise(x * 0.006, z * 0.006) * 0.35 + drifts(x * 0.012, z * 0.035) * 0.06;
  heightAt.world = 'snow';
  heightAt.snow = SNOW;
  return heightAt;
}
