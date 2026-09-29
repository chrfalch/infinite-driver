import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD, WORLDS, worldMode } from '../src/world.js';

describe('world choice', () => {
  it('defaults to the canyon', () => {
    expect(DEFAULT_WORLD).toBe('canyon');
    expect(worldMode('')).toBe('canyon');
  });

  it('lets ?terrain override the saved world', () => {
    expect(worldMode('?terrain=river')).toBe('river');
    expect(worldMode('?terrain=flat')).toBe('flat');
  });

  it('offers the canyon, the dry river and the snowfield', () => {
    expect(Object.values(WORLDS)).toEqual(['canyon', 'river', 'snow']);
  });
});
