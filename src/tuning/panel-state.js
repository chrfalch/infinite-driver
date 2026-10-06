// Whether the tuning panel was last left open or folded, restored on the next visit. Only the root
// panel is remembered; its folders keep their own defaults.
const STORAGE_KEY = 'drift.panel.v1';

// The saved choice wins; with none saved, small screens start folded so the road stays visible.
export function panelStartsOpen(saved, smallScreen) {
  return typeof saved === 'boolean' ? saved : !smallScreen;
}

export function loadPanelOpen() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null');
    return typeof saved === 'boolean' ? saved : null;
  } catch {
    return null;
  }
}

export function savePanelOpen(open) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(open));
  } catch {
    // Storage can be unavailable (private mode); the panel still works for this session.
  }
}
