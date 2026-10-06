import { describe, expect, it } from 'vitest';
import { panelStartsOpen } from '../src/tuning/panel-state.js';

describe('panelStartsOpen', () => {
  it('opens on large screens and folds on small ones when nothing is saved', () => {
    expect(panelStartsOpen(null, false)).toBe(true);
    expect(panelStartsOpen(null, true)).toBe(false);
  });

  it('uses the saved choice on any screen', () => {
    expect(panelStartsOpen(false, false)).toBe(false);
    expect(panelStartsOpen(true, true)).toBe(true);
  });
});
