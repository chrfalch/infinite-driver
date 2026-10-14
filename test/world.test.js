import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD, WORLDS, switchWorld, worldMode } from '../src/world.js';

describe('world choice', () => {
  it('defaults to the canyon', () => {
    expect(DEFAULT_WORLD).toBe('canyon');
    expect(worldMode('')).toBe('canyon');
  });

  it('lets ?terrain override the saved world', () => {
    expect(worldMode('?terrain=river')).toBe('river');
    expect(worldMode('?terrain=flat')).toBe('flat');
  });

  it('offers the canyon, the dry river, the snowfield and the dark and sunny towns', () => {
    expect(Object.values(WORLDS)).toEqual(['canyon', 'river', 'snow', 'town', 'daytown']);
  });
});

describe('switching worlds', () => {
  it('saves the pick and drops ?terrain, keeping the other parameters', () => {
    const store = new Map();
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    try {
      expect(switchWorld('snow', 'https://drift.example/?terrain=river&sound=0')).toBe('https://drift.example/?sound=0');
      expect(worldMode('')).toBe('snow');
      switchWorld('canyon', 'https://drift.example/');
      expect(store.has('drift.world')).toBe(false);
    } finally {
      delete globalThis.localStorage;
    }
  });
});
