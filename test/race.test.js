import { describe, expect, it } from 'vitest';
import { COUNTDOWN, GO_SHOWN, LEAD_IN, createRace } from '../src/systems/race.js';

// Runs the race's clock for `seconds` in 1/60 s frames.
const run = (race, seconds) => {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) race.update(1 / 60);
};

describe('race start and pause', () => {
  it('holds the cars until start(), then counts 3-2-1 and lets them go', () => {
    const race = createRace();
    run(race, 5);
    expect(race.phase).toBe('waiting');
    expect(race.held()).toBe(true);
    expect(race.label()).toBe(null);
    race.start();
    run(race, LEAD_IN / 2);
    expect(race.label()).toBe(null);
    const labels = [];
    for (let k = 0; k < (LEAD_IN + COUNTDOWN + GO_SHOWN + 1) * 60; k++) {
      race.update(1 / 60);
      const label = race.label();
      if (label !== labels.at(-1)) labels.push(label);
      if (label === '3' || label === '2' || label === '1') expect(race.held()).toBe(true);
      if (label === 'GO!') expect(race.held()).toBe(false);
    }
    expect(labels.filter(Boolean)).toEqual(['3', '2', '1', 'GO!']);
    expect(race.phase).toBe('racing');
    expect(race.label()).toBe(null);
  });

  it('stops the countdown while paused', () => {
    const race = createRace();
    race.start();
    run(race, LEAD_IN + 0.5);
    expect(race.label()).toBe('3');
    race.togglePause();
    run(race, 10);
    expect(race.label()).toBe('3');
    expect(race.held()).toBe(true);
    race.togglePause();
    run(race, 1);
    expect(race.label()).toBe('2');
  });

  it('races at once without a countdown, and still pauses', () => {
    const race = createRace({ countdown: false });
    expect(race.held()).toBe(false);
    expect(race.label()).toBe(null);
    race.start();
    run(race, 1);
    expect(race.label()).toBe(null);
    race.setPaused(true);
    expect(race.paused).toBe(true);
  });
});
