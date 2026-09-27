import { CONTROLS } from '../controls.js';

// Graphics quality levels. Phones spend most of their GPU time on pixels and the shadow map, and
// the tyre solver shares the GPU queue with drawing, so a lighter frame also speeds up physics.
export const QUALITY_LEVELS = {
  high: { maxPixelRatio: 2, shadowMapSize: 2048 },
  low: { maxPixelRatio: 1.5, shadowMapSize: 1024 },
};

// ?quality=high|low overrides the saved choice. 'auto' is high everywhere for now: on an iPhone,
// low's 1.5x resolution made the thin chassis tubes shimmer and look out of focus.
export function resolveQuality(setting = CONTROLS.graphics) {
  const param = new URLSearchParams(globalThis.location?.search ?? '').get('quality');
  const choice = param in QUALITY_LEVELS ? param : setting;
  return choice in QUALITY_LEVELS ? choice : 'high';
}

// Safe to call at any time: the pixel ratio resizes the canvas and the shadow map is resized
// by the renderer on its next shadow pass.
export function applyQuality(renderer, sun, level = resolveQuality()) {
  const q = QUALITY_LEVELS[level];
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, q.maxPixelRatio));
  sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
  return level;
}
