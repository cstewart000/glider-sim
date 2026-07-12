/**
 * Lightweight props for scenarios (winch, tow plane).
 */

import * as THREE from 'three';
import { fillMaterial, lineMaterial } from './styleUtil.js';
import { RUNWAY } from './runway.js';
import { scenarioRuntime } from './scenarios.js';

let root = null;
let towPlane = null;
let cableLine = null;
let winchHouse = null;

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

  // Cable line (updated each frame during winch)
  const cableGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(),
    new THREE.Vector3(0, 10, -10),
  ]);
  cableLine = new THREE.Line(
    cableGeo,
    new THREE.LineBasicMaterial({ color: 0x44444a, transparent: true, opacity: 0.65 })
  );
  cableLine.visible = false;
  cableLine.frustumCulled = false;
  root.add(cableLine);

  // Simple tow plane (low poly)
  towPlane = new THREE.Group();
  const fus = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.45, 4, 6),
    fillMaterial({ color: 0xf0f0f4 })
  );
  fus.rotation.z = Math.PI / 2;
  fus.rotation.y = Math.PI / 2;
  towPlane.add(fus);
  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(8, 0.12, 1.2),
    fillMaterial({ color: 0xe8e8ee })
  );
  wing.position.y = 0.2;
  towPlane.add(wing);
  const ttail = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 1.2, 0.8),
    fillMaterial({ color: 0xe8e8ee })
  );
  ttail.position.set(0, 0.6, 1.8);
  towPlane.add(ttail);
  towPlane.visible = false;
  root.add(towPlane);

  return root;
}

export function setScenarioVisualMode(id) {
  if (!root) return;
  winchHouse.visible = id === 'cable';
  cableLine.visible = false;
  towPlane.visible = false;
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
    const arr = cableLine.geometry.attributes.position.array;
    arr[0] = nose.x;
    arr[1] = nose.y;
    arr[2] = nose.z;
    arr[3] = winchPt.x;
    arr[4] = winchPt.y;
    arr[5] = winchPt.z;
    cableLine.geometry.attributes.position.needsUpdate = true;
  } else {
    cableLine.visible = false;
  }

  if (id === 'tow' && scenarioRuntime.phase === 'tow' && !scenarioRuntime.released) {
    towPlane.visible = true;
    const t = scenarioRuntime.t;
    towPlane.position.set(
      0,
      RUNWAY.y + 45 + t * 11,
      RUNWAY.z + 20 - t * 32
    );
    // Face flight direction (−Z-ish climb)
    towPlane.rotation.set(0.12, 0, 0);
    // Tow rope
    cableLine.visible = true;
    const arr = cableLine.geometry.attributes.position.array;
    arr[0] = physics.position.x;
    arr[1] = physics.position.y;
    arr[2] = physics.position.z;
    arr[3] = towPlane.position.x;
    arr[4] = towPlane.position.y - 0.3;
    arr[5] = towPlane.position.z + 2;
    cableLine.geometry.attributes.position.needsUpdate = true;
  } else if (id !== 'cable') {
    towPlane.visible = false;
    if (id !== 'cable') cableLine.visible = false;
  }
}
