// Maths for turning engine recordings into loops (engine-bank.mjs), kept apart for the tests.
//
//   trackOrders an engine's speed over time from its orders: the comb of harmonics of the cycle
//               (two crank turns) that every four-stroke's spectrum is (best on real recordings)
//   trackPitch  the firing tone over time (YIN, kept continuous from frame to frame; clean tones)
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

// In-place radix-2 FFT (re, im of length 2^k).
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    const wr = Math.cos(a);
    const wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// An engine's speed over time from its orders: [{ t, f, clarity }] with f the firing tone (rpm / 60
// × cylinders / 2), as trackPitch. A four-stroke's sound repeats every cycle (two turns), so its
// spectrum is a comb of lines at multiples of rpm / 120: each frame scores every candidate speed by
// the comb's lines against the gaps halfway between them (half the speed would land on lines and
// gaps alike, double the speed on only every other line), then the best path through the frames is
// found (Viterbi) with a cost for every change of speed, so it follows a rev and ignores a frame
// of noise. A whine at a fixed pitch (a dyno's) sits on few lines of any comb and barely counts.
export function trackOrders(x, sr, { minRpm = 500, maxRpm = 7500, cylinders = 8, hop = 0.02, window = 0.5, maxHz = 1500, step = 0.004, change = 25 } = {}) {
  let size = 1;
  while (size < window * sr) size <<= 1;
  const pad = size * 4;
  const bin = sr / pad;
  const hopN = Math.round(hop * sr);
  const win = new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const cands = [];
  for (let rpm = minRpm; rpm <= maxRpm; rpm *= 1 + step) cands.push(rpm);
  const frames = [];
  const re = new Float64Array(pad);
  const im = new Float64Array(pad);
  const mag = new Float64Array(pad / 2);
  for (let at = 0; at + size <= x.length; at += hopN) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < size; i++) re[i] = x[at + i] * win[i];
    fft(re, im);
    // Log magnitude, so a few loud lines do not outweigh the comb.
    for (let k = 0; k < pad / 2; k++) mag[k] = Math.log(1e-9 + Math.hypot(re[k], im[k]));
    const lineAt = (hz) => {
      const p = hz / bin;
      const k = Math.round(p);
      // The peak within a bin either side (the comb is not exact to a bin).
      return Math.max(mag[k - 1] ?? -20, mag[k], mag[k + 1] ?? -20);
    };
    const scores = new Float64Array(cands.length);
    for (let c = 0; c < cands.length; c++) {
      const fc = cands[c] / 120;
      let lines = 0;
      let gaps = 0;
      let count = 0;
      for (let h = 1; h * fc < maxHz && h * fc < sr / 2 - 2 * fc; h++) {
        lines += lineAt(h * fc);
        gaps += lineAt((h + 0.5) * fc);
        count++;
      }
      scores[c] = count ? (lines - gaps) / count : 0;
    }
    frames.push({ t: (at + size / 2) / sr, scores });
  }
  if (!frames.length) return [];
  // Viterbi: the path that scores most, less `change` per unit of log speed changed.
  const n = cands.length;
  const reach = Math.ceil(Math.log(1 + 3 * hop) / Math.log(1 + step)); // at most ×(1 + 3 hop) per frame
  let prev = Float64Array.from(frames[0].scores);
  const back = [];
  for (let i = 1; i < frames.length; i++) {
    const cur = new Float64Array(n);
    const from = new Int32Array(n);
    for (let c = 0; c < n; c++) {
      let best = -Infinity;
      let arg = c;
      for (let d = Math.max(0, c - reach); d <= Math.min(n - 1, c + reach); d++) {
        const v = prev[d] - Math.abs(d - c) * Math.log(1 + step) * change;
        if (v > best) {
          best = v;
          arg = d;
        }
      }
      cur[c] = best + frames[i].scores[c];
      from[c] = arg;
    }
    back.push(from);
    prev = cur;
  }
  let c = 0;
  for (let k = 1; k < n; k++) if (prev[k] > prev[c]) c = k;
  const path = new Int32Array(frames.length);
  path[frames.length - 1] = c;
  for (let i = frames.length - 2; i >= 0; i--) path[i] = c = back[i][c];
  return frames.map((fr, i) => {
    const s = fr.scores;
    let max = -Infinity;
    let mean = 0;
    for (let k = 0; k < n; k++) {
      max = Math.max(max, s[k]);
      mean += s[k] / n;
    }
    const k = path[i];
    // Clarity: how far the chosen speed's comb stands above the average candidate's (0..1).
    const clarity = Math.max(0, Math.min(1, (s[k] - mean) / 1.5));
    return { t: fr.t, f: (cands[k] * cylinders) / 120, clarity, rpm: cands[k], best: max === s[k] };
  });
}
