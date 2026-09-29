// Stereo helpers for the sound's parts (see audio.js for where the listener is).

// Gains { l, r } for a pan from -1 (left) to 1 (right), equal power, 1 each in the middle (so a
// centred part is as loud as it was in mono).
export function panGains(pan, gain = 1, out = { l: 1, r: 1 }) {
  const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  out.l = Math.cos(a) * Math.SQRT2 * gain;
  out.r = Math.sin(a) * Math.SQRT2 * gain;
  return out;
}

export const CENTER = Object.freeze({ l: 1, r: 1 });

// Where the car's parts are heard: the exhaust and engine, the body, each wheel ({ l, r } gains).
export const CENTERED = Object.freeze({ exhaust: CENTER, engine: CENTER, body: CENTER, wheels: [CENTER, CENTER, CENTER, CENTER] });

// The sum of all parts, kept inside full scale by a soft knee that leaves anything below it alone.
const KNEE = 0.85;
export function softKnee(x) {
  const m = Math.abs(x);
  return m < KNEE ? x : Math.sign(x) * (KNEE + (1 - KNEE) * Math.tanh((m - KNEE) / (1 - KNEE)));
}
