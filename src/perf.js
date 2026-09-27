// Lightweight profiler, enabled with ?perf (shows an overlay; scripts read window.__perf). Samples are kept in fixed ring buffers; summary() gives avg / p50 / p95 / max.
const SIZE = 600;
const params = new URLSearchParams(globalThis.location?.search ?? '');
export const PERF_ON = params.has('perf');

class Series {
  constructor() {
    this.data = new Float64Array(SIZE);
    this.n = 0;
    this.total = 0;
    this.count = 0;
  }
  add(v) {
    this.data[this.n % SIZE] = v;
    this.n++;
    this.total += v;
    this.count++;
  }
  stats() {
    const len = Math.min(this.n, SIZE);
    if (!len) return null;
    const a = Array.from(this.data.subarray(0, len)).sort((x, y) => x - y);
    const sum = a.reduce((s, x) => s + x, 0);
    return { avg: sum / len, p50: a[Math.floor(len * 0.5)], p95: a[Math.floor(len * 0.95)], max: a[len - 1], n: this.count };
  }
}

const series = new Map();
export function sample(name, v) {
  if (!PERF_ON) return;
  let s = series.get(name);
  if (!s) series.set(name, (s = new Series()));
  s.add(v);
}
export function timed(name, fn) {
  if (!PERF_ON) return fn();
  const t0 = performance.now();
  const r = fn();
  sample(name, performance.now() - t0);
  return r;
}
const counters = {};
export function count(name, v = 1) {
  if (PERF_ON) counters[name] = (counters[name] ?? 0) + v;
}

export function summary() {
  const out = {};
  for (const [k, s] of series) out[k] = s.stats();
  return { series: out, counters: { ...counters } };
}
export function reset() {
  series.clear();
  for (const k of Object.keys(counters)) delete counters[k];
}

function fmt(s) {
  if (!s) return '-';
  return `${s.avg.toFixed(2)} / ${s.p95.toFixed(2)} / ${s.max.toFixed(1)}`;
}

const KEY_LINES = ['step.total', 'step.gpuWait', 'step.rapier', 'batch.ms', 'batch.steps', 'frame.interval', 'frame.js', 'draw', 'sys.updateTracks', 'tracks.segM', 'speed.kmh', 'car.motionErrCm'];

export function startOverlay() {
  if (!PERF_ON) return;
  window.__perf = { summary, reset };
  // Top of the screen, clear of the touch buttons. Tap: compact / full. The "reset" label resets.
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:4px;top:calc(env(safe-area-inset-top) + 90px);z-index:99;padding:5px 7px;font:10px/1.25 ui-monospace,monospace;background:rgba(0,0,0,.7);color:#e8e2d0;border-radius:6px;max-width:70vw;white-space:pre;-webkit-user-select:none;user-select:none';
  const text = document.createElement('div');
  const resetBtn = document.createElement('div');
  resetBtn.textContent = '[ reset ]';
  resetBtn.style.cssText = 'margin-top:4px;color:#f0b070';
  el.append(text, resetBtn);
  document.body.append(el);
  let full = false;
  text.addEventListener('click', () => (full = !full));
  resetBtn.addEventListener('click', () => reset());
  setInterval(() => {
    const { series: s, counters: c } = summary();
    const lines = [full ? 'avg / p95 / max ms  (tap: compact)' : 'avg / p95 / max  (tap: all)'];
    const keys = full ? Object.keys(s).sort() : KEY_LINES.filter((k) => s[k]);
    for (const k of keys) lines.push(`${k.padEnd(full ? 18 : 16)} ${fmt(s[k])}`);
    const simT = c.simSeconds ?? 0;
    const wallT = c.wallSeconds ?? 0;
    lines.push(`sim/real ${(wallT ? simT / wallT : 0).toFixed(2)}  dropped ${(c.droppedSeconds ?? 0).toFixed(2)}s  ${wallT.toFixed(0)}s`);
    lines.push(`track breaks: no contact ${c['tracks.breakNoContact'] ?? 0}  gap ${c['tracks.breakGap'] ?? 0}`);
    text.textContent = lines.join('\n');
  }, 500);
}
