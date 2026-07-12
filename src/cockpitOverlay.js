/**
 * Animate 2D cockpit stick + airbrake/gear levers from control state.
 */

let stick = null;
let stickShaft = null;
let stickGrip = null;
let brakeArm = null;
let gearArm = null;
let ready = false;

const smooth = { pitch: 0, roll: 0, yaw: 0, brakes: 0, gear: 1 };

function bind() {
  stick = document.getElementById('cockpit-stick');
  stickShaft = document.getElementById('cockpit-stick-shaft');
  stickGrip = document.getElementById('cockpit-stick-grip');
  brakeArm = document.getElementById('cockpit-brake-arm');
  gearArm = document.getElementById('cockpit-gear-arm');
  ready = !!(stick && brakeArm && gearArm);
  return ready;
}

export function initCockpitOverlay() {
  if (!bind()) {
    // DOM may not be ready
    requestAnimationFrame(() => bind());
  }
}

/**
 * @param {{ pitch: number, roll: number, yaw: number, brakes: number, gear: number }} ctrl
 * @param {number} dt
 */
export function updateCockpitOverlay(ctrl, dt = 0.016) {
  if (!ready && !bind()) return;

  const lag = 1 - Math.exp(-12 * Math.max(0.001, dt));
  smooth.pitch += ((ctrl.pitch || 0) - smooth.pitch) * lag;
  smooth.roll += ((ctrl.roll || 0) - smooth.roll) * lag;
  smooth.yaw += ((ctrl.yaw || 0) - smooth.yaw) * lag;
  smooth.brakes += ((ctrl.brakes || 0) - smooth.brakes) * lag;
  const gTarget = ctrl.gear !== undefined ? ctrl.gear : 1;
  smooth.gear += (gTarget - smooth.gear) * (1 - Math.exp(-5 * Math.max(0.001, dt)));

  // Stick: roll = tilt, pitch = fore/aft (pull / nose-up → grip toward pilot = +y in SVG)
  const rollDeg = smooth.roll * 24;
  const pitchPx = smooth.pitch * 18;
  if (stick) {
    stick.setAttribute('transform', `rotate(${rollDeg}) translate(0 ${pitchPx})`);
  }
  if (stickShaft) {
    stickShaft.setAttribute('y2', String(-(58 + smooth.pitch * 8)));
  }
  if (stickGrip) {
    stickGrip.setAttribute('y', String(-72 + smooth.pitch * 16));
  }

  // Airbrake: 0 stowed → 1 full out
  if (brakeArm) {
    brakeArm.setAttribute('transform', `rotate(${-14 - smooth.brakes * 58})`);
  }

  // Gear: 1 down → 0 up
  if (gearArm) {
    gearArm.setAttribute('transform', `rotate(${-14 - (1 - smooth.gear) * 56})`);
  }
}
