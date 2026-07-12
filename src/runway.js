/**
 * Home airfield runway — grey landing strip + markings.
 * Sits clearly above the flattened terrain pad.
 */

import * as THREE from 'three';

/** World-space runway definition */
export const RUNWAY = {
  // Center of strip
  x: 0,
  z: -40,
  // Half-extents
  halfWidth: 14,
  halfLength: 170, // total ~340 m
  // Surface height (absolute) — must match terrain flatten RW_Y
  y: 92,
  // Heading: strip runs parallel to world Z (long axis)
  // Touchdown zone near +z end, roll toward −z
};

export function isOnRunway(x, z, margin = 2) {
  const dx = Math.abs(x - RUNWAY.x);
  const dz = Math.abs(z - RUNWAY.z);
  return dx <= RUNWAY.halfWidth + margin && dz <= RUNWAY.halfLength + margin;
}

/** Flatten factor 0..1 near runway for terrainHeight blending */
export function runwayFlatten(x, z) {
  const dx = Math.abs(x - RUNWAY.x) / (RUNWAY.halfWidth + 18);
  const dz = Math.abs(z - RUNWAY.z) / (RUNWAY.halfLength + 25);
  const nx = Math.min(1, dx);
  const nz = Math.min(1, dz);
  const t = Math.max(nx, nz);
  if (t >= 1) return 0;
  const hard =
    Math.abs(x - RUNWAY.x) <= RUNWAY.halfWidth &&
    Math.abs(z - RUNWAY.z) <= RUNWAY.halfLength
      ? 1
      : 0;
  if (hard) return 1;
  return Math.max(0, 0.85 * (1 - t) * (1 - t));
}

function deckMat(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    transparent: opacity < 1,
    opacity,
    depthWrite: true,
    // Pull deck above terrain to avoid z-fight / burial by LOD tris
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

export function createRunway(scene) {
  const group = new THREE.Group();
  group.name = 'runway';

  const L = RUNWAY.halfLength * 2;
  const W = RUNWAY.halfWidth * 2;
  // Clearance above flattened terrain (terrain pad is ~RW_Y - 0.12)
  const y = RUNWAY.y + 0.45;

  // Main grey asphalt deck
  const asphalt = new THREE.Mesh(
    new THREE.PlaneGeometry(W, L, 1, 1),
    deckMat(0x6a6a70)
  );
  asphalt.rotation.x = -Math.PI / 2;
  asphalt.position.set(RUNWAY.x, y, RUNWAY.z);
  asphalt.renderOrder = 2;
  group.add(asphalt);

  // Slightly darker shoulders (still grey)
  const shoulderMat = deckMat(0x5a5a60);
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, L * 0.98, 1, 1),
      shoulderMat
    );
    shoulder.rotation.x = -Math.PI / 2;
    shoulder.position.set(
      RUNWAY.x + side * (RUNWAY.halfWidth + 1.4),
      y - 0.02,
      RUNWAY.z
    );
    shoulder.renderOrder = 2;
    group.add(shoulder);
  }

  // White edge lines
  const edgeMat = deckMat(0xe8e8ec);
  for (const side of [-1, 1]) {
    const edge = new THREE.Mesh(
      new THREE.PlaneGeometry(0.55, L * 0.96, 1, 1),
      edgeMat
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.set(RUNWAY.x + side * (RUNWAY.halfWidth - 0.7), y + 0.03, RUNWAY.z);
    edge.renderOrder = 3;
    group.add(edge);
  }

  // Centerline dashes
  const dashLen = 10;
  const gap = 8;
  const dashMat = deckMat(0xf0f0f4);
  let z = RUNWAY.z - RUNWAY.halfLength + 12;
  const zEnd = RUNWAY.z + RUNWAY.halfLength - 12;
  while (z < zEnd) {
    const dash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, dashLen, 1, 1),
      dashMat
    );
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(RUNWAY.x, y + 0.04, z + dashLen * 0.5);
    dash.renderOrder = 3;
    group.add(dash);
    z += dashLen + gap;
  }

  // Threshold bars (both ends)
  const threshMat = deckMat(0xffffff);
  for (const end of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const bar = new THREE.Mesh(
        new THREE.PlaneGeometry(1.15, 9, 1, 1),
        threshMat
      );
      bar.rotation.x = -Math.PI / 2;
      const bx = RUNWAY.x - RUNWAY.halfWidth + 2.2 + i * 3.4;
      const bz = RUNWAY.z + end * (RUNWAY.halfLength - 16);
      bar.position.set(bx, y + 0.045, bz);
      bar.renderOrder = 3;
      group.add(bar);
    }
  }

  // Threshold markers (simple blocks)
  const numMat = deckMat(0xffffff);
  const n1 = new THREE.Mesh(new THREE.PlaneGeometry(7, 11, 1, 1), numMat);
  n1.rotation.x = -Math.PI / 2;
  n1.position.set(RUNWAY.x, y + 0.05, RUNWAY.z + RUNWAY.halfLength - 32);
  n1.renderOrder = 3;
  group.add(n1);
  const n2 = new THREE.Mesh(new THREE.PlaneGeometry(7, 11, 1, 1), numMat);
  n2.rotation.x = -Math.PI / 2;
  n2.rotation.z = Math.PI;
  n2.position.set(RUNWAY.x, y + 0.05, RUNWAY.z - RUNWAY.halfLength + 32);
  n2.renderOrder = 3;
  group.add(n2);

  // Windsock near strip
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.15, 6, 5),
    new THREE.MeshBasicMaterial({ color: 0x55555c })
  );
  pole.position.set(RUNWAY.halfWidth + 10, y + 3, RUNWAY.z + RUNWAY.halfLength - 24);
  group.add(pole);
  const sock = new THREE.Mesh(
    new THREE.ConeGeometry(0.7, 2.2, 5),
    new THREE.MeshBasicMaterial({ color: 0xe85d3a })
  );
  sock.rotation.z = Math.PI / 2;
  sock.position.set(RUNWAY.halfWidth + 11.5, y + 5.5, RUNWAY.z + RUNWAY.halfLength - 24);
  group.add(sock);

  // Outline
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, L, 1, 1), 1),
    new THREE.LineBasicMaterial({ color: 0x2a2a30 })
  );
  outline.rotation.x = -Math.PI / 2;
  outline.position.set(RUNWAY.x, y + 0.06, RUNWAY.z);
  outline.renderOrder = 4;
  group.add(outline);

  scene.add(group);
  return group;
}
