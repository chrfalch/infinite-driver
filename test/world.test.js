import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD, WORLDS, chosenWorld, switchWorld, worldMode } from '../src/world.js';

const storage = () => {
  const store = new Map();
  return { store, getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
};

describe('world choice', () => {
  it('defaults to the canyon', () => {
    expect(DEFAULT_WORLD).toBe('canyon');
    expect(worldMode('')).toBe('canyon');
  });

  it('lets ?terrain override the saved world', () => {
    expect(worldMode('?terrain=river')).toBe('river');
    expect(worldMode('?terrain=flat')).toBe('flat');
  });

  it('offers the canyon, the dry river, the snowfield and the sunny town', () => {
    expect(Object.values(WORLDS)).toEqual(['canyon', 'river', 'snow', 'daytown']);
  });
});

describe('switching worlds', () => {
  it('saves the pick and drops ?terrain, keeping the other parameters', () => {
    globalThis.localStorage = storage();
    globalThis.sessionStorage = storage();
    try {
      expect(switchWorld('snow', 'https://drift.example/?terrain=river&sound=0')).toBe('https://drift.example/?sound=0');
      expect(worldMode('')).toBe('snow');
      switchWorld('canyon', 'https://drift.example/');
      expect(globalThis.localStorage.store.has('drift.world')).toBe(false);
    } finally {
      delete globalThis.localStorage;
      delete globalThis.sessionStorage;
    }
  });

  it('puts the pick in the URL without session storage', () => {
    expect(switchWorld('snow', 'https://drift.example/?sound=0')).toBe('https://drift.example/?sound=0&terrain=snow');
  });
});

describe('asking for a world', () => {
  it('asks on a plain load, with the last world as the hint', () => {
    globalThis.localStorage = storage();
    globalThis.sessionStorage = storage();
    try {
      switchWorld('daytown', 'https://drift.example/');
      globalThis.sessionStorage.store.clear();
      expect(chosenWorld('')).toBe(null);
      expect(worldMode('')).toBe('daytown');
    } finally {
      delete globalThis.localStorage;
      delete globalThis.sessionStorage;
    }
  });

  it('takes ?terrain as chosen', () => {
    expect(chosenWorld('?terrain=flat')).toBe('flat');
  });

  it('loads a pick that reloaded into it once, then asks again', () => {
    globalThis.localStorage = storage();
    globalThis.sessionStorage = storage();
    try {
      switchWorld('river', 'https://drift.example/');
      expect(worldMode('')).toBe('river');
      expect(chosenWorld('')).toBe('river');
      expect(chosenWorld('')).toBe(null);
    } finally {
      delete globalThis.localStorage;
      delete globalThis.sessionStorage;
    }
  });
});
