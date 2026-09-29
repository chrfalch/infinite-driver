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
  cylinderGain: [1.0, 0.93, 1.05, 0.96],
  ampJitter: 0.1,
  timingJitter: 0.003, // share of the firing interval
  // Exhaust pulse: a sharp blowdown spike and a longer body that lasts a share of the interval
  // between firings. With no fuel (coasting) the engine still pumps air: `motoring` of the strength.
  motoring: 0.3,
  spike: 0.6,
  spikeTime: 0.0004, // s
  bodyShare: 0.3,
  // Exhaust pipe: a round trip of 2 × length at the hot gas' speed of sound, reflected inverted at
  // the open end (feedback < 0) and a little duller each trip.
  pipe: { length: 3.2, speedOfSound: 520, feedback: -0.5, damping: 0.4 },
  // Silencer body resonances, added to the pipe's sound.
  muffler: [
    { f: 80, q: 2.2, gain: 0.9 },
    { f: 230, q: 2.8, gain: 0.45 },
  ],
  // Brightness: the low-pass cutoff over the exhaust (Hz) = base + load × fuel + perRpm × rpm.
  tone: { base: 220, load: 1500, perRpm: 0.3, q: 0.8 },
  // The block and head ring with each combustion, heard through the engine bay.
  block: { f: 620, q: 1.3, gain: 0.35 },
  // Diesel clatter: a metallic knock with each combustion, strongest at idle and low rpm.
  clatter: { level: 0.5, decay: 0.0009, bands: [{ f: 1900, q: 3, gain: 1 }, { f: 3700, q: 5, gain: 0.45 }] },
  gearWhine: { teeth: 29, level: 0.003 }, // timing gears
  turbo: {
    upTime: 0.7, // s, spool-up time constant
    downTime: 1.8, // s, spool-down
    whineMin: 2400, // Hz at no boost
    whineMax: 7200, // Hz at full boost
    whine: 0.02,
    hiss: 0.06,
    // Lifting off at boost: the compressor surges, a short "tu-tu-tu" flutter.
    flutter: 0.1,
    flutterRate: 19, // Hz
    flutterTime: 0.4, // s
  },
  // The exhaust brake closes a valve in the exhaust: a hard, raspy note on the overrun.
  exhaustBrake: { level: 0.35, rasp: 0.5 },
  idleRpm: 850,
  limiterRpm: 5400,
  gain: 0.55,
  topCut: 7000, // Hz, a gentle low-pass over everything
});

export const ENGINE_PRESETS = { 'Turbo-diesel I4': TURBO_DIESEL_I4 };
