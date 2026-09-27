// Settings are saved as only the values that differ from the defaults. A saved full copy would
// freeze every default at the time of saving, so later tuning of the defaults would never reach
// a player who once moved a slider.

// The parts of `value` that differ from `defaults` (nested objects compared key by key).
export function changedFrom(defaults, value) {
  const out = {};
  for (const key of Object.keys(defaults)) {
    const d = defaults[key];
    const v = value[key];
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const inner = changedFrom(d, v ?? {});
      if (Object.keys(inner).length) out[key] = inner;
    } else if (JSON.stringify(d) !== JSON.stringify(v)) {
      out[key] = v;
    }
  }
  return out;
}

export function loadSettings(key) {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(key) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

export function saveSettings(key, defaults, value) {
  try {
    const changed = changedFrom(defaults, value);
    if (Object.keys(changed).length) globalThis.localStorage?.setItem(key, JSON.stringify(changed));
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // Storage can be unavailable (private mode); settings still work for this session.
  }
  for (const listener of listeners) listener(key);
}

// Called after any settings object is saved (the physics worker keeps a copy of all settings).
const listeners = new Set();
export function onSettingsSaved(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
