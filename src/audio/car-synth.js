// Procedural sounds of the car itself: its driveline, steering and body. Pure maths like the
// engine and ground synths; the audio worklet adds it after them.
//   gearWhine  gearbox gears meshing (engine speed × teeth); the straight-cut reverse and first whine
//   transfer   the transfer case in low range: a loud whine at propshaft speed × teeth
//   axle       the differentials' ring and pinion (wheel speed × ring teeth)
//   clunk      the driveline's backlash taken up when the torque swaps sides (on or off the throttle)
//   shift      the gearbox changing gear: a clunk and the synchro's click
//   lock       a differential lock going in or out
//   cv         the front CV joints clicking near full lock under drive
//   pump       the power steering pump's whine, louder while steering, a groan held at full lock
//   rattle     loose bits rattling when the chassis is shaken
//   creak      the body creaking as the chassis twists
//   wind       air rushing past, with speed squared
// From the audio feed: rpm, gear, clutch, speed, low, locks, shaft, clunks, steer, heave, twist,
// and the wheels' tread speed and contact (see feed.js and wheels.js).
import { Svf } from './engine-synth.js';
import { CENTERED } from './mix.js';

export const CAR_LAYERS = Object.freeze({
  gearWhine: 1,
  transfer: 1,
  axle: 1,
  clunk: 1,
  shift: 1,
  lock: 1,
  cv: 1,
  pump: 1,
  rattle: 1,
  creak: 1,
  wind: 1,
});

export const CAR_SOUND = Object.freeze({
  name: '4x4 driveline and body',
  // Gear ratios (as the drivetrain's), for the propshaft's speed.
  gears: [4.4, 2.6, 1.65, 1.18, 0.88],
  reverse: 4.0,
  gearWhine: { teeth: 23, level: 0.01, first: 2, reverseTeeth: 17, reverse: 6 }, // first, reverse: × level
  transfer: { teeth: 31, level: 0.035 },
  axle: { teeth: 41, level: 0.008, from: 3, full: 25 }, // m/s
  // Struck sounds: modes { f, q, gain } rung by an impulse, and a short noise burst (s, Hz).
  clunk: { level: 0.25, max: 1.5, burst: 0.006, burstF: 500, modes: [{ f: 170, q: 4, gain: 1 }, { f: 640, q: 8, gain: 0.5 }] },
  shift: { level: 0.12, max: 1, burst: 0.003, burstF: 1800, modes: [{ f: 260, q: 5, gain: 0.6 }, { f: 1800, q: 14, gain: 0.5 }] },
  lock: { level: 0.1, max: 1, burst: 0.002, burstF: 2400, modes: [{ f: 520, q: 4, gain: 0.6 }, { f: 2400, q: 12, gain: 0.6 }] },
  // Small ticks are mostly a short burst with wide, low rings (a narrow ring sounds like a drip).
  cv: { balls: 6, level: 0.04, from: 0.8, full: 0.97, burst: 0.0008, burstF: 2600, modes: [{ f: 1600, q: 2.5, gain: 0.6 }] },
  pump: { vanes: 10, pulley: 1.3, level: 0.003, steering: 0.015, groan: 0.04, groanF: 380 },
  // A rattle rings one of these, each time at a random pitch around it (±25 %).
  rattle: { from: 2, perAccel: 5, level: 0.06, burst: 0.0015, burstF: 2500, modes: [{ f: 1250, q: 5, gain: 0.7 }, { f: 2150, q: 6, gain: 0.6 }, { f: 3450, q: 6, gain: 0.4 }] },
  creak: { from: 10, full: 35, level: 0.05, f: 420, q: 30 }, // twist in rad/s²
  wind: { level: 0.25, full: 30, f: 700, gust: 0.4 }, // full: m/s
  gain: 1,
  layers: { ...CAR_LAYERS },
});

const STRUCK = ['clunk', 'shift', 'lock', 'cv', 'rattle'];
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export class CarSynth {
  constructor(sampleRate, preset = CAR_SOUND, { seed = 4242 } = {}) {
    this.sr = sampleRate;
    this.random = rng(seed);
    this.layers = { ...CAR_LAYERS };
    this.effective = { ...CAR_LAYERS };
    this.level = 1;
    this.banks = Object.fromEntries(STRUCK.map((k) => [k, { modes: [], burst: new Svf(), kick: 0, env: 0 }]));
    this.phase = { gear: 0, transfer: 0, axle: 0, pump: 0, cv: 0 };
    this.creak = new Svf();
    this.creakWobble = 0;
    this.wind = new Svf();
    this.gust = 0;
    this.groan = new Svf();
    this.counters = {};
    this.lastGear = null;
    this.lastLocks = null;
    this.lastSteer = 0;
    this.setPreset(preset);
  }

  setPreset(preset) {
    const sr = this.sr;
    this.preset = preset;
    for (const k of STRUCK) {
      const bank = this.banks[k];
      const spec = preset[k];
      while (bank.modes.length < spec.modes.length) bank.modes.push(new Svf());
      bank.modes.length = spec.modes.length;
      spec.modes.forEach((m, i) => bank.modes[i].set(m.f, m.q, sr));
      bank.burst.set(spec.burstF, 0.8, sr);
    }
    this.creak.set(preset.creak.f, preset.creak.q, sr);
    this.wind.set(preset.wind.f, 0.5, sr);
    this.groan.set(preset.pump.groanF, 6, sr);
  }

  setLayers(layers) {
    Object.assign(this.layers, layers);
  }

  strike(kind, strength, at) {
    if (strength <= 0) return;
    const spec = this.preset[kind];
    const bank = this.banks[kind];
    const cap = spec.level * (spec.max ?? 1) * this.effective[kind] * this.level;
    const a = spec.level * Math.min(spec.max ?? 1, Math.sqrt(strength)) * this.effective[kind] * this.level;
    bank.kick = Math.min(cap, bank.kick + a);
    bank.env = Math.max(bank.env, a);
    bank.pan = at;
  }

  // Adds the car's sounds to outL/outR[start..end), from feed state a to b; pos as ground-synth.js.
  render(outL, outR, a, b, start = 0, end = outL.length, pos = CENTERED) {
    const n = end - start;
    if (n <= 0) return;
    const p = this.preset;
    const sr = this.sr;
    const dt = 1 / sr;
    const blockT = n * dt;
    const L = this.effective;
    for (const k in CAR_LAYERS) L[k] = this.muted?.has(k) ? 0 : (p.layers?.[k] ?? 1) * this.layers[k]; // muted: played recorded (foley.js)
    const level = this.level;
    const mid = (k) => ((a[k] ?? 0) + (b[k] ?? 0)) / 2;
    const rpm = mid('rpm');
    const gear = b.gear ?? 0;
    const clutch = Math.min(1, Math.max(0, mid('clutch')));
    const shaft = Math.abs(mid('shaft'));
    const load = 0.3 + 0.7 * Math.min(1, shaft / 3);
    const speed = Math.abs(mid('speed'));
    const low = mid('low');
    const steer = mid('steer');
    const body = pos.body;
    const w = pos.wheels;
    const front = { l: (w[0].l + w[1].l) / 2, r: (w[0].r + w[1].r) / 2 };
    const rear = { l: (w[2].l + w[3].l) / 2, r: (w[2].r + w[3].r) / 2 };

    // Events: backlash clunks, gear changes, diff locks.
    const rise = (key) => {
      const now = b[key] ?? 0;
      const last = this.counters[key];
      this.counters[key] = now;
      return last === undefined || now < last ? 0 : now - last;
    };
    this.strike('clunk', rise('clunks'), body);
    if (this.lastGear !== null && gear !== this.lastGear) this.strike('shift', 1, body);
    this.lastGear = gear;
    const locks = b.locks ?? 0;
    if (this.lastLocks !== null && locks !== this.lastLocks) this.strike('lock', Math.abs(locks - this.lastLocks), body);
    this.lastLocks = locks;

    // Gearbox whine: the gears mesh at engine speed × teeth while the clutch is in; first and the
    // straight-cut reverse whine most. The propshaft turns at engine speed over the gear's ratio.
    const ratio = gear < 0 ? p.reverse : gear > 0 ? p.gears[gear - 1] : 0;
    const engineRev = rpm / 60;
    const inGear = gear !== 0 ? clutch : 0;
    const gw = p.gearWhine;
    const gearF = engineRev * (gear < 0 ? gw.reverseTeeth : gw.teeth);
    const gearAmp = gw.level * inGear * load * (gear < 0 ? gw.reverse : gear === 1 ? gw.first : 1) * Math.min(1, rpm / 2500) * L.gearWhine * level;
    const shaftRev = ratio ? engineRev / ratio : 0;
    const transferF = shaftRev * p.transfer.teeth;
    const transferAmp = p.transfer.level * low * inGear * load * Math.min(1, shaftRev / 8) * L.transfer * level;
    // Axle whine at the rear wheels' speed.
    const rearRoll = (Math.abs(mid('w2roll')) + Math.abs(mid('w3roll'))) / 2;
    const wheelRev = rearRoll / (2 * Math.PI * 0.43);
    const axleF = wheelRev * p.axle.teeth;
    const axleAmp = p.axle.level * smoothstep(p.axle.from, p.axle.full, rearRoll) * load * L.axle * level;

    // CV joints: a click per ball per turn of the front wheels, near full lock with drive on.
    const frontRoll = (Math.abs(mid('w0roll')) + Math.abs(mid('w1roll'))) / 2;
    const frontContact = (mid('w0contact') + mid('w1contact')) / 2;
    const cvRate = (frontRoll / (2 * Math.PI * 0.43)) * p.cv.balls;
    const cvOn = smoothstep(p.cv.from, p.cv.full, Math.abs(steer)) * smoothstep(0.05, 0.6, shaft) * frontContact;

    // Power steering: the pump turns with the engine; steering loads it; full lock groans.
    const steerRate = Math.abs(steer - this.lastSteer) / blockT;
    this.lastSteer = steer;
    const pumpF = engineRev * p.pump.pulley * p.pump.vanes;
    const pumpAmp = (p.pump.level + p.pump.steering * Math.min(1, steerRate / 2)) * Math.min(1, rpm / 700) * L.pump * level;
    const groanAmp = p.pump.groan * smoothstep(0.96, 0.995, Math.abs(steer)) * Math.min(1, rpm / 700) * L.pump * level;

    // Body: rattles when shaken, creaks when twisted; wind with speed squared.
    const heave = mid('heave');
    const rattleP = Math.min(0.2, (p.rattle.perAccel * Math.max(0, heave - p.rattle.from)) / sr);
    const creakAmp = p.creak.level * smoothstep(p.creak.from, p.creak.full, mid('twist')) * L.creak * level;
    const windAmp = p.wind.level * Math.min(1.5, (speed / p.wind.full) ** 2) * L.wind * level;
    this.wind.set(p.wind.f * (0.7 + 0.6 * Math.min(1, speed / p.wind.full)), 0.5, sr);
    const burstDecay = Object.fromEntries(STRUCK.map((k) => [k, Math.exp(-dt / p[k].burst)]));
    const cvAt = front;

    const ph = this.phase;
    const r = this.random;
    for (let j = 0; j < n; j++) {
      const noise = r() * 2 - 1;
      let xb = 0; // at the body
      let xl = 0;
      let xr = 0;

      if (gearAmp > 0) {
        ph.gear = (ph.gear + gearF * dt) % 1;
        xb += gearAmp * (Math.sin(2 * Math.PI * ph.gear) + 0.3 * Math.sin(4 * Math.PI * ph.gear));
      }
      if (transferAmp > 0) {
        ph.transfer = (ph.transfer + transferF * dt) % 1;
        xb += transferAmp * (Math.sin(2 * Math.PI * ph.transfer) + 0.4 * Math.sin(4 * Math.PI * ph.transfer));
      }
      if (axleAmp > 0) {
        ph.axle = (ph.axle + axleF * dt) % 1;
        const s = axleAmp * Math.sin(2 * Math.PI * ph.axle);
        xl += s * rear.l;
        xr += s * rear.r;
      }
      if (cvOn > 0 && cvRate > 0) {
        ph.cv += cvRate * dt;
        if (ph.cv >= 1) {
          ph.cv -= 1;
          this.strike('cv', cvOn * (0.6 + 0.8 * r()), cvAt);
        }
      }
      if (pumpAmp > 0) {
        ph.pump = (ph.pump + pumpF * dt) % 1;
        xb += pumpAmp * Math.sin(2 * Math.PI * ph.pump);
      }
      if (groanAmp > 0) {
        this.groan.tick(noise);
        xb += groanAmp * this.groan.band * 3;
      }
      if (rattleP > 0 && r() < rattleP) {
        // One loose part: rings one mode.
        const bank = this.banks.rattle;
        const m = (r() * bank.modes.length) | 0;
        const spec = p.rattle.modes[m];
        bank.modes[m].set(spec.f * (0.75 + 0.5 * r()), spec.q, sr);
        const amp = p.rattle.level * (0.3 + 0.7 * r()) * L.rattle * level;
        bank.modeKick = m;
        bank.modeKickAmp = amp * 20;
        bank.env = Math.max(bank.env, amp * 1.5);
        bank.pan = body;
      }
      if (creakAmp > 0) {
        this.creakWobble += (r() * 2 - 1) * 0.01;
        this.creakWobble *= 0.998;
        this.creak.tick(noise * (0.5 + Math.abs(this.creakWobble) * 10));
        xb += creakAmp * this.creak.band;
      }
      if (windAmp > 0) {
        this.gust += (r() * 2 - 1 - this.gust) * 0.0002;
        this.wind.tick(noise);
        xb += windAmp * this.wind.band * (1 + p.wind.gust * this.gust * 20);
      }

      // Struck sounds ring where they happened.
      for (let h = 0; h < STRUCK.length; h++) {
        const bank = this.banks[STRUCK[h]];
        if (bank.kick === 0 && bank.modeKick === undefined && bank.env < 1e-5 && !bank.ringing) continue;
        const spec = p[STRUCK[h]];
        const kick = bank.kick * 20;
        bank.kick = 0;
        let ring = 0;
        for (let m = 0; m < bank.modes.length; m++) {
          // All modes for a strike; one mode for a rattle.
          bank.modes[m].tick(kick + (bank.modeKick === m ? bank.modeKickAmp : 0));
          ring += bank.modes[m].band * spec.modes[m].gain;
        }
        const kicked = kick !== 0 || bank.modeKick !== undefined;
        bank.modeKick = undefined;
        bank.burst.tick(bank.env * noise);
        const at = bank.pan ?? body;
        xl += (ring + bank.burst.band) * at.l;
        xr += (ring + bank.burst.band) * at.r;
        bank.env *= burstDecay[STRUCK[h]];
        bank.ringing = Math.abs(ring) > 1e-6 || kicked;
      }

      outL[start + j] += (xb * body.l + xl) * p.gain;
      outR[start + j] += (xb * body.r + xr) * p.gain;
    }
    if (!Number.isFinite(outL[end - 1]) || !Number.isFinite(outR[end - 1])) this.recover(outL, outR, start, end);
  }

  recover(outL, outR, start, end) {
    for (const bank of Object.values(this.banks)) {
      for (const f of [bank.burst, ...bank.modes]) f.ic1 = f.ic2 = 0;
      bank.kick = bank.env = 0;
    }
    for (const f of [this.creak, this.wind, this.groan]) f.ic1 = f.ic2 = 0;
    this.gust = this.creakWobble = 0;
    outL.fill(0, start, end);
    outR.fill(0, start, end);
  }
}
