import { describe, expect, it } from 'vitest';
import { MAX_VOICES, RivalVoices } from '../src/audio/rival-voices.js';

const SR = 48000;
// Renders `seconds` of the voices in 128-sample blocks: the peak and RMS of each side.
function render(voices, seconds) {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  let peak = 0;
  let sumL = 0;
  let sumR = 0;
  let n = 0;
  for (let t = 0; t < seconds * SR; t += 128) {
    left.fill(0);
    right.fill(0);
    voices.render(left, right);
    for (let i = 0; i < 128; i++) {
      expect(Number.isFinite(left[i]) && Number.isFinite(right[i])).toBe(true);
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
      sumL += left[i] ** 2;
      sumR += right[i] ** 2;
      n++;
    }
  }
  return { peak, l: Math.sqrt(sumL / n), r: Math.sqrt(sumR / n) };
}

const car = (id, extra) => ({ id, rpm: 3200, fuel: 0.7, throttle: 0.8, exhaustBrake: 0, l: 1, r: 1, ...extra });

describe('rival engines', () => {
  it('plays each car where it is, and nothing once it is gone', () => {
    const voices = new RivalVoices(SR);
    expect(render(voices, 0.1).peak).toBe(0);
    // A car on the left.
    voices.set([car(1, { l: 1.3, r: 0.2 })]);
    render(voices, 0.3);
    const left = render(voices, 0.5);
    expect(left.l).toBeGreaterThan(0.005);
    expect(left.l).toBeGreaterThan(left.r * 3);
    // It drives off to the right.
    voices.set([car(1, { l: 0.2, r: 1.3 })]);
    render(voices, 0.5);
    const right = render(voices, 0.5);
    expect(right.r).toBeGreaterThan(right.l * 3);
    // No longer heard: it fades out and its voice is freed.
    voices.set([]);
    render(voices, 1);
    expect(voices.voices.size).toBe(0);
    expect(render(voices, 0.1).peak).toBe(0);
  });

  it(`plays at most ${MAX_VOICES} cars, the first (nearest) ones`, () => {
    const voices = new RivalVoices(SR);
    voices.set([1, 2, 3, 4, 5].map((id) => car(id)));
    expect([...voices.voices.keys()]).toEqual([1, 2, 3].slice(0, MAX_VOICES));
    expect(render(voices, 0.3).peak).toBeLessThan(4);
  });

  it('is quieter for a car further away', () => {
    const near = new RivalVoices(SR);
    const far = new RivalVoices(SR);
    near.set([car(1, { l: 1, r: 1 })]);
    far.set([car(1, { l: 0.2, r: 0.2 })]);
    render(near, 0.4);
    render(far, 0.4);
    expect(render(near, 0.5).l).toBeGreaterThan(render(far, 0.5).l * 3);
  });
});
