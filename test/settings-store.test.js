import { describe, expect, it } from 'vitest';
import { changedFrom } from '../src/settings-store.js';

describe('changedFrom', () => {
  it('keeps only values that differ from the defaults', () => {
    const defaults = { a: 1, b: true, c: { x: 1, y: 2 }, gears: [3, 2, 1] };
    expect(changedFrom(defaults, { a: 1, b: true, c: { x: 1, y: 2 }, gears: [3, 2, 1] })).toEqual({});
    expect(changedFrom(defaults, { a: 2, b: true, c: { x: 1, y: 5 }, gears: [3, 2, 1] })).toEqual({ a: 2, c: { y: 5 } });
    expect(changedFrom(defaults, { a: 1, b: false, c: { x: 1, y: 2 }, gears: [4, 2, 1] })).toEqual({ b: false, gears: [4, 2, 1] });
  });
});
