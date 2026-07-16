/**
 * Lightweight localStorage prefs (last scenario, camera mode).
 */

const KEY = 'glider-sim-prefs-v1';

/**
 * @returns {{ scenarioId?: string, cameraMode?: number }}
 */
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
 * @param {Record<string, unknown>} partial
 */
export function savePrefs(partial) {
  try {
    const next = { ...loadPrefs(), ...partial };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota */
  }
}
