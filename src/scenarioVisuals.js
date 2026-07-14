/**
 * Lightweight props for scenarios (winch, tow plane, rope).
 * Tow tug pose/rope metrics come from scenarioRuntime (shared with physics).
 */

import * as THREE from 'three';
import { fillMaterial } from './styleUtil.js';
import { RUNWAY } from './runway.js';
import { scenarioRuntime, XC_WAYPOINTS } from './scenarios.js';
import { terrainHeight } from './terrain.js';

let root = null;
let towPlane = null;
let towProp = null;
let cableLine = null;
let winchHouse = null;
let papiGroup = null;
/** @type {THREE.Mesh[]} */
let papiLights = [];
/** @type {THREE.Group | null} */
let xcMarkers = null;

const ROPE_SEGS = 10;
const _sag = new THREE.Vector3();
const _mid = new THREE.Vector3();

export function initScenarioVisuals(scene) {
  root = new THREE.Group();
  root.name = 'scenarioVisuals';
  scene.add(root);

  // Winch hut at far end of strip
  winchHouse = new THREE.Group();
  const hut = new THREE.Mesh(
    new THREE.BoxGeometry(6, 3, 4),
    fillMaterial({ color: 0xe8e8ec })
  );
  hut.position.y = 1.5;
  winchHouse.add(hut);
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(4.5, 2, 4),
    fillMaterial({ color: 0xd0d0d6 })
  );
  roof.position.y = 4;
  roof.rotation.y = Math.PI / 4;
  winchHouse.add(roof);
  winchHouse.position.set(0, RUNWAY.y, RUNWAY.z - RUNWAY.halfLength - 70);
  winchHouse.visible = false;
  root.add(winchHouse);

  // Multi-segment rope (sag when slack; tension recolors)
  const ropePositions = new Float32Array((ROPE_SEGS + 1) * 3);
  const cableGeo = new THREE.BufferGeometry();
  cableGeo.setAttribute('position', new THREE.BufferAttribute(ropePositions, 3));
  cableLine = new THREE.Line(
    cableGeo,
    new THREE.LineBasicMaterial({
      color: 0x55555c,
      transparent: true,
      opacity: 0.75,
      linewidth: 1,
    })
  );
  cableLine.visible = false;
  cableLine.frustumCulled = false;
  root.add(cableLine);

  // Low-poly tow plane
  towPlane = buildTowPlane();
  towPlane.visible = false;
  root.add(towPlane);

  // PAPI (approach slope lights) — left of threshold
  papiGroup = buildPapi();
  papiGroup.visible = false;
  root.add(papiGroup);

  // XC turnpoint markers (pylons + ring)
  xcMarkers = buildXcMarkers();
  xcMarkers.visible = false;
  root.add(xcMarkers);

  return root;
}

function buildXcMarkers() {
  const g = new THREE.Group();
  g.name = 'xcMarkers';
  const mat = fillMaterial({ color: 0xe8d48a });
  const matActive = fillMaterial({ color: 0xf0c040 });
  const matDone = fillMaterial({ color: 0x88c0a0 });

  XC_WAYPOINTS.forEach((wp, i) => {
    const y = terrainHeight(wp.x, wp.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.8, 28, 6), mat);
    pole.position.set(wp.x, y + 14, wp.z);
    g.add(pole);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(4, 8, 6), mat);
    ball.position.set(wp.x, y + 30, wp.z);
    g.add(ball);
    // Ground ring (cylinder outline feel)
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(wp.r * 0.35, 1.2, 4, 24),
      mat
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(wp.x, y + 1.5, wp.z);
    g.add(ring);
    pole.userData.wpIndex = i;
    ball.userData.wpIndex = i;
    ring.userData.wpIndex = i;
    pole.userData.matIdle = mat;
    pole.userData.matActive = matActive;
    pole.userData.matDone = matDone;
  });
  g.userData.mats = { mat, matActive, matDone };
  return g;
}

/** Four light boxes beside the approach threshold. */
function buildPapi() {
  const g = new THREE.Group();
  g.name = 'papi';
  const thrZ = RUNWAY.z + RUNWAY.halfLength;
  // Place left of strip, near threshold
  const baseX = RUNWAY.x - RUNWAY.halfWidth - 8;
  const baseY = RUNWAY.y + 0.6;
  const baseZ = thrZ - 12;
  papiLights = [];
  for (let i = 0; i < 4; i++) {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.7, 1.2),
      fillMaterial({ color: 0x3a3a40 })
    );
    box.position.set(baseX, baseY, baseZ - i * 3.2);
    g.add(box);
    // Lit face toward approach (+Z)
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.45, 0.15),
      fillMaterial({ color: 0xf2f2f6 })
    );
    lamp.position.set(0, 0.05, 0.55);
    box.add(lamp);
    papiLights.push(lamp);
  }
  return g;
}

/** Update PAPI colors: whiteCount from left (0=all red … 4=all white). */
export function setPapiLights(whiteCount) {
  const w = Math.max(0, Math.min(4, whiteCount | 0));
  for (let i = 0; i < papiLights.length; i++) {
    const lamp = papiLights[i];
    if (!lamp) continue;
    // Lights ordered from threshold outward; left-to-right in approach view
    // Convention: more white = higher → first w lamps white, rest red
    const isWhite = i < w;
    lamp.material.color.setHex(isWhite ? 0xf4f4f8 : 0xd03028);
  }
}

function buildTowPlane() {
  const g = new THREE.Group();
  g.name = 'towPlane';
  const white = fillMaterial({ color: 0xf2f2f6 });
  const off = fillMaterial({ color: 0xe0e0e6 });
  const dark = fillMaterial({ color: 0x3a3a42 });
  const accent = fillMaterial({ color: 0xe85d3a });

  // Fuselage
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 5.2, 6), white);
  fus.rotation.z = Math.PI / 2;
  fus.rotation.y = Math.PI / 2;
  g.add(fus);
  // Nose
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.1, 6), white);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -3.0;
  g.add(nose);
  // Prop disc (spins)
  towProp = new THREE.Mesh(
    new THREE.CircleGeometry(0.85, 12),
    fillMaterial({ color: 0xc8d0d8, transparent: true, opacity: 0.35 })
  );
  towProp.position.z = -3.55;
  g.add(towProp);
  // Spinner
  const spin = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 5), dark);
  spin.position.z = -3.5;
  g.add(spin);

  // Main wing with dihedral (typical high-wing tow plane ~5–7°)
  const DIHEDRAL = (6.5 * Math.PI) / 180;
  const halfSpan = 4.75;
  const wingChord = 1.35;
  const wingThick = 0.12;
  const wingRootY = 0.28;
  const wingZ = -0.2;
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(halfSpan, wingThick, wingChord),
      off
    );
    // Pivot at root: place half-panel outboard, then fold up by dihedral
    panel.position.set(side * (halfSpan * 0.5), 0, 0);
    const wingRoot = new THREE.Group();
    wingRoot.position.set(0, wingRootY, wingZ);
    wingRoot.rotation.z = side * DIHEDRAL;
    wingRoot.add(panel);
    g.add(wingRoot);
    // Wing tip (slightly rounded look)
    const tip = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, wingThick * 0.9, wingChord * 0.85),
      accent
    );
    tip.position.set(side * (halfSpan - 0.08), 0, 0);
    wingRoot.add(tip);
  }
  // Cabane / strut to each wing (meets raised panel)
  for (const s of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 0.06), dark);
    const midY = wingRootY + Math.sin(DIHEDRAL) * 1.9 * 0.5;
    strut.position.set(s * 1.9, midY * 0.35 - 0.05, 0.05);
    strut.rotation.z = s * (0.35 + DIHEDRAL);
    g.add(strut);
  }

  // Tail boom already fuselage; empennage
  const hstab = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.08, 0.7), off);
  hstab.position.set(0, 0.15, 2.3);
  g.add(hstab);
  const vstab = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.15, 0.85), off);
  vstab.position.set(0, 0.7, 2.35);
  g.add(vstab);
  // Accent stripe
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.06, 2.2), accent);
  stripe.position.set(0, 0.35, -0.8);
  g.add(stripe);

  // Tow hook stub under tail
  const hook = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.15), dark);
  hook.position.set(0, -0.35, 2.5);
  g.add(hook);

  return g;
}

export function setScenarioVisualMode(id) {
  if (!root) return;
  winchHouse.visible = id === 'cable';
  cableLine.visible = false;
  towPlane.visible = false;
  if (papiGroup) papiGroup.visible = id === 'landing';
  if (xcMarkers) {
    xcMarkers.visible = id === 'crosscountry';
    if (id === 'crosscountry') refreshXcMarkerHeights();
  }
}

/** Place pylons on current airfield height model. */
function refreshXcMarkerHeights() {
  if (!xcMarkers) return;
  const byIndex = new Map();
  xcMarkers.traverse((o) => {
    if (o.userData.wpIndex === undefined) return;
    if (!byIndex.has(o.userData.wpIndex)) byIndex.set(o.userData.wpIndex, []);
    byIndex.get(o.userData.wpIndex).push(o);
  });
  XC_WAYPOINTS.forEach((wp, i) => {
    const y = terrainHeight(wp.x, wp.z);
    const objs = byIndex.get(i) || [];
    for (const o of objs) {
      // poles, balls, rings — restore relative heights
      if (o.geometry?.type === 'CylinderGeometry') o.position.set(wp.x, y + 14, wp.z);
      else if (o.geometry?.type === 'SphereGeometry') o.position.set(wp.x, y + 30, wp.z);
      else if (o.geometry?.type === 'TorusGeometry') o.position.set(wp.x, y + 1.5, wp.z);
    }
  });
}

/**
 * @param {string} id
 * @param {import('./physics.js').GliderPhysics} physics
 * @param {number} dt
 */
export function updateScenarioVisuals(id, physics, dt) {
  if (!root) return;

  if (id === 'cable' && scenarioRuntime.phase === 'winch' && !scenarioRuntime.released) {
    cableLine.visible = true;
    const winchPt = new THREE.Vector3(0, RUNWAY.y + 6, RUNWAY.z - RUNWAY.halfLength - 70);
    const nose = physics.position.clone();
    nose.y -= 0.2;
    setRopePoints(nose, winchPt, 0.15, 0.35); // slight sag
    setRopeColor(0.2);
    towPlane.visible = false;
    return;
  }

  if (id === 'landing' && scenarioRuntime.landingActive) {
    if (papiGroup) papiGroup.visible = true;
    setPapiLights(scenarioRuntime.landPapiWhite ?? 2);
  } else if (papiGroup && id !== 'landing') {
    papiGroup.visible = false;
  }

  if (id === 'crosscountry' && xcMarkers) {
    xcMarkers.visible = true;
    const active = scenarioRuntime.xcDone
      ? -1
      : scenarioRuntime.xcWp;
    const legs = scenarioRuntime.xcLegs || 0;
    const { mat, matActive, matDone } = xcMarkers.userData.mats || {};
    xcMarkers.traverse((o) => {
      if (!o.isMesh || o.userData.wpIndex === undefined) return;
      const i = o.userData.wpIndex;
      if (i < legs) o.material = matDone || o.material;
      else if (i === active) o.material = matActive || o.material;
      else o.material = mat || o.material;
    });
  } else if (xcMarkers && id !== 'crosscountry') {
    xcMarkers.visible = false;
  }

  if (id === 'tow' && scenarioRuntime.phase === 'tow' && !scenarioRuntime.released) {
    towPlane.visible = true;
    towPlane.position.copy(scenarioRuntime.tugPos);
    towPlane.quaternion.copy(scenarioRuntime.tugQuat);
    if (towProp) towProp.rotation.z += dt * 28;

    // Hooks: glider nose → tug tail
    const gHook = physics.position.clone();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(physics.quaternion);
    gHook.addScaledVector(fwd, 2.2);
    gHook.y -= 0.15;

    const tFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(scenarioRuntime.tugQuat);
    const tUp = new THREE.Vector3(0, 1, 0).applyQuaternion(scenarioRuntime.tugQuat);
    const tHook = scenarioRuntime.tugPos
      .clone()
      .addScaledVector(tFwd, -2.4)
      .addScaledVector(tUp, -0.35);

    const slack = scenarioRuntime.ropeSlack ? 1 : 0;
    const sag = slack * Math.min(8, Math.max(0.5, (scenarioRuntime.ropeRest - scenarioRuntime.ropeDist) * 0.35 + 2));
    setRopePoints(gHook, tHook, sag, scenarioRuntime.ropeSlack ? 0.85 : 0.15);
    setRopeColor(scenarioRuntime.ropeTension);
    cableLine.visible = true;
    return;
  }

  towPlane.visible = false;
  if (id !== 'cable') cableLine.visible = false;
}

/**
 * Catenery-ish polyline between a and b.
 * @param {THREE.Vector3} a
 * @param {THREE.Vector3} b
 * @param {number} sagMeters downward sag at mid
 * @param {number} sagShape 0 = taut line, 1 = deep U
 */
function setRopePoints(a, b, sagMeters, sagShape) {
  const pos = cableLine.geometry.attributes.position.array;
  for (let i = 0; i <= ROPE_SEGS; i++) {
    const u = i / ROPE_SEGS;
    _mid.lerpVectors(a, b, u);
    // Parabolic sag
    const s = 4 * u * (1 - u) * sagMeters * sagShape;
    _mid.y -= s;
    pos[i * 3] = _mid.x;
    pos[i * 3 + 1] = _mid.y;
    pos[i * 3 + 2] = _mid.z;
  }
  cableLine.geometry.attributes.position.needsUpdate = true;
  cableLine.geometry.computeBoundingSphere();
}

/** Tension 0..1+ → grey / amber / red */
function setRopeColor(tension01) {
  const t = Math.min(1.15, Math.max(0, tension01));
  const mat = cableLine.material;
  if (t < 0.15) {
    mat.color.setHex(0x6a6a72); // slack grey
    mat.opacity = 0.55;
  } else if (t < 0.55) {
    mat.color.setHex(0x55555c);
    mat.opacity = 0.75;
  } else if (t < 0.85) {
    mat.color.setHex(0xc8a040); // amber load
    mat.opacity = 0.9;
  } else {
    mat.color.setHex(0xd04038); // weak-link danger
    mat.opacity = 1;
  }
}
