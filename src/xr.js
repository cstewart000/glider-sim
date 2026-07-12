/**
 * WebXR session + Quest-friendly controller mapping for cockpit flight.
 *
 * Controls (typical Quest / OpenXR):
 *  Right stick Y  — pitch (pull back = nose up)
 *  Right stick X  — roll
 *  Left stick X   — rudder
 *  Right trigger  — airbrakes
 *  A / X          — toggle gear
 *  B / Y          — release cable/tow or restart (edge)
 *  Left trigger   — camera cycle (edge)
 */

import * as THREE from 'three';
import { controls } from './input.js';

/** @type {boolean} */
export let xrPresenting = false;

let renderer = null;
let xrRig = null;
let camera = null;
let scene = null;
let controllersReady = false;

const _euler = new THREE.Euler();
const _q = new THREE.Quaternion();

// Edge-trigger latches for XR buttons
let gearLatched = false;
let releaseLatched = false;
let camLatched = false;

/**
 * @param {object} opts
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {HTMLElement} [opts.buttonHost]
 */
export function initXR({ renderer: r, scene: s, camera: cam, buttonHost }) {
  renderer = r;
  scene = s;
  camera = cam;

  renderer.xr.enabled = true;
  // Seated cockpit — local space, we move the rig each frame
  try {
    renderer.xr.setReferenceSpaceType('local');
  } catch {
    /* older three */
  }

  // Rig: world pose of the cockpit; headset is relative to this
  xrRig = new THREE.Group();
  xrRig.name = 'xrRig';
  xrRig.visible = false;
  scene.add(xrRig);

  // Simple controller rays (lightweight, no GLTF)
  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    ctrl.add(makePointerMesh());
    xrRig.add(ctrl);

    const grip = renderer.xr.getControllerGrip(i);
    grip.add(makeGripMesh());
    xrRig.add(grip);
  }

  const btn = createVRButton(renderer);
  if (buttonHost) buttonHost.appendChild(btn);
  else document.body.appendChild(btn);

  renderer.xr.addEventListener('sessionstart', () => {
    xrPresenting = true;
    xrRig.visible = true;
    // Parent camera under rig so WebXR local pose is cockpit-relative
    if (camera.parent !== xrRig) {
      xrRig.add(camera);
    }
    // Headset pose is applied on camera; keep local identity as base
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    camera.near = 0.05;
    camera.far = 3500;
    camera.updateProjectionMatrix();
    document.documentElement.classList.add('xr-active');
  });

  renderer.xr.addEventListener('sessionend', () => {
    xrPresenting = false;
    xrRig.visible = false;
    // Restore camera to scene root for desktop
    if (camera.parent === xrRig) {
      scene.add(camera);
    }
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    camera.rotation.set(0, 0, 0);
    document.documentElement.classList.remove('xr-active');
    // Clear XR-driven axes so keyboard takes over cleanly
    clearXRAxes();
  });

  controllersReady = true;
  return { xrRig, button: btn };
}

function makePointerMesh() {
  const g = new THREE.Group();
  const line = new THREE.Mesh(
    new THREE.CylinderGeometry(0.003, 0.003, 0.35, 4),
    new THREE.MeshBasicMaterial({ color: 0x88c8d8, transparent: true, opacity: 0.55 })
  );
  line.rotation.x = -Math.PI / 2;
  line.position.z = -0.18;
  g.add(line);
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.012, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0xc8eef8 })
  );
  tip.position.z = -0.36;
  g.add(tip);
  return g;
}

function makeGripMesh() {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.04, 0.08),
    new THREE.MeshBasicMaterial({ color: 0xb0b0b8, transparent: true, opacity: 0.7 })
  );
  return mesh;
}

/**
 * Place XR origin at cockpit eye, oriented with the glider.
 * Headset look is layered on top by WebXR.
 * @param {THREE.Vector3} eyePos
 * @param {THREE.Quaternion} gliderQuat
 */
export function updateXRRig(eyePos, gliderQuat) {
  if (!xrPresenting || !xrRig) return;
  xrRig.position.copy(eyePos);
  xrRig.quaternion.copy(gliderQuat);
}

/**
 * Read XR gamepads and write into shared `controls` (after keyboard update).
 * Keyboard is baseline; XR sticks/buttons override axes when deflected.
 */
export function updateXRControls() {
  if (!xrPresenting || !renderer) return;
  const session = renderer.xr.getSession();
  if (!session) return;

  let pitch = 0;
  let roll = 0;
  let yaw = 0;
  let brakes = 0;
  let gearEdge = false;
  let releaseEdge = false;
  let camEdge = false;

  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const hand = src.handedness; // 'left' | 'right' | ''

    // Axes: Quest often uses [0,1] touchpad and [2,3] thumbstick
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
    // Deadzone
    if (Math.abs(sx) < 0.12) sx = 0;
    if (Math.abs(sy) < 0.12) sy = 0;

    if (hand === 'right' || hand === '') {
      // Aircraft stick: pull back (sy < 0 on many pads) = nose up
      // Quest: thumbstick up is often negative Y
      pitch += -sy;
      roll += sx;
    }
    if (hand === 'left') {
      yaw += sx;
      // left stick Y unused (or could be trim later)
    }

    // Buttons: 0 trigger, 1 squeeze, 4 A/X, 5 B/Y (common layout)
    const btns = gp.buttons || [];
    const trigger = btns[0]?.value ?? (btns[0]?.pressed ? 1 : 0);
    const squeeze = btns[1]?.value ?? (btns[1]?.pressed ? 1 : 0);
    if (hand === 'right' || hand === '') {
      brakes = Math.max(brakes, trigger, squeeze);
      if (btns[4]?.pressed) gearEdge = true;
      if (btns[5]?.pressed) releaseEdge = true;
    }
    if (hand === 'left') {
      if (trigger > 0.8) camEdge = true;
      if (btns[4]?.pressed) gearEdge = true;
      if (btns[5]?.pressed) releaseEdge = true;
      // left squeeze as brakes alternative
      brakes = Math.max(brakes, squeeze);
    }
  }

  // Clamp
  pitch = THREE.MathUtils.clamp(pitch, -1, 1);
  roll = THREE.MathUtils.clamp(roll, -1, 1);
  yaw = THREE.MathUtils.clamp(yaw, -1, 1);
  brakes = THREE.MathUtils.clamp(brakes, 0, 1);

  // Override keyboard axes when XR stick deflected; keep keys if stick neutral
  if (Math.abs(pitch) > 0.02) controls.pitch = pitch;
  if (Math.abs(roll) > 0.02) controls.roll = roll;
  if (Math.abs(yaw) > 0.02) controls.yaw = yaw;
  if (brakes > 0.05) controls.brakes = brakes;

  // Gear edge
  if (gearEdge && !gearLatched) {
    controls.gear = controls.gear > 0.5 ? 0 : 1;
    controls.gearToggle = true;
    gearLatched = true;
  } else if (!gearEdge) {
    gearLatched = false;
  }

  // Release / restart edge → maps to controls.restart (one frame)
  if (releaseEdge && !releaseLatched) {
    controls.restart = true;
    releaseLatched = true;
  } else {
    if (!releaseEdge) releaseLatched = false;
  }

  if (camEdge && !camLatched) {
    controls.cameraToggle = true;
    camLatched = true;
  } else {
    if (!camEdge) camLatched = false;
  }
}

function clearXRAxes() {
  gearLatched = false;
  releaseLatched = false;
  camLatched = false;
}

/**
 * Native-feeling VR button (HTTPS required on Quest for non-localhost).
 * @param {THREE.WebGLRenderer} renderer
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
