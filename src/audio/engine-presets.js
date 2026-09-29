// Engine sounds as data for the procedural engine (engine-synth.js). A preset says how the
// cylinders fire and how the exhaust, the engine block, and the turbo colour the sound.
//
// Only the turbo-diesel four for now: the car's drivetrain is a turbo-diesel (vehicle/drivetrain.js),
// so the sound matches its torque curve and 5400 rpm limiter.

export const TURBO_DIESEL_I4 = Object.freeze({
  name: 'Turbo-diesel I4',
  cylinders: 4,
  // When each cylinder fires, as a share of the 720° four-stroke cycle, in cylinder order
  // (firing order 1-3-4-2, evenly 180° apart).
  firing: [0, 0.75, 0.25, 0.5],
  // No two cylinders are quite alike (injectors, compression): a fixed strength per cylinder gives
  // the half-order lumpiness of a real engine, and a small random spread per firing its roughness.
  cylinderGain: [1.0, 0.8, 1.15, 0.9],
  ampJitter: 0.22,
  // A slow random wander in strength over several firings (see EngineSynth.fire).
  wander: 0.4,
  timingJitter: 0.003, // share of the firing interval
  // Exhaust pulse: a sharp blowdown spike and a longer body that lasts a share of the interval
  // between firings. With no fuel (coasting) the engine still pumps air: `motoring` of the strength.
  motoring: 0.3,
  spike: 0.6,
  spikeTime: 0.0004, // s
  bodyShare: 0.3,
  // Exhaust pipe: a round trip of 2 × length at the hot gas' speed of sound, reflected inverted at
  // the open end (feedback < 0) and a little duller each trip.
  pipe: { length: 3.2, speedOfSound: 520, feedback: -0.25, damping: 0.5 },
  // Silencer body resonances, added to the pipe's sound.
  muffler: [
    { f: 70, q: 1.8, gain: 0.9 },
    { f: 145, q: 1.6, gain: 0.7 },
    { f: 260, q: 2.2, gain: 0.35 },
  ],
  // Turbulent flow: each pulse is roughened by noise low-passed at `frequency` (Hz), and the
  // silencer is overdriven (`drive`): together they turn a smooth tube tone into a rumble. More
  // roughness is heard as a noise generator on top of the engine (0.55 at 320 Hz was), and even
  // 0.12 made the dry pulses sound blown.
  rough: { amount: 0.06, frequency: 150 },
  drive: 2.5,
  // Brightness: the low-pass cutoff over the exhaust (Hz) = base + load × fuel + perRpm × rpm.
  tone: { base: 220, load: 1500, perRpm: 0.3, q: 0.8 },
  // The block and head ring with each combustion, heard through the engine bay.
  block: { f: 620, q: 1.3, gain: 0.35 },
  // Diesel clatter: a metallic knock with each combustion, strongest at idle and low rpm. A short
  // click (decay, s) with a share of noise rings inharmonic high-Q modes of the block.
  clatter: {
    level: 0.17,
    decay: 0.00015,
    noise: 0.2,
    bands: [
      { f: 1350, q: 14, gain: 1 },
      { f: 2250, q: 18, gain: 0.8 },
      { f: 3400, q: 20, gain: 0.6 },
      { f: 4700, q: 22, gain: 0.4 },
    ],
  },
  gearWhine: { teeth: 29, level: 0.003 }, // timing gears
  turbo: {
    upTime: 0.7, // s, spool-up time constant
    downTime: 1.8, // s, spool-down
    whineMin: 2400, // Hz at no boost
    whineMax: 6800, // Hz at full boost
    whine: 0.07,
    whine2: 0.45, // splitter-blade tone, relative to the main whistle
    whine2Ratio: 1.55,
    hiss: 0.2, // intake whoosh
    hissQ: 0.8,
    // Lifting off at boost: the compressor surges, a short "tu-tu-tu" flutter.
    flutter: 0.3,
    flutterRate: 19, // Hz
    flutterTime: 0.4, // s
    // Lifting off at boost the wastegate lets the boost off: a "pssh", band-passed noise at f
    // sweeping down to half as the pressure falls. Held at full boost it bleeds a little (bleedF).
    wastegate: { level: 0.5, time: 0.7, f: 3200, q: 1.1, bleed: 0.05, bleedF: 5200 },
  },
  // The exhaust brake closes a valve in the exhaust: a hard, raspy note on the overrun.
  exhaustBrake: { level: 0.35, rasp: 0.5 },
  // The level of each part of the sound (EngineSynth LAYERS), as tuned by ear in the engine lab
  // (then turbo and wastegate about a third lower).
  // The old clatter (a noise burst) sounded like a garden hose and was tuned out; the metallic one
  // above is new and starts silent too.
  layers: {
    pulses: 0.25,
    echo: 1.06,
    silencer1: 1.18,
    silencer2: 1.92,
    silencer3: 2,
    block: 1.21,
    clatter: 0,
    rasp: 1.89,
    whistle: 1.1,
    whoosh: 0.95,
    flutter: 0.7,
    wastegate: 1.0,
    gear: 1,
  },
  idleRpm: 850,
  limiterRpm: 5400,
  gain: 0.75,
  topCut: 7000, // Hz, a gentle low-pass over everything
});

// A big turbo-diesel V8 (a pickup or a Land Cruiser): cross-plane crank, one exhaust per bank
// joined in a Y-pipe before the silencer. Cylinders numbered with the odd ones on the left bank.
// Firing order 1-8-4-3-6-5-7-2, 90° apart: each bank on its own fires 270-180-90-180°, and that
// unevenness, heard through each bank's own header and pipe, is the burble.
const V8_ORDER = [1, 8, 4, 3, 6, 5, 7, 2];
export const TURBO_DIESEL_V8 = Object.freeze({
  ...TURBO_DIESEL_I4,
  name: 'Turbo-diesel V8',
  cylinders: 8,
  firing: [1, 2, 3, 4, 5, 6, 7, 8].map((c) => V8_ORDER.indexOf(c) / 8),
  banks: [0, 1, 0, 1, 0, 1, 0, 1],
  // Header length (m) from each port to its bank's collector: log manifolds, not equal length.
  headers: [0.45, 0.62, 0.55, 0.4, 0.72, 0.5, 0.6, 0.48],
  bankPipeLengths: [3.4, 3.9], // m, left and right, to the Y-pipe
  // Pulses close together in a bank's collector limit each other (the 90° pairs).
  collide: 1.8,
  // The listener hears the left bank better (the right one crosses over to the Y-pipe): with
  // equal banks the two uneven trains add up to an even one and most of the burble cancels.
  bankGain: [1, 0.6],
  gain: 0.9,
  cylinderGain: [1.0, 0.88, 1.08, 0.94, 1.04, 0.9, 1.1, 0.95],
  timingJitter: 0.006,
  // Bigger cylinders: a longer blowdown.
  bodyShare: 0.45,
  // A bigger silencer, lower resonances.
  muffler: [
    { f: 52, q: 1.8, gain: 0.9 },
    { f: 105, q: 1.6, gain: 0.7 },
    { f: 200, q: 2.2, gain: 0.35 },
  ],
  tone: { base: 180, load: 1300, perRpm: 0.25, q: 0.8 },
  block: { f: 480, q: 1.3, gain: 0.35 },
  idleRpm: 700,
});

export const ENGINE_PRESETS = { 'Turbo-diesel I4': TURBO_DIESEL_I4, 'Turbo-diesel V8': TURBO_DIESEL_V8 };
