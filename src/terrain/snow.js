// Snowfield: a wide plain under fresh snow, with a ploughed two-lane road winding through it. The
// work goes into how it drives: the tyres sink into fresh snow, pack it down into ruts that are
// firmer and slicker than the snow around them, and throw fine powder when they spin or slide.
//
// The snow has a depth that varies (snowAt): 30 cm of fresh snow on the plain; on the road a thin
// layer of snow packed by traffic, worn through to bare asphalt in the four wheel tracks and in
// patches; and along both road edges the plough banks ("brøytekanter"), humps of firm snow up to
// about 60 cm above the snow beside them. The ground under the snow is flat but for a broad, slow
// swell. Everything else about snow lives in SNOW below and in the systems that read it (tyre
// solver, compaction, spray, the snow surface mesh).
import { createNoise2D } from 'simplex-noise';
import { mulberry32 } from './height.js';

// How snow behaves under a tyre. Stiffness is per tyre particle, like the solver's soil spring:
// fresh powder gives a few cm under the tread (on top of the rut it packs), packed snow is about as
// firm as the solver's hard ground. Grip is a share of the tyre's friction setting. With these the
// buggy (45 kPa tyres) sinks about 10 cm at rest in fresh snow, reaches ~30 km/h in 6 s on full
// throttle with the rear wheels spinning, and brakes and corners at about 0.35 g (0.7 g and more
// on hard ground).
export const SNOW = Object.freeze({
  depth: 0.3, // m of fresh snow on the plain
  packRatio: 0.57, // fresh snow packs down by this share of its depth (a 30 cm layer to 17 cm ruts)
  packRate: 30, // 1/s: how fast the snow under the tread packs (fast; snow does not wait)
  bearing: 140, // kPa a fully packed rut bears (see compactSoil): 45 kPa tyres sink ~10 cm
  bermShare: 0.12, // share of the packed snow pushed up beside the rut
  freshStiffness: 450, // N/m per particle
  packedStiffness: 22000, // N/m per particle (capped at the solver's stable limit)
  rebound: 0.12, // share of the push kept as the tread lifts: packed snow does not spring back
  freshGrip: 0.36, // x the tyre's friction setting: rubber on fresh snow (with the lugs biting)
  packedGrip: 0.2, // x the tyre's friction setting: polished, packed snow in a rut or on the road
  asphaltGrip: 0.8, // x the tyre's friction setting: bare, cold asphalt
  maxSink: 0.22, // m below the (packed) surface a particle may go before it is stopped
  chassisFriction: 0.3, // chassis and body sliding on snow (Rapier colliders)
});

// Snow thinner than this is bare asphalt for the tyres (the shaders fade it in up to COVER_DEPTH).
export const BARE_DEPTH = 0.008;
export const COVER_DEPTH = 0.012;

// The road, by distance from its centre line (m). The shaders repeat roadSnowDepth (see
// render/terrain-mesh.js), so what is drawn as bare is bare for the tyres too.
export const ROAD = Object.freeze({
  halfWidth: 3.2, // asphalt either side of the centre line
  tracks: [0.75, 2.25], // wheel tracks of both lanes (distance from the centre line)
  trackWidth: 0.28, // width of a worn track
  thin: 0.025, // m of packed snow on the road between the tracks (it varies in patches)
  bankCentre: 4.3, // the plough bank's crest
  bankHalfWidth: 1.1,
  bankHeight: 0.6, // above the fresh snow beside the road
  bankFirmness: 0.6, // thrown snow is dense, already more than half packed (less where it is thin)
});

// Patches of thicker and thinner snow along the road (-1..1), a few tens of metres long, and
// smaller blotches (a few metres) where snow lies in the tracks too.
export const roadPatch = (x, z) => Math.sin(x * 0.21 + Math.sin(z * 0.17) * 2) * Math.sin(z * 0.23 + x * 0.05);
export const roadBlotch = (x, z) => Math.sin(x * 1.3 + Math.sin(z * 1.1) * 1.7) * Math.sin(z * 1.7 + Math.sin(x * 0.9) * 1.4);
// The wheel tracks wander a little across the lane, and each is wider in places.
const trackAt = (d, t, x, z) => {
  const wander = 0.12 * Math.sin(x * 0.09 + z * 0.05 + t);
  const width = ROAD.trackWidth * (1 + 0.25 * Math.sin(x * 0.31 + z * 0.13 + 2 * t));
  return Math.exp(-(((d - t - wander) / width) ** 2));
};
export const wheelTracks = (d, x, z) => trackAt(d, ROAD.tracks[0], x, z) + trackAt(d, ROAD.tracks[1], x, z);
// Snow on the road itself (m): thin, and worn away in the wheel tracks (less so in the blotches).
export const roadSnowDepth = (d, x, z) =>
  Math.max(0, ROAD.thin * (0.55 + 0.5 * roadPatch(x, z)) - 0.03 * wheelTracks(d, x, z) * (0.8 - 0.35 * roadBlotch(x, z)));

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createSnowField(seed = 2024) {
  const swell = createNoise2D(mulberry32(seed));
  const drifts = createNoise2D(mulberry32(seed + 1));
  const lumps = createNoise2D(mulberry32(seed + 2));
  const W = ROAD.halfWidth;

  // The road's centre line z = g(x) - g(0), through the origin, and the distance to it (|f| / |grad
  // f|, close enough for its gentle bends).
  const g = (x) => 28 * Math.sin(x / 110) + 9 * Math.sin(x / 37 + 1.3);
  const dg = (x) => (28 / 110) * Math.cos(x / 110) + (9 / 37) * Math.cos(x / 37 + 1.3);
  const g0 = g(0);
  const roadSide = (x, z) => (z - (g(x) - g0)) / Math.hypot(1, dg(x)); // signed: + on the +z side
  const roadDistance = (x, z) => Math.abs(roadSide(x, z));

  // The snow at a point: depth (m), firmness (how packed it already is, 0 fresh .. 1 packed), and
  // how much deeper tyres can still pack it (packDepth, m).
  function snowAt(x, z) {
    const d = roadDistance(x, z);
    const road = roadSnowDepth(d, x, z);
    let depth = road;
    let firm = 1;
    if (d > W - 0.2) {
      // Just outside the asphalt the plough leaves a strip of packed snow, then the bank, then the
      // fresh snow of the plain (with long wind drifts in it).
      const verge = road + (0.05 - road) * smoothstep(W - 0.2, W + 0.3, d);
      const u = (d - ROAD.bankCentre) / ROAD.bankHalfWidth;
      // Lumpy: big chunks thrown by the plough on a bank that swells and dips along the road.
      const lumpy = 0.85 + 0.18 * lumps(x * 0.45, z * 0.45) + 0.1 * lumps(x * 1.6 + 40, z * 1.6);
      const bank = ROAD.bankHeight * Math.max(0, 1 - u * u) * lumpy * (0.9 + 0.2 * lumps(x * 0.04, z * 0.04));
      const fresh = (SNOW.depth + drifts(x * 0.012, z * 0.035) * 0.06) * smoothstep(W, W + 1, d);
      // The plough throws the road's snow on top of the snow already lying beside it.
      depth = Math.max(verge, fresh + bank);
      firm = depth === verge ? 1 : (ROAD.bankFirmness * bank) / (bank + fresh + 1e-6);
    }
    return { depth, firm, packDepth: SNOW.packRatio * depth * (1 - firm), dist: d };
  }

  const ground = (x, z) => swell(x * 0.006, z * 0.006) * 0.35;
  const heightAt = (x, z) => ground(x, z) + snowAt(x, z).depth;
  heightAt.world = 'snow';
  heightAt.snow = SNOW;
  heightAt.snowAt = snowAt;
  heightAt.roadDistance = roadDistance;
  // The shaders take the signed distance: it interpolates across the centre line, |d| does not.
  heightAt.roadSide = roadSide;
  // Heading (radians about +y, 0 = +x) along the road.
  heightAt.roadHeading = (x) => -Math.atan(dg(x));
  // Bare asphalt: no ruts, no spray, nothing piles up on it (like the dry river's bare rock).
  heightAt.bareAt = (x, z) => snowAt(x, z).depth < BARE_DEPTH / 2;
  return heightAt;
}
