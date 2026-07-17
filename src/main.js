/**
 * Low Poly Glider — concept-art monochrome wireframe soaring.
 */

import * as THREE from 'three';
import {
  createGlider, setCockpitVisible, updateControlSurfaces, updateCockpitInstruments,
  updateWheelSpin,
} from './glider.js';
import {
  createTerrain, terrainHeight, profileForScenario, setTerrainProfile,
  getTerrainProfile,
} from './terrain.js';
import { ThermalSystem } from './thermals.js';
import { CloudSystem } from './clouds.js';
import { RidgeVaporSystem } from './ridgeVapor.js';
import { createRunway, RUNWAY } from './runway.js';
import { GliderPhysics } from './physics.js';
import { sampleWind } from './atmosphere.js';
import {
  initInput, updateInput, controls, resetLook, setInvertPitch,
} from './input.js';
import {
  showHUD, showTitle, showLanding, updateHUD, onStart, onRestart,
  setCockpitOverlayVisible, beginCrashSequence, beginLandingHold,
  updateCrashSequence, isResultHoldActive, hideCrashFx, setupScenarioMenu,
  showCoachTip, coachForScenario,
} from './hud.js';
import { flightAudio } from './flightAudio.js';
import {
  SCENARIO_LIST, setActiveScenario, getActiveScenario, scenarioRuntime,
  isLaunchAttached, releaseLaunch, scoreLanding, scoreCrossCountry,
  scoreSandbox,
} from './scenarios.js';
import {
  initScenarioVisuals, setScenarioVisualMode, updateScenarioVisuals,
} from './scenarioVisuals.js';
import { initCockpitOverlay, updateCockpitOverlay } from './cockpitOverlay.js';
import {
  initXR, updateXRRig, updateXRControls, isXRPresenting, isVRMenuVisible,
  setXRFlying, setXRMenuScenarios, setXRGlider, showVRMenu, hideVRMenu,
} from './xr.js';
import { loadPrefs, savePrefs, getVolume } from './prefs.js';

// Injected by Vite at build/dev time — shows on title so Quest cache is obvious
const BUILD_ID =
  typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';
{
  const el = document.getElementById('build-id');
  if (el) el.textContent = `build ${BUILD_ID}`;
  console.info('[glider-sim] build', BUILD_ID);
}

// —— Renderer tuned for ~50fps on integrated GPUs ——
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false, // big win on Linux iGPU
  powerPreference: 'high-performance',
  stencil: false,
  depth: true,
  // Required for WebXR on many browsers
  alpha: false,
});
// Cap DPR — 1.0–1.25 is usually enough; 2x is 4× pixels (XR overrides while presenting)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;
renderer.setClearColor(0xeef2f5); // concept-art pale white horizon
renderer.sortObjects = false; // transparent clouds already use renderOrder

// —— Scene ——
const scene = new THREE.Scene();
// Dissolve into white paper — hides far LOD, matches concept sky
scene.fog = new THREE.Fog(0xe8eef2, 420, 1950);

// Pale blue sky dome — discrete shaded bands by elevation above horizon
{
  const R = 2400;
  const skyGeo = new THREE.SphereGeometry(R, 32, 20);
  const pos = skyGeo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  // Concept paper sky: white horizon → soft pale blue zenith
  const bands = [
    { h: 0.0, c: new THREE.Color(0xf4f7fa) },
    { h: 0.1, c: new THREE.Color(0xe8eef4) },
    { h: 0.22, c: new THREE.Color(0xdce6f0) },
    { h: 0.38, c: new THREE.Color(0xcedceb) },
    { h: 0.55, c: new THREE.Color(0xc0d2e4) },
    { h: 0.75, c: new THREE.Color(0xb4c8dc) },
    { h: 1.0, c: new THREE.Color(0xa8bed4) },
  ];
  const below = new THREE.Color(0xe4eaf0);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < 0) {
      colors[i * 3] = below.r;
      colors[i * 3 + 1] = below.g;
      colors[i * 3 + 2] = below.b;
      continue;
    }
    const elev = Math.min(1, y / R);
    let bandIdx = 0;
    for (let b = bands.length - 1; b >= 0; b--) {
      if (elev >= bands[b].h) {
        bandIdx = b;
        break;
      }
    }
    const col = bands[bandIdx].c;
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  skyGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(
    skyGeo,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    })
  );
  sky.renderOrder = -10;
  scene.add(sky);
}

// Pale hazy sun + concentric blend bands (fixed sky direction)
const sunGroup = new THREE.Group();
sunGroup.name = 'sun';
sunGroup.renderOrder = -9;
{
  // Direction: above horizon, off to the side (azimuth + elevation)
  const elev = 0.32; // ~18° above horizon
  const azim = -0.55; // slightly to the left of -Z
  const sunDir = new THREE.Vector3(
    Math.sin(azim) * Math.cos(elev),
    Math.sin(elev),
    -Math.cos(azim) * Math.cos(elev)
  ).normalize();
  sunGroup.userData.dir = sunDir;

  // Concentric discs: core → pale yellow haze → sky blend
  // sizes in world units at sky distance
  const rings = [
    { r: 55, color: 0xfff8e0, opacity: 0.95 },  // hot pale core
    { r: 90, color: 0xffeeb8, opacity: 0.45 },  // soft yellow
    { r: 140, color: 0xf5e4a8, opacity: 0.28 }, // hazy yellow
    { r: 200, color: 0xe0dcc8, opacity: 0.16 }, // cream blend
    { r: 280, color: 0xc8d8e8, opacity: 0.1 },  // into pale blue
    { r: 380, color: 0xb8cce0, opacity: 0.06 }, // sky band
  ];

  for (let i = rings.length - 1; i >= 0; i--) {
    const ring = rings[i];
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(ring.r, 32),
      new THREE.MeshBasicMaterial({
        color: ring.color,
        transparent: true,
        opacity: ring.opacity,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      })
    );
    disc.renderOrder = -9 + i;
    sunGroup.add(disc);
  }
  scene.add(sunGroup);
}

function updateSun(camera) {
  if (!sunGroup.userData.dir) return;
  const dist = 2200;
  sunGroup.position.copy(camera.position).addScaledVector(sunGroup.userData.dir, dist);
  // Face the camera (billboard for the disc plane)
  sunGroup.quaternion.copy(camera.quaternion);
}

// Simple ground shadow cast from sun (blob, no real-time lights)
const gliderShadow = new THREE.Mesh(
  new THREE.CircleGeometry(1, 16),
  new THREE.MeshBasicMaterial({
    color: 0x1a1a22,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    fog: true,
  })
);
gliderShadow.rotation.x = -Math.PI / 2;
gliderShadow.renderOrder = 1;
gliderShadow.visible = false;
scene.add(gliderShadow);

const _shadowPos = new THREE.Vector3();
const _lightDir = new THREE.Vector3();

function updateGliderShadow() {
  if (!running && !ended) {
    gliderShadow.visible = false;
    return;
  }
  const sunDir = sunGroup.userData.dir;
  if (!sunDir) {
    gliderShadow.visible = false;
    return;
  }

  // Light rays travel from sun toward ground
  _lightDir.copy(sunDir).negate();
  if (_lightDir.y >= -0.05) {
    // Sun too low / night — flatten under plane
    _lightDir.set(0.15, -0.98, 0.1).normalize();
  }

  // Prefer render-interpolated pose when flying (smoother shadow)
  const px = gliderMesh.visible || running ? gliderMesh.position.x : physics.position.x;
  const py = gliderMesh.visible || running ? gliderMesh.position.y : physics.position.y;
  const pz = gliderMesh.visible || running ? gliderMesh.position.z : physics.position.z;
  const groundY = terrainHeight(px, pz);
  const agl = Math.max(0.5, py - groundY);

  // Project along light onto ground plane y ≈ groundY (one iteration with height sample)
  let t = agl / Math.max(0.08, -_lightDir.y);
  t = Math.min(t, 120); // cap stretch when sun is low
  _shadowPos.set(
    px + _lightDir.x * t,
    0,
    pz + _lightDir.z * t
  );
  _shadowPos.y = terrainHeight(_shadowPos.x, _shadowPos.z) + 0.12;

  gliderShadow.position.copy(_shadowPos);
  // Slight scale with altitude (softer/larger high up) + stretch with sun angle
  const stretch = 1 + t * 0.012;
  const base = 4.5 + Math.min(14, agl * 0.045);
  gliderShadow.scale.set(base * stretch, base / Math.sqrt(stretch), 1);
  // Fade when very high
  gliderShadow.material.opacity = THREE.MathUtils.clamp(0.32 - agl * 0.00035, 0.06, 0.32);
  gliderShadow.visible = true;
}

// Minimal lighting (MeshBasic materials dominate; lights only for any lambert leftovers)
scene.add(new THREE.AmbientLight(0xffffff, 1));

// —— World (infinite chunked terrain) ——
const terrain = createTerrain(scene);
const thermals = new ThermalSystem(scene, terrainHeight);
const clouds = new CloudSystem(scene, { count: 28, radius: 850 });
const ridgeVapor = new RidgeVaporSystem(scene);

// Home runway (flat strip + markings) — airfield scenarios only
const runwayGroup = createRunway(scene);
initScenarioVisuals(scene);

// Launch marker at ridge end of runway
const launchPadGroup = new THREE.Group();
{
  const padGeo = new THREE.CylinderGeometry(5, 5.5, 0.3, 8);
  const pad = new THREE.Mesh(padGeo, new THREE.MeshBasicMaterial({ color: 0xd8d8de }));
  pad.position.set(0, RUNWAY.y + 0.14, RUNWAY.z + RUNWAY.halfLength - 8);
  launchPadGroup.add(pad);
  const padEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(padGeo, 15),
    new THREE.LineBasicMaterial({ color: 0x2a2a30 })
  );
  padEdges.position.copy(pad.position);
  launchPadGroup.add(padEdges);
  scene.add(launchPadGroup);
}

/**
 * Apply terrain profile for a scenario (rebuilds chunks, toggles runway/thermals).
 * Height model is set first so spawn() can sample correct ground.
 * @param {string} scenarioId
 * @param {THREE.Vector3} [around]
 */
function applyScenarioWorld(scenarioId, around) {
  const profile = profileForScenario(scenarioId);
  setTerrainProfile(profile);
  const pos = around || new THREE.Vector3(0, 120, 0);
  terrain.world.rebuild(pos);

  const isAirfield = profile === 'airfield';
  if (runwayGroup) runwayGroup.visible = isAirfield;
  launchPadGroup.visible = isAirfield;
  // Thermals only over the inland field world; vapour only on coastal ridge
  thermals.group.visible = isAirfield;
  ridgeVapor.setVisible(!isAirfield);
  if (!isAirfield) ridgeVapor.seedAround(pos);

  // Concept-art white fog; coastal slightly cooler
  if (profile === 'coastal') {
    scene.fog.color.set(0xe2ebf2);
    scene.fog.near = 400;
    scene.fog.far = 2100;
    renderer.setClearColor(0xe8eef4);
  } else {
    scene.fog.color.set(0xe8eef2);
    scene.fog.near = 420;
    scene.fog.far = 1950;
    renderer.setClearColor(0xeef2f5);
  }
}

/** Set height model, then spawn (spawn samples terrainHeight). */
function spawnForActiveScenario() {
  const sc = getActiveScenario();
  setTerrainProfile(profileForScenario(sc.id));
  return sc.spawn();
}

/** 3D wind for physics (ambient + ridge + thermals). */
function sampleWindForPhysics(x, y, z, out) {
  return sampleWind(x, y, z, thermals.group.visible ? thermals : null, out);
}

// —— Glider ——
const gliderMesh = createGlider();
scene.add(gliderMesh);
const physics = new GliderPhysics();

// —— Camera ——
// 0 = cockpit (default, concept look), 1 = chase, 2 = far
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.08, 3500);
let cameraMode = 0;

const camPos = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _lookYawQ = new THREE.Quaternion();
const _lookPitchQ = new THREE.Quaternion();

/**
 * Sticky look pad (keys 1–9) — body-relative yaw/pitch (rad).
 *   7 left+up    8 up       9 right+up
 *   4 left       5 forward  6 right
 *   1 left+down  2 down     3 right+down
 * yaw: + = look left; pitch: + = look up
 */
const LOOK_PAD = {
  5: { yaw: 0, pitch: 0 },
  4: { yaw: Math.PI * 0.5, pitch: 0 },
  6: { yaw: -Math.PI * 0.5, pitch: 0 },
  8: { yaw: 0, pitch: 0.72 },
  2: { yaw: 0, pitch: -0.55 },
  7: { yaw: Math.PI * 0.42, pitch: 0.48 },
  9: { yaw: -Math.PI * 0.42, pitch: 0.48 },
  1: { yaw: Math.PI * 0.55, pitch: -0.35 },
  3: { yaw: -Math.PI * 0.55, pitch: -0.35 },
};

let lookYaw = 0;
let lookPitch = 0;
const _tmpCam = new THREE.Vector3();

/** Cockpit eye from a pose (use render-interpolated pose to avoid jitter). */
function cockpitEyeFromPose(pos, quat, out) {
  _fwd.set(0, 0, -1).applyQuaternion(quat);
  _up.set(0, 1, 0).applyQuaternion(quat);
  out.copy(pos).addScaledVector(_up, 0.45).addScaledVector(_fwd, 0.08);
  return out;
}

function updateCamera(dt, renderPos, renderQuat) {
  const pos = renderPos || physics.position;
  const quat = renderQuat || physics.quaternion;

  _fwd.set(0, 0, -1).applyQuaternion(quat);
  _up.set(0, 1, 0).applyQuaternion(quat);
  _right.set(1, 0, 0).applyQuaternion(quat);

  // —— WebXR: rig follows glider; headset provides look ——
  if (isXRPresenting()) {
    setCockpitOverlayVisible(false);
    // Menu / title: hard-hide entire glider (cockpit must not occlude UI)
    const menuMode = isVRMenuVisible() || !running;
    if (menuMode) {
      gliderMesh.visible = false;
      gliderMesh.traverse((o) => {
        if (o.isMesh || o.isLineSegments || o.isPoints) o.visible = false;
      });
    } else {
      gliderMesh.visible = true;
      // Restore mesh visibility after menu hide
      gliderMesh.traverse((o) => {
        if (o.isMesh || o.isLineSegments || o.isPoints) o.visible = true;
      });
      const external = physics.rolling || physics.wingStrike || cameraMode !== 0;
      if (external) {
        setCockpitVisible(gliderMesh, false);
      } else {
        setCockpitVisible(gliderMesh, true);
      }
    }
    // Eye: use a neutral seated pose when menu is up so UI sits cleanly ahead
    if (menuMode) {
      camPos.copy(pos);
      _up.set(0, 1, 0).applyQuaternion(quat);
      _fwd.set(0, 0, -1).applyQuaternion(quat);
      camPos.addScaledVector(_up, 0.45).addScaledVector(_fwd, 0.05);
    } else {
      cockpitEyeFromPose(pos, quat, camPos);
    }
    updateXRRig(camPos, quat);
    return;
  }

  // Smooth head toward selected look pad direction
  const pad = LOOK_PAD[controls.lookDir] || LOOK_PAD[5];
  const lookLag = 1 - Math.exp(-10 * dt);
  lookYaw += (pad.yaw - lookYaw) * lookLag;
  lookPitch += (pad.pitch - lookPitch) * lookLag;
  const lookingAway = Math.abs(lookYaw) > 0.12 || Math.abs(lookPitch) > 0.12;

  // Ground roll / wing-strike cartwheel: show glider + chase cam
  const rolling = physics.rolling || physics.wingStrike;
  const mode = rolling ? 1 : cameraMode;

  if (mode === 0) {
    // First-person: 3D cockpit tub; hide 2D SVG coaming (avoids double drawing)
    setCockpitVisible(gliderMesh, true);
    gliderMesh.visible = true;
    setCockpitOverlayVisible(false);

    cockpitEyeFromPose(pos, quat, camPos);

    _lookDir.copy(_fwd);
    _lookYawQ.setFromAxisAngle(_up, lookYaw);
    _lookDir.applyQuaternion(_lookYawQ);
    _right.set(1, 0, 0).applyQuaternion(quat).applyQuaternion(_lookYawQ);
    _lookPitchQ.setFromAxisAngle(_right, lookPitch);
    _lookDir.applyQuaternion(_lookPitchQ);

    camTarget.copy(camPos).addScaledVector(_lookDir, 100);
    if (!lookingAway) camTarget.addScaledVector(_up, -0.05);

    camera.position.copy(camPos);
    camera.up.copy(_up);
    camera.lookAt(camTarget);
    camera.near = 0.08;
    camera.far = Math.max(camera.far || 3000, 3000);
    camera.fov = lookingAway ? 75 : 62;
    camera.updateProjectionMatrix();
  } else if (mode === 1) {
    gliderMesh.visible = true;
    setCockpitVisible(gliderMesh, false);
    setCockpitOverlayVisible(false);
    const back = rolling ? -14 : -10;
    const up = rolling ? 4.5 : 2.8;
    // Frame-rate independent chase lag (slightly stickier at low FPS for smoothness)
    const chaseLag = 1 - Math.exp(-(rolling ? 4 : 6) * dt);
    const desired = _tmpCam
      .copy(pos)
      .addScaledVector(_fwd, back)
      .addScaledVector(_up, up)
      .add(new THREE.Vector3(0, rolling ? 2.5 : 1.2, 0));
    camPos.lerp(desired, chaseLag);
    camTarget
      .copy(pos)
      .addScaledVector(_fwd, rolling ? 16 : 10)
      .addScaledVector(_up, 0.3);
    camera.position.copy(camPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(camTarget);
    camera.fov = rolling ? 55 : 58;
    camera.updateProjectionMatrix();
  } else {
    gliderMesh.visible = true;
    setCockpitVisible(gliderMesh, false);
    setCockpitOverlayVisible(false);
    const desired = _tmpCam
      .copy(pos)
      .addScaledVector(_fwd, -26)
      .add(new THREE.Vector3(0, 14, 0));
    camPos.lerp(desired, 1 - Math.exp(-3 * dt));
    camTarget.copy(pos);
    camera.position.copy(camPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(camTarget);
    camera.fov = 55;
    camera.updateProjectionMatrix();
  }
}

// —— Game state ——
let running = false;
let ended = false;

async function startFlight() {
  await flightAudio.ensureStarted();
  hideCrashFx();
  const sc = getActiveScenario();
  // Height model first, then spawn AGL, then rebuild chunks around spawn
  const spawn = spawnForActiveScenario();
  applyScenarioWorld(sc.id, spawn.position);
  physics.reset(spawn);
  if (sc.onStart) sc.onStart(physics);
  // Gear default per scenario
  controls.gear = sc.gear !== undefined ? sc.gear : 1;
  if (gliderMesh.userData.surfaces) {
    gliderMesh.userData.surfaces.gear = controls.gear;
  }
  setScenarioVisualMode(sc.id);
  gliderMesh.position.copy(physics.position);
  gliderMesh.quaternion.copy(physics.quaternion);
  _renderPos.copy(physics.position);
  _renderQuat.copy(physics.quaternion);
  _physPrevPos.copy(physics.position);
  _physPrevQuat.copy(physics.quaternion);
  _hasPhysPrev = false;
  accumulator = 0;
  cameraMode = 0; // always begin in cockpit; C cycles chase/far
  resetLook();
  lookYaw = 0;
  lookPitch = 0;
  gliderMesh.visible = false;
  setCockpitOverlayVisible(false);
  camPos.copy(physics.position).add(new THREE.Vector3(0, 0.5, 0.3));
  clouds.seedAround(physics.position);
  terrain.world.update(physics.position, true);
  running = true;
  ended = false;
  showHUD();
  showCoachTip(coachForScenario(sc.id), 12);
  savePrefs({ scenarioId: sc.id });
  setXRFlying(true);
  hideVRMenu();
}

function endFlight() {
  running = false;
  ended = true;
  gliderMesh.visible = true;
  setCockpitOverlayVisible(false);
  cameraMode = 1;

  if (physics.landingQuality === 'crash') {
    // Crash: SFX + tunnel vision → black → menu after 3s
    flightAudio.playCrash();
    flightAudio.stop();
    beginCrashSequence(physics);
  } else {
    // Roll-out complete: stop roll noise, hold chase view 3s, then menu
    flightAudio.stop();
    beginLandingHold(physics);
  }
}

/** Post landing/crash: back to scenario picker (not instant relaunch). */
function returnToScenarioMenu() {
  running = false;
  ended = false;
  flightAudio.stop();
  hideCrashFx();
  setCockpitOverlayVisible(false);
  showTitle();
  setXRFlying(false);
  if (isXRPresenting()) {
    // Keep glider hidden while VR menu is up
    gliderMesh.visible = false;
    showVRMenu();
  } else {
    gliderMesh.visible = true;
  }
  const sc = getActiveScenario();
  const sp = spawnForActiveScenario();
  applyScenarioWorld(sc.id, sp.position);
  physics.reset(sp);
  gliderMesh.position.copy(physics.position);
  gliderMesh.quaternion.copy(physics.quaternion);
}

initInput();
initCockpitOverlay();

function previewScenario(id) {
  setActiveScenario(id);
  savePrefs({ scenarioId: id });
  setXRMenuScenarios(
    SCENARIO_LIST.map((s) => ({ id: s.id, name: s.name })),
    id
  );
  const sc = getActiveScenario();
  const sp = spawnForActiveScenario();
  applyScenarioWorld(sc.id, sp.position);
  physics.reset(sp);
  gliderMesh.position.copy(physics.position);
  gliderMesh.quaternion.copy(physics.quaternion);
  if (!isXRPresenting()) {
    camera.position.copy(sp.position).add(new THREE.Vector3(40, 80, 120));
    camera.lookAt(sp.position);
  }
}

// WebXR — grab cockpit stick/levers + world-space menu
initXR({
  renderer,
  scene,
  camera,
  buttonHost: document.getElementById('vr-button-host') || document.body,
  glider: gliderMesh,
  scenarios: SCENARIO_LIST.map((s) => ({ id: s.id, name: s.name })),
  activeScenarioId: getActiveScenario().id,
  onSelectScenario: (id) => previewScenario(id),
  onLaunch: () => {
    startFlight();
  },
  onExitToMenu: () => {
    returnToScenarioMenu();
  },
});
setXRGlider(gliderMesh);

// Restore prefs (scenario + options)
{
  const prefs = loadPrefs();
  if (prefs.scenarioId) setActiveScenario(prefs.scenarioId);
  flightAudio.setMasterVolume(getVolume());
  setInvertPitch(!!prefs.invertPitch);
  setXRMenuScenarios(
    SCENARIO_LIST.map((s) => ({ id: s.id, name: s.name })),
    getActiveScenario().id
  );
  // Wire options UI
  const volEl = document.getElementById('pref-volume');
  const unitsEl = document.getElementById('pref-units');
  const invEl = document.getElementById('pref-invert-pitch');
  if (volEl) {
    volEl.value = String(Math.round(getVolume() * 100));
    volEl.addEventListener('input', () => {
      const v = Number(volEl.value) / 100;
      flightAudio.setMasterVolume(v);
      savePrefs({ volume: v });
    });
  }
  if (unitsEl) {
    unitsEl.value = prefs.units === 'kt' ? 'kt' : 'kmh';
    unitsEl.addEventListener('change', () => {
      savePrefs({ units: unitsEl.value === 'kt' ? 'kt' : 'kmh' });
    });
  }
  if (invEl) {
    invEl.checked = !!prefs.invertPitch;
    invEl.addEventListener('change', () => {
      setInvertPitch(invEl.checked);
      savePrefs({ invertPitch: invEl.checked });
    });
  }
}
setupScenarioMenu(SCENARIO_LIST, getActiveScenario().id, (id) => {
  previewScenario(id);
});
// Initial world matches active scenario (prefs-aware)
{
  const sc = getActiveScenario();
  const sp = spawnForActiveScenario();
  applyScenarioWorld(sc.id, sp.position);
  physics.reset(sp);
  gliderMesh.position.copy(physics.position);
  gliderMesh.quaternion.copy(physics.quaternion);
}
onStart(() => { startFlight(); });
onRestart(() => { returnToScenarioMenu(); });

window.addEventListener('resize', () => {
  if (isXRPresenting()) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
let accumulator = 0;
const FIXED_DT = 1 / 60;
const MAX_PHYS_STEPS = 5;

// Fixed-step render interpolation (kills mesh/camera jitter at ~30 FPS)
const _physPrevPos = new THREE.Vector3();
const _physPrevQuat = new THREE.Quaternion();
const _renderPos = new THREE.Vector3();
const _renderQuat = new THREE.Quaternion();
let _hasPhysPrev = false;

function tick(_time, frame) {
  // Cap spike frames; keep enough for 20–30 FPS catch-up without spiral-of-death
  const frameDt = Math.min(clock.getDelta(), 0.08);

  updateInput();
  // XR grab stick/levers + thumbstick fallback (after keyboard)
  updateXRControls(frameDt);

  // M: return to scenario menu (in flight, after landing, or during result hold)
  if (controls.menu && (running || ended)) {
    returnToScenarioMenu();
  }

  // R / XR B-Y: release winch/tow if attached; else restart; after landing → menu
  if (controls.restart && !isResultHoldActive()) {
    if (ended) {
      returnToScenarioMenu();
    } else if (running) {
      if (isLaunchAttached()) {
        releaseLaunch(physics);
      } else {
        startFlight();
      }
    }
  }
  if (controls.cameraToggle && running && !physics.rolling && !physics.wingStrike) {
    cameraMode = (cameraMode + 1) % 3;
    savePrefs({ cameraMode });
  }

  // Crash FX or post-roll hold → menu after 3s
  if (ended) updateCrashSequence(frameDt);

  if (running) {
    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_PHYS_STEPS) {
      // Snapshot before this step — used to interpolate the last incomplete interval
      _physPrevPos.copy(physics.position);
      _physPrevQuat.copy(physics.quaternion);
      _hasPhysPrev = true;

      physics.update(
        FIXED_DT,
        controls,
        terrainHeight,
        sampleWindForPhysics
      );
      // Winch / tow cable tension after free aero integrate
      const sc = getActiveScenario();
      if (sc.update) sc.update(physics, FIXED_DT, controls);
      accumulator -= FIXED_DT;
      steps++;
    }
    // Spiral-of-death: drop backlog but keep a fractional remainder for smooth lerp
    if (steps >= MAX_PHYS_STEPS && accumulator > FIXED_DT) {
      accumulator = accumulator % FIXED_DT;
    }

    // Blend between last completed physics state and current (alpha = leftover time)
    const alpha = _hasPhysPrev
      ? Math.min(1, Math.max(0, accumulator / FIXED_DT))
      : 1;
    if (_hasPhysPrev && steps > 0) {
      _renderPos.lerpVectors(_physPrevPos, physics.position, alpha);
      _renderQuat.copy(_physPrevQuat).slerp(physics.quaternion, alpha);
    } else {
      _renderPos.copy(physics.position);
      _renderQuat.copy(physics.quaternion);
    }

    gliderMesh.position.copy(_renderPos);
    gliderMesh.quaternion.copy(_renderQuat);
    updateControlSurfaces(gliderMesh, controls, frameDt);
    updateCockpitInstruments(gliderMesh, physics, frameDt);
    if (!isXRPresenting()) updateCockpitOverlay(controls, frameDt);
    if (physics.rolling) {
      // Auto gear down on touchdown for wheel contact
      if (controls.gear < 0.5) controls.gear = 1;
      updateWheelSpin(gliderMesh, physics.airspeed, frameDt);
    }
    // Wing-strike cartwheel: force external view of the spin
    if (physics.wingStrike) {
      gliderMesh.visible = true;
      setCockpitOverlayVisible(false);
    }

    if (controls.gearToggle) {
      flightAudio.notifyGearToggle(controls.gear);
    }

    const onTow =
      scenarioRuntime.phase === 'tow' &&
      !scenarioRuntime.released &&
      isLaunchAttached();
    flightAudio.update(frameDt, {
      airspeed: physics.airspeed,
      vario: physics.rolling ? 0 : physics.vario,
      stalled: physics.stalled,
      aoa: physics.aoa,
      thermalLift: physics.thermalLift,
      coastal: getTerrainProfile() === 'coastal',
      liftMode: getTerrainProfile() === 'coastal' ? 'uplift' : 'thermal',
      onRunway: physics.onRunway,
      alive: physics.alive,
      rolling: physics.rolling,
      brakes: controls.brakes,
      gear: controls.gear,
      gearPos: gliderMesh.userData?.surfaces?.gear ?? controls.gear,
      ropeTension: onTow ? scenarioRuntime.ropeTension || 0 : 0,
      ropeOsc: onTow ? scenarioRuntime.ropeOsc || 0 : 0,
      onTow,
    });

    updateScenarioVisuals(getActiveScenario().id, physics, frameDt);

    // Rolling ends when stopped → 3s hold then menu
    if (!physics.alive) {
      // Finalize scores before leaving the sim loop
      if (scenarioRuntime.sandboxActive && !scenarioRuntime.sandboxScored) {
        scenarioRuntime.sandboxScore = scoreSandbox(physics);
        scenarioRuntime.sandboxScored = true;
        // Also grade the arrival itself
        if (!scenarioRuntime.landScored) {
          scenarioRuntime.landScore = scoreLanding(physics);
          scenarioRuntime.landScored = true;
          if (scenarioRuntime.landScore?.grade) {
            physics.landingQuality = scenarioRuntime.landScore.grade;
          }
        }
      } else if (!scenarioRuntime.landScored && !scenarioRuntime.xcActive) {
        // Landing scenario or other free-flight arrival
        scenarioRuntime.landScore = scoreLanding(physics);
        scenarioRuntime.landScored = true;
        if (scenarioRuntime.landScore?.grade) {
          physics.landingQuality = scenarioRuntime.landScore.grade;
        }
      }
      if (scenarioRuntime.xcActive && !scenarioRuntime.xcScored) {
        scenarioRuntime.xcScore = scoreCrossCountry(physics);
        scenarioRuntime.xcScored = true;
      }
      endFlight();
    }
  } else {
    flightAudio.update(frameDt, null);
  }

  thermals.update(frameDt);

  // Stream terrain well ahead — prioritize flight direction for horizon fill
  const followPos = running || ended ? _renderPos : camera.position;
  if (running || ended) {
    _fwd.set(0, 0, -1).applyQuaternion(_renderQuat);
  } else {
    _fwd.set(0, 0, -1).applyQuaternion(physics.quaternion);
  }
  terrain.world.update(followPos, false, running ? _fwd : null);

  // Clouds follow pilot for motion parallax
  clouds.update(frameDt, followPos, running ? _fwd : null);

  // Ridge vapour — throttle particle integrate when FPS is low (visual only)
  ridgeVapor.update(frameDt, followPos, frameDt > 0.028);

  updateCamera(frameDt, running || ended ? _renderPos : null, running || ended ? _renderQuat : null);
  updateSun(camera);
  updateGliderShadow();

  if (running || ended) updateHUD(physics, frameDt);

  // WebXR: pass XRFrame when presenting (Three uses it for poses)
  renderer.render(scene, camera);
}

// Title-screen cam: overlooking home runway
{
  camera.position.set(80, RUNWAY.y + 70, RUNWAY.z + 120);
  camera.lookAt(RUNWAY.x, RUNWAY.y, RUNWAY.z);
  camPos.copy(camera.position);
  clouds.seedAround(camera.position);
  updateSun(camera);
}

showTitle();
// WebXR-compatible loop (also drives desktop frames)
renderer.setAnimationLoop(tick);

window.__glider = { physics, scene, camera, terrain, gliderMesh, getActiveScenario, scenarioRuntime, isXRPresenting };
