import { describe, expect, it } from 'vitest';
import { restoreCameraView } from '../src/camera-store.js';

const DEFAULTS = { azimuth: Math.PI / 4, elevation: 0.6, zoom: 1, follow: false, followRelative: 0 };
const LIMITS = { minElevation: 0.2, maxElevation: 1.5, minZoom: 0.4, maxZoom: 4 };

describe('restoreCameraView', () => {
  it('uses the defaults when nothing is saved', () => {
    expect(restoreCameraView(null, DEFAULTS, LIMITS)).toEqual(DEFAULTS);
    expect(restoreCameraView('junk', DEFAULTS, LIMITS)).toEqual(DEFAULTS);
  });

  it('restores a saved view', () => {
    const saved = { azimuth: 2, elevation: 1, zoom: 2.5, follow: true, followRelative: -1.2 };
    expect(restoreCameraView(saved, DEFAULTS, LIMITS)).toEqual(saved);
  });

  it('clamps tilt and zoom, and wraps the angle', () => {
    const view = restoreCameraView({ azimuth: 3 * Math.PI, elevation: 3, zoom: 0.01 }, DEFAULTS, LIMITS);
    expect(view.azimuth).toBeCloseTo(Math.PI);
    expect(view.elevation).toBe(1.5);
    expect(view.zoom).toBe(0.4);
  });

  it('ignores values of the wrong type', () => {
    const view = restoreCameraView({ azimuth: '1', elevation: NaN, zoom: null, follow: 'yes' }, DEFAULTS, LIMITS);
    expect(view).toEqual(DEFAULTS);
  });
});
