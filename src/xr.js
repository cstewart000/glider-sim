/**
 * WebXR session + Quest cockpit interaction.
 *
 * Primary flight: grab the stick (squeeze/trigger near grip)
 *   - Hand offset → proportional pitch / roll
 *   - Twist controller around stick shaft → yaw
 * Levers: airbrake, gear, tow/cable release (grab + move)
 * Fallback: thumbsticks when not grabbing
 *
 * World-space VR menu for scenario pick + launch when not flying.
 */

import * as THREE from 'three';
import { controls } from './input.js';

/** @type {boolean} */
export let xrPresenting = false;

let renderer = null;
let xrRig = null;
let camera = null;
let scene = null;
/** @type {THREE.Object3D|null} */
let gliderRef = null;

/** Controllers + grips */
const hands = [
  {
    ctrl: null,
    grip: null,
    ray: null,
    highlight: null,
    squeezeHeld: false,
    selectHeld: false,
    grabbing: null,
  },
  {
    ctrl: null,
    grip: null,
    ray: null,
    highlight: null,
    squeezeHeld: false,
    selectHeld: false,
    grabbing: null,
  },
];

// Grab state shared for stick twist baseline
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _local = new THREE.Vector3();

/** Hand offset (m) for full pitch / roll on physical stick */
const STICK_THROW = 0.1;
/** Max twist rad for full rudder */
const STICK_TWIST_MAX = 0.7; // ~40°
/** Soft response curve exponent (1 = linear, >1 gentler near center) */
const STICK_CURVE = 1.12;
/** Lever travel for full airbrake / gear (m along swing) */
const LEVER_THROW = 0.14;
/** Smoothing rate for grabbed stick (1/s) — kills grip tracking jitter */
const STICK_SMOOTH = 14;

let gearLatched = false;
let releaseLatched = false;
let camLatched = false;
let menuBtnLatched = false;

/** @type {null | { type: string, hand: number, pivotWorld: THREE.Vector3, grabLocal: THREE.Vector3, twist0: number, startGear: number, startBrake: number }} */
let activeGrab = null;

// —— VR menu ——
let menuGroup = null;
let menuVisible = false;
/** @type {{ mesh: THREE.Mesh, action: string, id?: string }[]} */
let menuButtons = [];
/** @type {((id: string) => void) | null} */
let onMenuSelect = null;
/** @type {(() => void) | null} */
let onMenuLaunch = null;
/** @type {(() => void) | null} */
let onMenuExit = null;
/** @type {{ id: string, name: string }[]} */
let menuScenarios = [];
let menuActiveId = '';
let menuFlying = false;
let selectLatched = [false, false];

/**
 * @param {object} opts
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {HTMLElement} [opts.buttonHost]
 * @param {THREE.Object3D} [opts.glider]
 * @param {{ id: string, name: string }[]} [opts.scenarios]
 * @param {string} [opts.activeScenarioId]
 * @param {(id: string) => void} [opts.onSelectScenario]
 * @param {() => void} [opts.onLaunch]
 * @param {() => void} [opts.onExitToMenu]
 */
export function initXR({
  renderer: r,
  scene: s,
  camera: cam,
  buttonHost,
  glider,
  scenarios = [],
  activeScenarioId = '',
  onSelectScenario,
  onLaunch,
  onExitToMenu,
}) {
  renderer = r;
  scene = s;
  camera = cam;
  gliderRef = glider || null;
  menuScenarios = scenarios;
  menuActiveId = activeScenarioId;
  onMenuSelect = onSelectScenario || null;
  onMenuLaunch = onLaunch || null;
  onMenuExit = onExitToMenu || null;

  renderer.xr.enabled = true;
  try {
    renderer.xr.setReferenceSpaceType('local');
  } catch {
    /* older three */
  }

  xrRig = new THREE.Group();
  xrRig.name = 'xrRig';
  xrRig.visible = false;
  scene.add(xrRig);

  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    const ray = makePointerMesh();
    ctrl.add(ray);
    xrRig.add(ctrl);

    const grip = renderer.xr.getControllerGrip(i);
    grip.add(makeGripMesh());
    // Hover highlight sphere on grip
    const hl = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0x60d0e8,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
    );
    grip.add(hl);
    xrRig.add(grip);

    hands[i].ctrl = ctrl;
    hands[i].grip = grip;
    hands[i].ray = ray;
    hands[i].highlight = hl;

    // Squeeze / trigger grab (hold either)
    ctrl.addEventListener('squeezestart', () => {
      hands[i].squeezeHeld = true;
      if (!menuVisible) tryGrab(i);
    });
    ctrl.addEventListener('squeezeend', () => {
      hands[i].squeezeHeld = false;
      if (!hands[i].selectHeld) releaseGrab(i);
    });
    ctrl.addEventListener('selectstart', () => {
      hands[i].selectHeld = true;
      if (menuVisible) tryMenuSelect(i);
      else tryGrab(i);
    });
    ctrl.addEventListener('selectend', () => {
      hands[i].selectHeld = false;
      if (!hands[i].squeezeHeld) releaseGrab(i);
    });
  }

  buildVRMenu();

  const btn = createVRButton(renderer);
  if (buttonHost) buttonHost.appendChild(btn);
  else document.body.appendChild(btn);

  renderer.xr.addEventListener('sessionstart', () => {
    xrPresenting = true;
    xrRig.visible = true;
    if (camera.parent !== xrRig) xrRig.add(camera);
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    camera.near = 0.04;
    camera.far = 3500;
    // Camera sees world (0) + UI layer (2)
    camera.layers.enable(0);
    camera.layers.enable(2);
    camera.updateProjectionMatrix();
    document.documentElement.classList.add('xr-active');
    // Show menu if not in flight
    setVRMenuVisible(!menuFlying);
  });

  renderer.xr.addEventListener('sessionend', () => {
    xrPresenting = false;
    xrRig.visible = false;
    if (camera.parent === xrRig) scene.add(camera);
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    camera.rotation.set(0, 0, 0);
    camera.layers.set(0);
    document.documentElement.classList.remove('xr-active');
    clearXRAxes();
    releaseGrab(0);
    releaseGrab(1);
    setVRMenuVisible(false);
  });

  return { xrRig, button: btn };
}

/** Keep glider reference up to date (after mesh recreate). */
export function setXRGlider(glider) {
  gliderRef = glider;
}

export function setXRMenuScenarios(list, activeId) {
  menuScenarios = list || [];
  menuActiveId = activeId || '';
  // Only refresh if menu is open (avoid thrashing mid-click)
  if (menuVisible) rebuildMenuButtons();
}

export function setXRFlying(flying) {
  menuFlying = !!flying;
  if (xrPresenting) setVRMenuVisible(!flying);
}

/** True while the world-space VR menu is showing (title / pause). */
export function isVRMenuVisible() {
  return menuVisible && xrPresenting;
}

function makePointerMesh() {
  const g = new THREE.Group();
  g.name = 'xrRay';
  const line = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0025, 0.0025, 0.55, 4),
    new THREE.MeshBasicMaterial({ color: 0x88c8d8, transparent: true, opacity: 0.45 })
  );
  line.rotation.x = -Math.PI / 2;
  line.position.z = -0.28;
  g.add(line);
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.01, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0xc8eef8 })
  );
  tip.position.z = -0.55;
  g.add(tip);
  return g;
}

function makeGripMesh() {
  return new THREE.Mesh(
    new THREE.BoxGeometry(0.035, 0.035, 0.07),
    new THREE.MeshBasicMaterial({ color: 0xb0b0b8, transparent: true, opacity: 0.65 })
  );
}

/**
 * Place XR origin at cockpit eye, oriented with the glider.
 */
export function updateXRRig(eyePos, gliderQuat) {
  if (!xrPresenting || !xrRig) return;
  xrRig.position.copy(eyePos);
  xrRig.quaternion.copy(gliderQuat);
}

/**
 * Main XR input + grab update (call after keyboard updateInput).
 * @param {number} [dt]
 */
export function updateXRControls(dt = 0.016) {
  if (!xrPresenting || !renderer) return;
  const session = renderer.xr.getSession();
  if (!session) return;

  // Reset grab flags each frame (re-set while holding)
  controls.xrStickGrab = false;
  controls.xrBrakeGrab = false;
  controls.xrGearGrab = false;
  controls.xrReleaseGrab = false;

  // Hover highlights + continuous grab drive
  for (let i = 0; i < 2; i++) {
    updateHandHover(i);
    if (hands[i].grabbing) driveGrab(i, dt);
  }

  // Fallback thumbsticks when not grabbing stick
  if (!controls.xrStickGrab) {
    applyThumbstickFallback(session);
  } else {
    // Still allow camera / menu buttons from gamepads
    applyButtonEdges(session);
  }

  // Menu ray hover tint
  if (menuVisible) updateMenuHover();
}

function getGrabbables() {
  const cockpit =
    gliderRef?.userData?.cockpit || gliderRef?.getObjectByName?.('cockpitInterior');
  return cockpit?.userData?.grabbables || [];
}

function gripWorldPos(handIndex, out = _v) {
  const grip = hands[handIndex].grip;
  if (!grip) return out.set(0, 0, 0);
  grip.getWorldPosition(out);
  return out;
}

function findNearestGrabbable(handIndex) {
  const gp = gripWorldPos(handIndex, _v);
  let best = null;
  let bestD = Infinity;
  for (const g of getGrabbables()) {
    if (!g.grab) continue;
    g.grab.getWorldPosition(_v2);
    const d = gp.distanceTo(_v2);
    if (d < g.radius && d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}

function updateHandHover(handIndex) {
  const h = hands[handIndex];
  if (!h.highlight) return;
  if (h.grabbing) {
    h.highlight.material.opacity = 0.55;
    h.highlight.material.color.setHex(0x50e0a0);
    return;
  }
  const near = findNearestGrabbable(handIndex);
  if (near) {
    h.highlight.material.opacity = 0.4;
    h.highlight.material.color.setHex(0x60d0e8);
  } else {
    h.highlight.material.opacity = 0.0;
  }
}

function tryGrab(handIndex) {
  if (hands[handIndex].grabbing) return;
  // Menu open: ray UI only, no cockpit grabs
  if (menuVisible) return;

  const g = findNearestGrabbable(handIndex);
  if (!g) return;

  hands[handIndex].grabbing = g;
  const grip = hands[handIndex].grip;
  grip.getWorldPosition(_v);
  g.root.getWorldPosition(_v2);

  // Hand in parent (cockpit) space at grab start
  g.root.parent.updateWorldMatrix(true, false);
  _m.copy(g.root.parent.matrixWorld).invert();
  _local.copy(_v).applyMatrix4(_m);

  let twist0 = 0;
  if (grip) {
    grip.getWorldQuaternion(_q);
    twist0 = extractTwistAroundY(_q);
  }

  activeGrab = {
    type: g.type,
    hand: handIndex,
    pivotWorld: _v2.clone(),
    grabLocal: _local.clone(),
    twist0,
    startGear: controls.gear,
    startBrake: controls.brakes,
    startReleaseZ: g.root.position.z,
    // Along-track for levers (cockpit-local hand at grab)
    startHandY: _local.y,
    startHandZ: _local.z,
    // Smoothed stick axes (filled while driving)
    smPitch: controls.pitch,
    smRoll: controls.roll,
    smYaw: controls.yaw,
  };

  // Soft haptic if available
  pulseHaptic(handIndex, 0.3, 20);
}

function releaseGrab(handIndex) {
  const g = hands[handIndex].grabbing;
  if (!g) return;
  hands[handIndex].grabbing = null;
  if (activeGrab && activeGrab.hand === handIndex) {
    // Soft-snap gear only when clearly past midpoint (keeps both directions usable)
    if (g.type === 'gear') {
      if (controls.gear > 0.62) controls.gear = 1;
      else if (controls.gear < 0.38) controls.gear = 0;
      // else leave intermediate for animation; surfaces use continuous value
      controls.gearToggle = true;
    }
    // Brakes: leave continuous value (any position 0…1)
    activeGrab = null;
  }
  controls.xrStickGrab = false;
  controls.xrBrakeGrab = false;
  controls.xrGearGrab = false;
  controls.xrReleaseGrab = false;
}

/**
 * Map hand pose → flight controls while holding a grabbable.
 */
function driveGrab(handIndex, dt) {
  const g = hands[handIndex].grabbing;
  if (!g || !activeGrab || activeGrab.hand !== handIndex) return;
  const grip = hands[handIndex].grip;
  if (!grip) return;

  grip.getWorldPosition(_v);

  if (g.type === 'stick') {
    controls.xrStickGrab = true;
    // Hand in cockpit (parent) space — independent of stick mesh rotation (no feedback loop)
    const pivot = g.root;
    pivot.parent.updateWorldMatrix(true, false);
    _m.copy(pivot.parent.matrixWorld).invert();
    _local.copy(_v).applyMatrix4(_m);
    const px = pivot.position.x;
    const py = pivot.position.y;
    const pz = pivot.position.z;
    // Offset from upright grip rest (base + up along shaft)
    const gripLen = 0.4;
    const ox = _local.x - px;
    const oy = _local.y - (py + gripLen);
    const oz = _local.z - pz;
    // Displacement mapping (stable): lateral → roll, fore/aft → pitch
    // +X (hand right) → bank right; +Z (pull aft) → nose up
    let rollRaw = THREE.MathUtils.clamp(ox / STICK_THROW, -1.4, 1.4);
    let pitchRaw = THREE.MathUtils.clamp(oz / STICK_THROW, -1.4, 1.4);
    // Slight vertical blend (don't dominate — was a source of pitch glitch)
    pitchRaw += THREE.MathUtils.clamp(-oy / (STICK_THROW * 2.2), -0.25, 0.25);
    rollRaw = curveAxis(rollRaw);
    pitchRaw = curveAxis(pitchRaw);

    // Twist → yaw (wide deadzone so it doesn't jitter into roll/pitch)
    grip.getWorldQuaternion(_q);
    const twist = extractTwistAroundY(_q);
    let yawRaw = (twist - activeGrab.twist0) / STICK_TWIST_MAX;
    if (Math.abs(yawRaw) < 0.12) yawRaw = 0;
    yawRaw = curveAxis(THREE.MathUtils.clamp(yawRaw, -1.35, 1.35));

    // Low-pass filter — kills tracking noise that made ailerons feel wrong
    const a = 1 - Math.exp(-STICK_SMOOTH * Math.max(0.001, dt));
    activeGrab.smRoll += (rollRaw - activeGrab.smRoll) * a;
    activeGrab.smPitch += (pitchRaw - activeGrab.smPitch) * a;
    activeGrab.smYaw += (yawRaw - activeGrab.smYaw) * a;

    controls.roll = THREE.MathUtils.clamp(activeGrab.smRoll, -1, 1);
    controls.pitch = THREE.MathUtils.clamp(activeGrab.smPitch, -1, 1);
    controls.yaw = THREE.MathUtils.clamp(activeGrab.smYaw, -1, 1);

    // Stick visual follows smoothed axes (not raw grip)
    pivot.rotation.z = -controls.roll * 0.48;
    pivot.rotation.x = controls.pitch * 0.52;
    pivot.rotation.y = -controls.yaw * 0.3;
  } else if (g.type === 'brake') {
    // Continuous 0…1 — relative slide from grab, both directions
    controls.xrBrakeGrab = true;
    g.root.parent.updateWorldMatrix(true, false);
    _m.copy(g.root.parent.matrixWorld).invert();
    _local.copy(_v).applyMatrix4(_m);
    // Forward (−Z) and/or down (−Y) opens brakes; reverse closes
    const dFwd = activeGrab.startHandZ - _local.z; // hand more forward → +
    const dDown = activeGrab.startHandY - _local.y; // hand lower → +
    const delta = (dFwd * 0.65 + dDown * 0.55) / LEVER_THROW;
    let b = activeGrab.startBrake + delta;
    b = THREE.MathUtils.clamp(b, 0, 1);
    controls.brakes = b;
    // Visual: stowed −0.12 → full open −1.15
    g.root.rotation.x = -0.12 - b * 1.05;
  } else if (g.type === 'gear') {
    // Continuous both ways: push down/forward = DN (1), pull up/aft = UP (0)
    controls.xrGearGrab = true;
    g.root.parent.updateWorldMatrix(true, false);
    _m.copy(g.root.parent.matrixWorld).invert();
    _local.copy(_v).applyMatrix4(_m);
    const dDown = activeGrab.startHandY - _local.y; // lower hand → gear down
    const dFwd = activeGrab.startHandZ - _local.z; // forward → gear down
    const delta = (dDown * 0.7 + dFwd * 0.45) / LEVER_THROW;
    let gear = activeGrab.startGear + delta;
    gear = THREE.MathUtils.clamp(gear, 0, 1);
    controls.gear = gear;
    // Visual: DN −0.12 → UP −1.2
    g.root.rotation.x = -0.12 - (1 - gear) * 1.08;
  } else if (g.type === 'release') {
    controls.xrReleaseGrab = true;
    g.root.parent.updateWorldMatrix(true, false);
    _m.copy(g.root.parent.matrixWorld).invert();
    _local.copy(_v).applyMatrix4(_m);
    // Pull toward pilot (+z) to release
    const pull = _local.z - activeGrab.startReleaseZ;
    g.root.position.z = THREE.MathUtils.clamp(
      activeGrab.startReleaseZ + Math.max(0, pull),
      -0.35,
      -0.12
    );
    if (pull > 0.1 && !releaseLatched) {
      controls.restart = true; // maps to releaseLaunch / restart in main
      releaseLatched = true;
      pulseHaptic(handIndex, 0.8, 40);
    }
    if (pull < 0.05) releaseLatched = false;
  }
}

function curveAxis(v) {
  const s = Math.sign(v);
  const a = Math.min(1, Math.abs(v));
  // Deadzone + power curve for fine control near center
  const dead = 0.06;
  if (a < dead) return 0;
  const t = (a - dead) / (1 - dead);
  return s * Math.pow(t, STICK_CURVE);
}

/** Approximate twist about world-up from a quaternion. */
function extractTwistAroundY(q) {
  // Project controller forward onto XZ, measure yaw
  _v2.set(0, 0, -1).applyQuaternion(q);
  _v2.y = 0;
  if (_v2.lengthSq() < 1e-6) return 0;
  _v2.normalize();
  return Math.atan2(_v2.x, -_v2.z);
}

function applyThumbstickFallback(session) {
  let pitch = 0;
  let roll = 0;
  let yaw = 0;
  let brakes = 0;
  let gearEdge = false;
  let releaseEdge = false;
  let camEdge = false;
  let menuEdge = false;
  let aButton = false;

  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const hand = src.handedness;
    const ax = gp.axes || [];
    let sx = 0;
    let sy = 0;
    if (ax.length >= 4) {
      sx = ax[2] || 0;
      sy = ax[3] || 0;
    } else if (ax.length >= 2) {
      sx = ax[0] || 0;
      sy = ax[1] || 0;
    }
    if (Math.abs(sx) < 0.1) sx = 0;
    if (Math.abs(sy) < 0.1) sy = 0;
    // Gentle curve on sticks too
    sx = curveAxis(sx * 1.05);
    sy = curveAxis(sy * 1.05);

    if (!menuVisible) {
      if (hand === 'right' || hand === '') {
        // Right thumbstick pitch: push up (sy < 0 on Quest) = nose up
        // (inverted from earlier mapping per pilot feedback)
        pitch += sy;
        roll += sx;
      }
      if (hand === 'left') {
        yaw += sx;
      }
    }

    const btns = gp.buttons || [];
    const trigger = btns[0]?.value ?? (btns[0]?.pressed ? 1 : 0);
    // Only use trigger as brakes when not grabbing something with this hand
    const handIdx = hand === 'left' ? 0 : 1;
    if (!menuVisible && !hands[handIdx]?.grabbing) {
      if (hand === 'right' || hand === '') {
        brakes = Math.max(brakes, trigger);
      }
    }
    if (hand === 'right' || hand === '') {
      if (btns[4]?.pressed) {
        if (menuVisible) aButton = true; // A = Launch on menu
        else gearEdge = true;
      }
      if (btns[5]?.pressed) releaseEdge = true;
    }
    if (hand === 'left') {
      if (trigger > 0.85 && !hands[0]?.grabbing && !menuVisible) camEdge = true;
      if (btns[4]?.pressed) gearEdge = true;
      if (btns[5]?.pressed) menuEdge = true; // Y often menu
    }
  }

  // Menu open: A button launches
  if (menuVisible && aButton && !gearLatched) {
    gearLatched = true;
    setVRMenuVisible(false);
    menuFlying = true;
    onMenuLaunch?.();
    return;
  }

  if (!menuVisible) {
    if (Math.abs(pitch) > 0.02) controls.pitch = THREE.MathUtils.clamp(pitch, -1, 1);
    if (Math.abs(roll) > 0.02) controls.roll = THREE.MathUtils.clamp(roll, -1, 1);
    if (Math.abs(yaw) > 0.02) controls.yaw = THREE.MathUtils.clamp(yaw, -1, 1);
    if (brakes > 0.05 && !controls.xrBrakeGrab) {
      controls.brakes = THREE.MathUtils.clamp(brakes, 0, 1);
    }
  }

  applyEdges(gearEdge, releaseEdge, camEdge, menuEdge);
}

function applyButtonEdges(session) {
  let gearEdge = false;
  let releaseEdge = false;
  let camEdge = false;
  let menuEdge = false;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const hand = src.handedness;
    const btns = gp.buttons || [];
    if (btns[4]?.pressed) gearEdge = true;
    if (btns[5]?.pressed) {
      if (hand === 'left') menuEdge = true;
      else releaseEdge = true;
    }
  }
  applyEdges(gearEdge, releaseEdge, camEdge, menuEdge);
}

function applyEdges(gearEdge, releaseEdge, camEdge, menuEdge) {
  if (gearEdge && !gearLatched && !controls.xrGearGrab) {
    controls.gear = controls.gear > 0.5 ? 0 : 1;
    controls.gearToggle = true;
    gearLatched = true;
  } else if (!gearEdge) gearLatched = false;

  if (releaseEdge && !releaseLatched && !controls.xrReleaseGrab) {
    controls.restart = true;
    releaseLatched = true;
  } else if (!releaseEdge && !controls.xrReleaseGrab) {
    releaseLatched = false;
  }

  if (camEdge && !camLatched) {
    controls.cameraToggle = true;
    camLatched = true;
  } else if (!camEdge) camLatched = false;

  if (menuEdge && !menuBtnLatched) {
    controls.menu = true;
    menuBtnLatched = true;
    // Toggle VR menu while flying
    if (menuFlying && xrPresenting) {
      setVRMenuVisible(!menuVisible);
    }
  } else if (!menuEdge) {
    menuBtnLatched = false;
  }
}

function pulseHaptic(handIndex, intensity, durationMs) {
  try {
    const session = renderer?.xr?.getSession?.();
    if (!session) return;
    for (const src of session.inputSources) {
      const hi = src.handedness === 'left' ? 0 : 1;
      if (hi !== handIndex) continue;
      const gp = src.gamepad;
      const actuator = gp?.hapticActuators?.[0] || gp?.vibrationActuator;
      if (actuator?.pulse) actuator.pulse(intensity, durationMs);
    }
  } catch {
    /* no haptics */
  }
}

function clearXRAxes() {
  gearLatched = false;
  releaseLatched = false;
  camLatched = false;
  menuBtnLatched = false;
  activeGrab = null;
  hands[0].grabbing = null;
  hands[1].grabbing = null;
  hands[0].squeezeHeld = false;
  hands[1].squeezeHeld = false;
  hands[0].selectHeld = false;
  hands[1].selectHeld = false;
  controls.xrStickGrab = false;
  controls.xrBrakeGrab = false;
  controls.xrGearGrab = false;
  controls.xrReleaseGrab = false;
}

// ═══════════════════════════════════════════════════════════
// World-space VR menu
// ═══════════════════════════════════════════════════════════

/** Dynamic button root (rebuilt); static chrome stays on menuGroup */
let menuButtonsRoot = null;

function buildVRMenu() {
  menuGroup = new THREE.Group();
  menuGroup.name = 'xrMenu';
  menuGroup.visible = false;
  // Close to the face so nothing in the world can sit in front of it
  menuGroup.position.set(0, 0.02, -0.72);
  menuGroup.renderOrder = 10000;
  // Dedicated layer so we can draw UI above the world if needed
  menuGroup.layers.set(2);
  xrRig.add(menuGroup);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.95, 1.05),
    new THREE.MeshBasicMaterial({
      color: 0xf4f6f8,
      transparent: true,
      opacity: 0.98,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  panel.position.z = 0.005;
  panel.renderOrder = 10000;
  panel.layers.set(2);
  menuGroup.add(panel);

  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.95, 1.05)),
    new THREE.LineBasicMaterial({ color: 0x2a6a78, depthTest: false })
  );
  frame.position.z = 0.008;
  frame.renderOrder = 10001;
  frame.layers.set(2);
  menuGroup.add(frame);

  const buildLabel =
    typeof __BUILD_ID__ !== 'undefined' ? String(__BUILD_ID__).slice(0, 12) : 'dev';
  const title = makeTextPlane('LOW POLY GLIDER', 512, 56, {
    font: 'bold 34px system-ui,sans-serif',
    fill: '#1a4a58',
  });
  title.scale.set(0.58, 0.075, 1);
  title.position.set(0, 0.44, 0.02);
  title.renderOrder = 10002;
  title.layers.set(2);
  menuGroup.add(title);
  const buildPlane = makeTextPlane(`build ${buildLabel}`, 512, 32, {
    font: '18px system-ui,sans-serif',
    fill: '#6a8090',
  });
  buildPlane.scale.set(0.5, 0.04, 1);
  buildPlane.position.set(0, 0.38, 0.02);
  buildPlane.renderOrder = 10002;
  buildPlane.layers.set(2);
  menuGroup.add(buildPlane);

  menuButtonsRoot = new THREE.Group();
  menuButtonsRoot.name = 'xrMenuButtons';
  menuButtonsRoot.layers.set(2);
  menuGroup.add(menuButtonsRoot);

  rebuildMenuButtons();
}

function rebuildMenuButtons() {
  if (!menuGroup || !menuButtonsRoot) return;

  while (menuButtonsRoot.children.length) {
    const ch = menuButtonsRoot.children[0];
    menuButtonsRoot.remove(ch);
    ch.geometry?.dispose?.();
    if (ch.material?.map) ch.material.map.dispose();
    ch.material?.dispose?.();
    ch.traverse?.((o) => {
      o.geometry?.dispose?.();
      if (o.material?.map) o.material.map.dispose();
      o.material?.dispose?.();
    });
  }
  menuButtons = [];

  const items = menuScenarios.length
    ? menuScenarios
    : [{ id: 'sandbox', name: 'Sandbox' }];

  // —— LAUNCH at the TOP (primary action, always visible) ——
  const launch = makeButtonMesh('▶  LAUNCH', false, '#1a8a6a', 0.78, 0.11);
  launch.position.set(0, 0.32, 0.03);
  tagMenuButton(launch, 'launch');
  menuButtonsRoot.add(launch);
  menuButtons.push({ mesh: launch, action: 'launch' });

  const sub = makeTextPlane('Then pick a scenario · trigger to click', 512, 36, {
    font: '20px system-ui,sans-serif',
    fill: '#5a7080',
  });
  sub.scale.set(0.55, 0.045, 1);
  sub.position.set(0, 0.22, 0.03);
  sub.layers.set(2);
  menuButtonsRoot.add(sub);

  // 2-column scenario grid below LAUNCH
  const cols = 2;
  const btnW = 0.42;
  const btnH = 0.065;
  const startY = 0.12;
  const rowH = 0.078;
  const colGap = 0.46;

  items.forEach((sc, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const active = sc.id === menuActiveId;
    const mesh = makeButtonMesh(sc.name, active, null, btnW, btnH);
    mesh.position.set((col - 0.5) * colGap, startY - row * rowH, 0.03);
    tagMenuButton(mesh, 'scenario', sc.id);
    menuButtonsRoot.add(mesh);
    menuButtons.push({ mesh, action: 'scenario', id: sc.id });
  });

  const rows = Math.ceil(items.length / cols);
  const exitY = startY - rows * rowH - 0.06;
  const exit = makeButtonMesh(
    menuFlying ? 'EXIT TO MENU' : 'EXIT VR',
    false,
    '#8a4040',
    0.5,
    0.06
  );
  exit.position.set(0, exitY, 0.03);
  tagMenuButton(exit, menuFlying ? 'exitMenu' : 'exitVR');
  menuButtonsRoot.add(exit);
  menuButtons.push({ mesh: exit, action: exit.userData.menuAction });

  const hint = makeTextPlane(
    'A button also launches · grab stick in flight',
    640,
    36,
    { font: '18px system-ui,sans-serif', fill: '#4a6870' }
  );
  hint.scale.set(0.7, 0.04, 1);
  hint.position.set(0, exitY - 0.08, 0.03);
  hint.layers.set(2);
  menuButtonsRoot.add(hint);

  // Ensure all button meshes are on UI layer
  menuButtonsRoot.traverse((o) => {
    o.layers.set(2);
    o.renderOrder = Math.max(o.renderOrder || 0, 10003);
  });
}

function makeButtonMesh(label, active, accent, w = 0.62, h = 0.075) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = active ? 'rgba(90,200,220,0.55)' : 'rgba(255,255,255,0.95)';
  if (accent) ctx.fillStyle = accent;
  roundRect(ctx, 6, 6, 500, 84, 14);
  ctx.fill();
  ctx.strokeStyle = active ? '#0a6080' : 'rgba(40,100,120,0.55)';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = accent ? '#fff' : '#1a4a58';
  ctx.font = accent ? 'bold 36px system-ui,sans-serif' : 'bold 26px system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 256, 50);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.renderOrder = 10003;
  mesh.layers.set(2);
  mesh.userData.isMenuButton = true;
  mesh.userData.baseScale = 1;
  // Invisible thicker hit slab so trigger is forgiving
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(w * 1.12, h * 1.55, 0.12),
    new THREE.MeshBasicMaterial({
      visible: false,
      transparent: true,
      opacity: 0,
      depthTest: false,
    })
  );
  hit.position.z = 0.02;
  hit.name = 'menuHit';
  hit.layers.set(2);
  mesh.add(hit);
  mesh.userData.hit = hit;
  return mesh;
}

/** Copy action tags onto button + hit slab for raycast. */
function tagMenuButton(mesh, action, scenarioId) {
  mesh.userData.menuAction = action;
  if (scenarioId) mesh.userData.scenarioId = scenarioId;
  const hit = mesh.userData.hit;
  if (hit) {
    hit.userData.menuAction = action;
    if (scenarioId) hit.userData.scenarioId = scenarioId;
  }
}

function makeTextPlane(text, cw, ch, opts) {
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = opts.fill || '#222';
  ctx.font = opts.font || '24px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cw / 2, ch / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, ch / cw),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  mesh.renderOrder = 1002;
  return mesh;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function setVRMenuVisible(vis) {
  menuVisible = !!vis;
  if (menuGroup) {
    menuGroup.visible = menuVisible;
    if (menuVisible) rebuildMenuButtons();
  }
}

export function showVRMenu() {
  setVRMenuVisible(true);
}
export function hideVRMenu() {
  setVRMenuVisible(false);
}

const _raycaster = new THREE.Raycaster();
_raycaster.layers.enable(0);
_raycaster.layers.enable(2); // VR menu UI layer
const _ndc = new THREE.Vector2();

function tryMenuSelect(handIndex) {
  if (!menuVisible || !menuGroup) return;
  const btn = raycastMenuButton(handIndex);
  if (!btn) return;
  const action = btn.mesh.userData.menuAction;
  pulseHaptic(handIndex, 0.55, 35);
  if (action === 'scenario' && btn.mesh.userData.scenarioId) {
    menuActiveId = btn.mesh.userData.scenarioId;
    onMenuSelect?.(menuActiveId);
    // Defer rebuild one frame so we don't dispose the mesh under the pointer mid-event
    requestAnimationFrame(() => {
      if (menuVisible) rebuildMenuButtons();
    });
  } else if (action === 'launch') {
    // Hide menu and start flight in the same turn (no async gap)
    setVRMenuVisible(false);
    menuFlying = true;
    onMenuLaunch?.();
  } else if (action === 'exitMenu') {
    setVRMenuVisible(false);
    onMenuExit?.();
  } else if (action === 'exitVR') {
    const session = renderer?.xr?.getSession?.();
    session?.end?.();
  }
}

/**
 * Ray from controller (−Z) through menu buttons (including thick hit slabs).
 * @returns {{ mesh: THREE.Mesh } | null}
 */
function raycastMenuButton(handIndex) {
  const ctrl = hands[handIndex].ctrl;
  if (!ctrl || !menuButtonsRoot) return null;
  ctrl.updateMatrixWorld(true);
  // Three.js XR controllers aim along local −Z
  _v.setFromMatrixPosition(ctrl.matrixWorld);
  _v2.set(0, 0, -1).transformDirection(ctrl.matrixWorld);
  _raycaster.set(_v, _v2);
  _raycaster.far = 4;
  const targets = [];
  for (const b of menuButtons) {
    targets.push(b.mesh);
    if (b.mesh.userData.hit) targets.push(b.mesh.userData.hit);
  }
  const hits = _raycaster.intersectObjects(targets, false);
  if (!hits.length) return null;
  let obj = hits[0].object;
  // Walk up from hit slab to button mesh
  while (obj && !obj.userData?.menuAction && obj.parent) obj = obj.parent;
  if (!obj?.userData?.menuAction) return null;
  const btn = menuButtons.find((b) => b.mesh === obj);
  return btn || { mesh: obj };
}

function updateMenuHover() {
  let hotMesh = null;
  for (let i = 0; i < 2; i++) {
    const btn = raycastMenuButton(i);
    if (btn) hotMesh = btn.mesh;
  }
  for (const b of menuButtons) {
    const hot = b.mesh === hotMesh;
    b.mesh.scale.setScalar(hot ? 1.08 : 1);
  }
}

/**
 * Native-feeling VR button (HTTPS required on Quest for non-localhost).
 */
export function createVRButton(renderer) {
  const button = document.createElement('button');
  button.id = 'vr-button';
  button.type = 'button';
  button.textContent = 'ENTER VR';

  function showEnter() {
    button.textContent = 'ENTER VR';
    button.disabled = false;
    button.classList.remove('vr-exit');
  }
  function showExit() {
    button.textContent = 'EXIT VR';
    button.disabled = false;
    button.classList.add('vr-exit');
  }
  function showNotSupported() {
    button.textContent = 'VR NOT AVAILABLE';
    button.disabled = true;
  }

  if (!navigator.xr) {
    showNotSupported();
    button.title = 'WebXR not available in this browser';
    return button;
  }

  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) {
      showNotSupported();
      button.title = 'Immersive VR not supported on this device';
      return;
    }
    showEnter();
  });

  button.addEventListener('click', async () => {
    if (renderer.xr.isPresenting) {
      const session = renderer.xr.getSession();
      if (session) session.end();
      return;
    }
    try {
      const sessionInit = {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
      };
      const session = await navigator.xr.requestSession('immersive-vr', sessionInit);
      await renderer.xr.setSession(session);
      showExit();
      session.addEventListener('end', showEnter);
    } catch (err) {
      console.warn('[XR] session failed', err);
      button.textContent = 'VR FAILED — USE HTTPS?';
      button.title =
        err?.message ||
        'Quest requires HTTPS (or adb reverse to localhost). See console.';
      setTimeout(showEnter, 3200);
    }
  });

  return button;
}

export function isXRPresenting() {
  return xrPresenting;
}
