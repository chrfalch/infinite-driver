// Maths for turning engine recordings into loops (engine-bank.mjs), kept apart for the tests.
//
//   trackPitch  the firing tone over time (YIN, kept continuous from frame to frame)
//   flatten     a stretch of a rev, resampled so its pitch holds still: a steady-rpm recording
//   makeLoop    a whole number of engine cycles, its seam blended so it loops without a click

// YIN's difference function, normalised (de Cheveigné & Kawahara 2002), for lags lo..hi.
function cmnd(x, at, w, lo, hi, out) {
  let sum = 0;
  out[0] = 1;
  for (let tau = 1; tau <= hi; tau++) {
    let d = 0;
    for (let i = 0; i < w; i++) {
      const v = x[at + i] - x[at + i + tau];
      d += v * v;
    }
    sum += d;
    out[tau] = sum > 0 ? (d * tau) / sum : 1;
  }
  return out;
}

// The firing tone's frequency every `hop` s: [{ t, f, clarity }] (clarity 1 = clean, 0 = none).
// minF..maxF bound the search; each frame takes the dip nearest the last frame's pitch among the
// deep ones, so the track does not jump an octave to a half-order of the engine.
export function trackPitch(x, sr, { minF = 40, maxF = 450, hop = 0.01, jump = 0.15 } = {}) {
  const lo = Math.floor(sr / maxF);
  const hi = Math.ceil(sr / minF);
  const w = 2 * hi;
  const d = new Float64Array(hi + 1);
  const track = [];
  let last = 0;
  for (let at = 0; at + w + hi < x.length; at += Math.round(hop * sr)) {
    cmnd(x, at, w, lo, hi, d);
    // Dips: local minima in the lag range.
    let best = -1;
    let bestScore = Infinity;
    let deepest = Infinity;
    for (let tau = lo + 1; tau < hi; tau++) if (d[tau] < deepest) deepest = d[tau];
    for (let tau = lo + 1; tau < hi; tau++) {
      if (!(d[tau] <= d[tau - 1] && d[tau] < d[tau + 1])) continue;
      if (d[tau] > Math.max(0.2, deepest * 1.6 + 0.05)) continue;
      // Near the last pitch, if there was one; else the first deep dip (the shortest period).
      const score = last ? Math.abs(Math.log((sr / tau) / last)) + d[tau] : tau;
      if (score < bestScore) {
        bestScore = score;
        best = tau;
      }
    }
    const t = (at + w / 2) / sr;
    if (best < 0) {
      track.push({ t, f: last, clarity: 0 });
      continue;
    }
    // Parabolic interpolation of the dip.
    const a = d[best - 1];
    const b = d[best];
    const c = d[best + 1];
    const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
    const f = sr / (best + shift);
    // A jump bigger than `jump` (a share) from the last frame is a mistrack: keep the last.
    if (last && Math.abs(Math.log(f / last)) > jump) track.push({ t, f: last, clarity: 0 });
    else {
      track.push({ t, f, clarity: Math.max(0, 1 - b) });
      last = f;
    }
  }
  return track;
}

// The track's frequency at time t (linear between frames).
export function pitchAt(track, t) {
  if (t <= track[0].t) return track[0].f;
  if (t >= track[track.length - 1].t) return track[track.length - 1].f;
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const u = (t - track[lo].t) / (track[hi].t - track[lo].t);
  return track[lo].f + (track[hi].f - track[lo].f) * u;
}

// Cubic (Hermite) read of x at fractional index p.
function readAt(x, p) {
  const i = Math.floor(p);
  const f = p - i;
  const g = (k) => x[Math.min(x.length - 1, Math.max(0, k))];
  const xm1 = g(i - 1);
  const x0 = g(i);
  const x1 = g(i + 1);
  const x2 = g(i + 2);
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

// `seconds` of output at the steady pitch `target`, read from x starting at t0 so that every
// firing of the recording lands where a firing at `target` would: the recording's phase (the
// integral of its pitch) is followed at the target's pace. A rev held still at one rpm.
export function flatten(x, sr, track, t0, target, seconds) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  let t = t0; // input time
  for (let k = 0; k < n; k++) {
    out[k] = readAt(x, t * sr);
    // The input advances by as much of its own cycle as one output sample covers of the target's.
    t += target / pitchAt(track, t) / sr;
    if (t * sr >= x.length - 2) return out.subarray(0, k + 1);
  }
  return out;
}

// A loop of `cycles` engine cycles (one cycle = `perCycle` firings) from a steady-pitch stretch at
// `f` Hz: the tail after the loop is blended into its start over `fade` s (equal power), so its
// end runs into its beginning without a step.
export function makeLoop(x, sr, f, { perCycle = 4, cycles = 8, fade = 0.04 } = {}) {
  const cycleLen = (perCycle * sr) / f;
  const fadeLen = Math.min(Math.round(fade * sr), Math.floor(x.length / 3));
  const fit = Math.max(1, Math.min(cycles, Math.floor((x.length - fadeLen) / cycleLen)));
  const len = Math.round(fit * cycleLen);
  const out = Float32Array.from(x.subarray(0, len));
  for (let i = 0; i < fadeLen; i++) {
    const u = (i / fadeLen) * (Math.PI / 2);
    out[i] = x[i] * Math.sin(u) + x[len + i] * Math.cos(u);
  }
  return out;
}

export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}
