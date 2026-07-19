/** Keyboard / control state — natural arcade mapping */

import { getInvertPitch } from './prefs.js';

const keys = Object.create(null);

/** Runtime override (prefs UI); null = read from storage each frame */
let invertPitchOverride = null;

export function setInvertPitch(on) {
  invertPitchOverride = !!on;
}

export const controls = {
  // pitch: +1 = nose UP, -1 = nose DOWN
  pitch: 0,
  // roll:  +1 = bank RIGHT (D), -1 = bank LEFT (A)
  roll: 0,
  // yaw:   +1 = yaw RIGHT (E), -1 = yaw LEFT (Q)
  yaw: 0,
  brakes: 0,
  /** 1 = gear down, 0 = gear up */
  gear: 1,
  cameraToggle: false,
  restart: false,
  /** Return to scenario menu (edge) */
  menu: false,
  gearToggle: false,
  /** Toggle Tron neon mode (edge) */
  tronToggle: false,
  /** XR physical grab flags — skip smoothed stick/lever visuals */
  xrStickGrab: false,
  xrBrakeGrab: false,
  xrGearGrab: false,
  xrReleaseGrab: false,
  /**
   * Cockpit look pad 1–9 (sticky). Layout:
   *  7 left-up   8 up    9 right-up
   *  4 left      5 fwd   6 right
   *  1 left-down 2 down  3 right-down
   */
  lookDir: 5,
};

const map = {
  // Reversed pitch: W/Up = nose down, S/Down = nose up
  KeyW: 'pitchDown', ArrowUp: 'pitchDown',
  KeyS: 'pitchUp', ArrowDown: 'pitchUp',
  KeyA: 'rollLeft', ArrowLeft: 'rollLeft',
  KeyD: 'rollRight', ArrowRight: 'rollRight',
  KeyQ: 'yawL',
  KeyE: 'yawR',
  Space: 'brakes',
  KeyC: 'camera',
  KeyR: 'restart',
  KeyM: 'menu',
  KeyG: 'gear',
  KeyT: 'tron',
};

/** Digit / numpad → look direction 1–9 */
const lookKeyMap = {
  Digit1: 1, Digit2: 2, Digit3: 3,
  Digit4: 4, Digit5: 5, Digit6: 6,
  Digit7: 7, Digit8: 8, Digit9: 9,
  Numpad1: 1, Numpad2: 2, Numpad3: 3,
  Numpad4: 4, Numpad5: 5, Numpad6: 6,
  Numpad7: 7, Numpad8: 8, Numpad9: 9,
};

export function initInput() {
  window.addEventListener('keydown', (e) => {
    if (e.code in map) {
      keys[map[e.code]] = true;
      e.preventDefault();
      return;
    }
    if (e.code in lookKeyMap && !e.repeat) {
      controls.lookDir = lookKeyMap[e.code];
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code in map) {
      keys[map[e.code]] = false;
      e.preventDefault();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') e.preventDefault();
  }, { passive: false });
}

let camLatched = false;
let restartLatched = false;
let menuLatched = false;
let gearLatched = false;
let tronLatched = false;

export function updateInput() {
  // Default: W/↑ = nose down, S/↓ = nose up (aircraft-style push stick)
  let pitch = (keys.pitchUp ? 1 : 0) - (keys.pitchDown ? 1 : 0);
  const invert =
    invertPitchOverride != null ? invertPitchOverride : getInvertPitch();
  if (invert) pitch = -pitch;
  controls.pitch = pitch;
  // A = bank left (-), D = bank right (+)
  controls.roll = (keys.rollRight ? 1 : 0) - (keys.rollLeft ? 1 : 0);
  // Q = yaw left (-), E = yaw right (+)
  controls.yaw = (keys.yawR ? 1 : 0) - (keys.yawL ? 1 : 0);
  controls.brakes = keys.brakes ? 1 : 0;

  if (keys.camera && !camLatched) {
    controls.cameraToggle = true;
    camLatched = true;
  } else {
    controls.cameraToggle = false;
    if (!keys.camera) camLatched = false;
  }

  if (keys.restart && !restartLatched) {
    controls.restart = true;
    restartLatched = true;
  } else {
    controls.restart = false;
    if (!keys.restart) restartLatched = false;
  }

  // M → scenario menu (always edge-triggered)
  if (keys.menu && !menuLatched) {
    controls.menu = true;
    menuLatched = true;
  } else {
    controls.menu = false;
    if (!keys.menu) menuLatched = false;
  }

  // G toggles gear up / down
  if (keys.gear && !gearLatched) {
    controls.gear = controls.gear > 0.5 ? 0 : 1;
    controls.gearToggle = true;
    gearLatched = true;
  } else {
    controls.gearToggle = false;
    if (!keys.gear) gearLatched = false;
  }

  // T toggles Tron neon mode
  if (keys.tron && !tronLatched) {
    controls.tronToggle = true;
    tronLatched = true;
  } else {
    controls.tronToggle = false;
    if (!keys.tron) tronLatched = false;
  }
}

/** Reset look to forward (e.g. on new flight). */
export function resetLook() {
  controls.lookDir = 5;
}
