/**
 * Lightweight localStorage prefs.
 */

const KEY = 'glider-sim-prefs-v1';

/**
 * @typedef {object} Prefs
 * @property {string} [scenarioId]
 * @property {number} [cameraMode]
 * @property {number} [volume] 0..1 master audio
 * @property {'kmh'|'kt'} [units]
 * @property {boolean} [invertPitch]
 */

/** @returns {Prefs} */
export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

/**
 * @param {Partial<Prefs>} partial
 */
export function savePrefs(partial) {
  try {
    const next = { ...loadPrefs(), ...partial };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota */
  }
}

/** @returns {number} 0..1 */
export function getVolume() {
  const v = loadPrefs().volume;
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7;
}

/** @returns {'kmh'|'kt'} */
export function getUnits() {
  return loadPrefs().units === 'kt' ? 'kt' : 'kmh';
}

/** @returns {boolean} */
export function getInvertPitch() {
  return !!loadPrefs().invertPitch;
}
