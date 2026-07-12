/**
 * Low-poly sailplane for chase cam — dihedral wings, T-tail,
 * red control surfaces that animate with pilot inputs.
 */

import * as THREE from 'three';
import { fillMaterial, lineMaterial } from './styleUtil.js';

const DIHEDRAL = (7 * Math.PI) / 180;
const SPAN = 9.2;
const AILERON_IN = 4.2;   // span start of aileron
const AILERON_OUT = 8.6;

// Max surface deflections (rad)
const MAX_AILERON = 0.42;
const MAX_ELEVATOR = 0.4;
const MAX_RUDDER = 0.45;
const MAX_BRAKE = 0.85;

// Faint control-surface red (readable but soft)
const RED = 0xe8a090;

function addEdges(mesh, threshold = 18) {
  const edges = new THREE.EdgesGeometry(mesh.geometry, threshold);
  const lines = new THREE.LineSegments(edges, lineMaterial(false));
  lines.renderOrder = 2;
  mesh.add(lines);
  return lines;
}

/**
 * Low-poly airfoil panel with a sharp trailing edge.
 * Local frame: +X span, +Z aft (LE → TE), +Y up.
 * Upper/lower skins meet at TE (tTe ≈ 0) so the edge comes to a line.
 *
 * @param {object} p
 * @param {number} p.x0 span start
 * @param {number} p.x1 span end
 * @param {number} p.zLe0 LE z at x0
 * @param {number} p.zLe1 LE z at x1
 * @param {number} p.zTe0 TE z at x0
 * @param {number} p.zTe1 TE z at x1
 * @param {number} [p.tLe] thickness at LE
 * @param {number} [p.tTe] thickness at TE (0 = knife edge)
 * @param {number} [p.segs] span segments
 */
function makeSharpTePanel({
  x0, x1, zLe0, zLe1, zTe0, zTe1,
  tLe = 0.09, tTe = 0.0, segs = 5,
}) {
  const pos = [];
  const idx = [];
  // Per span station: LE-upper, LE-lower, TE (shared sharp edge)
  // mid-chord upper/lower for a bit of airfoil camber look
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const x = x0 + (x1 - x0) * u;
    const zLe = zLe0 + (zLe1 - zLe0) * u;
    const zTe = zTe0 + (zTe1 - zTe0) * u;
    const tL = tLe + (tTe - tLe) * 0.15; // LE slightly rounded feel
    const tM = tLe * 0.55 + tTe * 0.45;  // max thickness ~25% chord
    const zMid = zLe + (zTe - zLe) * 0.28;

    // 0 LE upper, 1 mid upper, 2 TE, 3 mid lower, 4 LE lower
    pos.push(x, tL * 0.5, zLe);
    pos.push(x, tM * 0.5, zMid);
    pos.push(x, 0, zTe);           // sharp TE
    pos.push(x, -tM * 0.45, zMid);
    pos.push(x, -tL * 0.45, zLe);
  }

  const stride = 5;
  for (let i = 0; i < segs; i++) {
    const a = i * stride;
    const b = (i + 1) * stride;
    // Upper skin: LE-mid-TE
    idx.push(a, b, a + 1, a + 1, b, b + 1);
    idx.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
    // Lower skin: LE-mid-TE (winding flipped for outward normals-ish)
    idx.push(a, a + 4, b, b, a + 4, b + 4);
    idx.push(a + 4, a + 3, b + 4, b + 4, a + 3, b + 3);
    idx.push(a + 3, a + 2, b + 3, b + 3, a + 2, b + 2);
    // LE cap
    idx.push(a, b, a + 4, a + 4, b, b + 4);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Full main wing half: root→tip, LE forward (−Z), TE aft (+Z), sharp TE */
function makeMainWingGeo() {
  return makeSharpTePanel({
    x0: 0,
    x1: SPAN,
    zLe0: -0.55,
    zLe1: -0.12,
    zTe0: 0.55,
    zTe1: 0.22,
    tLe: 0.11,
    tTe: 0.0,
    segs: 8,
  });
}

/** Aileron: hinge at z=0, TE at +chord, sharp TE */
function makeAileronGeo() {
  const span = AILERON_OUT - AILERON_IN;
  const chord = 0.4;
  return makeSharpTePanel({
    x0: 0,
    x1: span,
    zLe0: 0,
    zLe1: 0,
    zTe0: chord,
    zTe1: chord * 0.92,
    tLe: 0.045,
    tTe: 0.0,
    segs: 3,
  });
}

/** Horizontal stab / elevator panel (span symmetric about 0) */
function makeHStabGeo(halfSpan, zLe, zTe, tLe) {
  return makeSharpTePanel({
    x0: -halfSpan,
    x1: halfSpan,
    zLe0: zLe,
    zLe1: zLe,
    zTe0: zTe,
    zTe1: zTe,
    tLe,
    tTe: 0.0,
    segs: 4,
  });
}

/**
 * Vertical fin / rudder: sharp trailing edge (aft).
 * Local: +Y up, +Z aft, thin in X. TE is a vertical line at zTe.
 */
function makeVerticalSurfaceGeo(y0, y1, zLe, zTe, tLe = 0.08) {
  // Reuse wedge idea: map Y→span-like, build in YZ with thickness X
  const pos = [];
  const idx = [];
  const segs = 4;
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const y = y0 + (y1 - y0) * u;
    const tL = tLe * (1 - u * 0.15);
    const tM = tL * 0.55;
    const zMid = zLe + (zTe - zLe) * 0.3;
    // 0 LE+X, 1 mid+X, 2 TE, 3 mid-X, 4 LE-X
    pos.push(tL * 0.5, y, zLe);
    pos.push(tM * 0.5, y, zMid);
    pos.push(0, y, zTe);
    pos.push(-tM * 0.5, y, zMid);
    pos.push(-tL * 0.5, y, zLe);
  }
  const stride = 5;
  for (let i = 0; i < segs; i++) {
    const a = i * stride;
    const b = (i + 1) * stride;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
    idx.push(a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);
    idx.push(a, b, a + 4, a + 4, b, b + 4);
    idx.push(a + 4, b + 4, a + 3, a + 3, b + 4, b + 3);
    idx.push(a + 3, b + 3, a + 2, a + 2, b + 3, b + 2);
    idx.push(a, a + 4, b, b, a + 4, b + 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function wingTeZ(x) {
  const t = x / SPAN;
  return 0.55 * (1 - t) + 0.22 * t;
}

/**
 * Two-segment winglet:
 *  1) lower: strong outward cant from wing tip
 *  2) upper: curves up and back inward (toward fuselage)
 * Each plate has sharp TE + sharp top edge.
 * @param {number} sign +1 right, -1 left
 */
function buildCurvedWinglet(sign, mat) {
  const root = new THREE.Group();
  root.name = 'winglet';
  const tipTeZ = wingTeZ(SPAN);
  root.position.set(sign * SPAN, 0.02, tipTeZ * 0.15);

  // cant > 0 = outward from wing (from vertical)
  // Chord LE/TE match at joint: lower tip chord == upper root chord
  const jointLe = -0.12;
  const jointTe = 0.1;
  const segs = [
    {
      h: 0.36,
      le0: -0.2,
      te0: 0.18,
      le1: jointLe,
      te1: jointTe,
      cant: 0.55,
      sweep: 0.1,
      tRoot: 0.055,
      tTip: 0.028, // leave thickness at joint for blend into upper root
    },
    {
      h: 0.34,
      le0: jointLe,
      te0: jointTe,
      le1: -0.06,
      te1: 0.05,
      cant: 0.12,
      sweep: 0.14,
      tRoot: 0.028,
      tTip: 0.0, // sharp top
    },
  ];

  let y = 0;
  let xOff = 0;
  let zOff = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const holder = new THREE.Group();
    holder.position.set(sign * xOff, y, zOff);
    holder.rotation.z = sign * -s.cant;
    holder.rotation.y = sign * s.sweep * 0.12;
    root.add(holder);

    const geo = makeWingletSegmentGeo(s.h, s.le0, s.te0, s.le1, s.te1, s.tRoot, s.tTip);
    const mesh = new THREE.Mesh(geo, mat);
    holder.add(mesh);
    addEdges(mesh, 12);

    const cantAbs = s.cant;
    y += s.h * Math.cos(cantAbs) * 0.95;
    xOff += s.h * Math.sin(cantAbs) * 0.9;
    zOff += s.sweep * 0.07;
  }
  return root;
}

/**
 * Winglet segment with chord that can taper root→tip (LE/TE independently).
 * Sharp TE; thickness tRoot→tTip (0 = sharp top edge).
 * Local: +Y up, +Z aft, X thickness.
 */
function makeWingletSegmentGeo(height, le0, te0, le1, te1, tRoot, tTip) {
  const pos = [];
  const idx = [];
  const segs = 3;
  for (let i = 0; i <= segs; i++) {
    const u = i / segs; // 0 root → 1 tip
    const y = height * u;
    const zLe = le0 + (le1 - le0) * u;
    const zTe = te0 + (te1 - te0) * u;
    const t = tRoot + (tTip - tRoot) * u;
    const tM = t * 0.55;
    const zMid = zLe + (zTe - zLe) * 0.35;
    // 0 LE +X, 1 mid +X, 2 TE, 3 mid -X, 4 LE -X
    pos.push(t * 0.5, y, zLe);
    pos.push(tM * 0.5, y, zMid);
    pos.push(0, y, zTe);
    pos.push(-tM * 0.5, y, zMid);
    pos.push(-t * 0.5, y, zLe);
  }
  const stride = 5;
  for (let i = 0; i < segs; i++) {
    const a = i * stride;
    const b = (i + 1) * stride;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
    idx.push(a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);
    idx.push(a, b, a + 4, a + 4, b, b + 4);
    idx.push(a + 4, b + 4, a + 3, a + 3, b + 4, b + 3);
    idx.push(a + 3, b + 3, a + 2, a + 2, b + 3, b + 2);
    idx.push(a, a + 4, b, a + 4, b + 4, b);
  }
  if (tRoot > 1e-4) {
    idx.push(0, 4, 1, 1, 4, 3, 1, 3, 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function createGlider() {
  const root = new THREE.Group();
  root.name = 'glider';

  const white = fillMaterial({ color: 0xf7f7fa });
  const offWhite = fillMaterial({ color: 0xe8e8ee });
  const accent = fillMaterial({ color: 0xe85d3a });
  const red = fillMaterial({
    color: RED,
    transparent: true,
    opacity: 0.72,
  });
  const dark = fillMaterial({ color: 0x2a2a30 });
  const canopyMat = fillMaterial({
    color: 0xa8c8d8,
    transparent: true,
    opacity: 0.35,
  });

  // —— Fuselage ——
  const fuse = new THREE.Group();
  fuse.name = 'fuse';
  root.add(fuse);
  root.userData.fuse = fuse;

  const podGeo = new THREE.CylinderGeometry(0.2, 0.34, 3.6, 8, 1);
  podGeo.rotateZ(Math.PI / 2);
  podGeo.rotateY(Math.PI / 2);
  const pod = new THREE.Mesh(podGeo, white);
  pod.position.set(0, 0.02, -0.15);
  fuse.add(pod);
  addEdges(pod, 14);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.0, 8), white);
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 0.02, -2.35);
  fuse.add(nose);
  addEdges(nose, 12);

  const boomGeo = new THREE.CylinderGeometry(0.07, 0.14, 3.2, 6, 1);
  boomGeo.rotateZ(Math.PI / 2);
  boomGeo.rotateY(Math.PI / 2);
  const boom = new THREE.Mesh(boomGeo, white);
  boom.position.set(0, 0.06, 2.35);
  fuse.add(boom);
  addEdges(boom, 16);

  // Elongated sailplane canopy (capsule-like), not a bubble dome
  const canopy = new THREE.Group();
  canopy.name = 'canopy';
  // Long low blister: stretched ellipsoid, cut-ish look via scale
  const blister = new THREE.Mesh(
    new THREE.SphereGeometry(0.38, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55),
    canopyMat
  );
  blister.scale.set(0.55, 0.38, 1.85); // narrow, low, long fore-aft
  blister.position.set(0, 0.22, -0.55);
  canopy.add(blister);
  addEdges(blister, 10);
  // Slight forward tip (nose of canopy)
  const canopyNose = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.5),
    canopyMat
  );
  canopyNose.scale.set(0.7, 0.45, 1.1);
  canopyNose.position.set(0, 0.18, -1.35);
  canopy.add(canopyNose);
  addEdges(canopyNose, 12);
  // Aft fairing into fuselage
  const canopyAft = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.5),
    canopyMat
  );
  canopyAft.scale.set(0.75, 0.4, 0.9);
  canopyAft.position.set(0, 0.16, 0.15);
  canopy.add(canopyAft);
  addEdges(canopyAft, 12);
  fuse.add(canopy);
  root.userData.canopy = canopy;

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 1.4), accent);
  stripe.position.set(0, 0.14, -1.3);
  fuse.add(stripe);

  // Retractable main gear — hinge at belly, swings aft/up when retracted
  const gearHinge = new THREE.Group();
  gearHinge.name = 'gearHinge';
  gearHinge.position.set(0, -0.12, 0.1);
  fuse.add(gearHinge);
  const gearLeg = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.28, 0.06),
    fillMaterial({ color: 0x888890 })
  );
  gearLeg.position.set(0, -0.14, 0);
  gearHinge.add(gearLeg);
  addEdges(gearLeg, 18);
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 8), dark);
  wheel.rotation.z = Math.PI / 2;
  wheel.position.set(0, -0.28, 0.02);
  gearHinge.add(wheel);
  addEdges(wheel, 20);
  // Spin about local X (cylinder axis after rot.z)
  wheel.userData.spin = 0;
  // Door fairing (moves with gear)
  const gearDoor = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.02, 0.35),
    fillMaterial({ color: 0xe8e8ee })
  );
  gearDoor.position.set(0, -0.02, 0.05);
  gearHinge.add(gearDoor);

  // —— Wings (full main plane) + ailerons on TE + airbrakes ——
  const wingGroup = new THREE.Group();
  wingGroup.name = 'wings';
  root.add(wingGroup);

  const mainWingGeo = makeMainWingGeo();
  const aileronGeo = makeAileronGeo();

  // TE z at aileron mid-span (hinge line sits on main-wing trailing edge)
  const ailMidX = (AILERON_IN + AILERON_OUT) * 0.5;
  const ailTeZ = wingTeZ(ailMidX);

  function buildWingSide(sign) {
    // sign: +1 right, -1 left
    const pivot = new THREE.Group();
    pivot.position.set(sign * 0.05, 0.05, 0.15);
    pivot.rotation.z = sign * DIHEDRAL;
    wingGroup.add(pivot);

    // Full main wing (root → tip, LE → TE)
    const main = new THREE.Mesh(mainWingGeo, white);
    if (sign < 0) main.scale.x = -1;
    pivot.add(main);
    addEdges(main, 12);

    // Aileron hinge on outer trailing edge (behind main wing)
    // Hinge at TE of main wing; aileron extends further aft (+Z)
    const ailHinge = new THREE.Group();
    ailHinge.position.set(sign * AILERON_IN, 0.03, ailTeZ + 0.01);
    pivot.add(ailHinge);

    const aileron = new THREE.Mesh(aileronGeo, red);
    // Geometry already spans +X from 0; flip for left wing
    if (sign < 0) {
      aileron.scale.x = -1;
    }
    ailHinge.add(aileron);
    addEdges(aileron, 14);

    // Tip accent
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.35), accent);
    tip.position.set(sign * SPAN, 0.02, -0.05);
    pivot.add(tip);

    // Multi-segment winglet (curved look) — sharp TE + sharp tip edge
    const wingletRoot = buildCurvedWinglet(sign, white);
    pivot.add(wingletRoot);

    // Airbrake on top of main wing (mid-inner panel)
    const brakeHinge = new THREE.Group();
    brakeHinge.position.set(sign * 2.2, 0.06, 0.0);
    pivot.add(brakeHinge);
    const brake = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.012, 0.55), red);
    brake.position.set(sign * 0.8, 0.008, 0.05);
    brakeHinge.add(brake);
    addEdges(brake, 16);

    return { pivot, ailHinge, brakeHinge };
  }

  const right = buildWingSide(1);
  const left = buildWingSide(-1);

  // —— T-tail with elevator + rudder (sharp TEs) ——
  const tail = new THREE.Group();
  tail.name = 'tail';
  tail.position.set(0, 0, 3.55);
  root.add(tail);

  const finH = 1.35;
  // Fixed fin: LE forward, sharp TE
  const fin = new THREE.Mesh(
    makeVerticalSurfaceGeo(0.08, finH + 0.05, -0.45, 0.22, 0.09),
    white
  );
  tail.add(fin);
  addEdges(fin, 10);

  // Rudder (red) — hinge at fin TE, surface extends aft to sharp TE
  const rudderHinge = new THREE.Group();
  rudderHinge.position.set(0, 0.15, 0.22);
  tail.add(rudderHinge);
  const rudder = new THREE.Mesh(
    makeVerticalSurfaceGeo(0, finH * 0.75, 0, 0.42, 0.06),
    red
  );
  rudderHinge.add(rudder);
  addEdges(rudder, 12);

  // Fixed horizontal stab on top of fin (T) — sharp TE
  const hStab = new THREE.Mesh(
    makeHStabGeo(1.4, -0.2, 0.18, 0.05),
    white
  );
  hStab.position.set(0, finH + 0.06, 0);
  tail.add(hStab);
  addEdges(hStab, 10);

  // Elevator (red) — hinge at stab TE, sharp TE further aft
  const elevHinge = new THREE.Group();
  elevHinge.position.set(0, finH + 0.06, 0.18);
  tail.add(elevHinge);
  const elevator = new THREE.Mesh(
    makeHStabGeo(1.35, 0, 0.36, 0.04),
    red
  );
  elevHinge.add(elevator);
  addEdges(elevator, 12);

  // —— 3D cockpit (FP) — simple low-poly sailplane interior ——
  const cockpit = buildCockpitInterior({ white, offWhite, dark, red, accent });
  root.add(cockpit);
  root.userData.stickPivot = cockpit.userData.stickPivot;
  root.userData.brakeLever = cockpit.userData.brakeLever;
  root.userData.gearLever = cockpit.userData.gearLever;

  const camAnchor = new THREE.Object3D();
  camAnchor.name = 'pilotCam';
  // High eye over a low coaming — matches concept long-nose view
  camAnchor.position.set(0, 0.62, 0.2);
  root.add(camAnchor);

  root.scale.setScalar(1.05);
  root.userData.pilotCam = camAnchor;
  root.userData.wings = wingGroup;
  root.userData.cockpit = cockpit;
  root.userData.tail = tail;

  // Surface hinges for animation
  root.userData.surfaces = {
    leftAileron: left.ailHinge,
    rightAileron: right.ailHinge,
    leftBrake: left.brakeHinge,
    rightBrake: right.brakeHinge,
    elevator: elevHinge,
    rudder: rudderHinge,
    gearHinge,
    wheel,
    // smoothed command state
    pitch: 0,
    roll: 0,
    yaw: 0,
    brakes: 0,
    gear: 1, // 1 down, 0 up
  };

  return root;
}

/** Outlined box helper for concept-art cockpit plates. */
function cockBox(parent, w, h, d, mat, x, y, z, opts = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  if (opts.rx) m.rotation.x = opts.rx;
  if (opts.ry) m.rotation.y = opts.ry;
  if (opts.rz) m.rotation.z = opts.rz;
  parent.add(m);
  addEdges(m, opts.edge ?? 14);
  return m;
}

/**
 * Concept-art first-person cockpit.
 * Eye sits high; coaming stays low so sky fills ~70% of the frame.
 * Long thin nose spine runs far forward like the drawing.
 *
 * Eye ~ (0, 0.62, 0.2) looking −Z. Deck tops ~0.12–0.22 (well below eye).
 */
function buildCockpitInterior(mats) {
  const { white, offWhite, dark, red, accent } = mats;
  const panelMat = fillMaterial({ color: 0xf2f2f6 });
  const gripMat = fillMaterial({ color: 0xc8c8d0 });
  const frameMat = fillMaterial({ color: 0x2c2c32 });
  const ink = fillMaterial({ color: 0x3a3a42 });

  const cockpit = new THREE.Group();
  cockpit.name = 'cockpitInterior';

  // ── Minimal seat (only visible when looking down/aft) ──
  cockBox(cockpit, 0.36, 0.04, 0.38, offWhite, 0, 0.05, 0.28, { edge: 18 });
  cockBox(cockpit, 0.36, 0.28, 0.04, offWhite, 0, 0.18, 0.46, {
    rx: -0.08,
    edge: 16,
  });

  // ── Floor deck — low, wide, not a tall tub ──
  cockBox(cockpit, 1.05, 0.025, 1.1, white, 0, 0.0, -0.15, { edge: 14 });
  // Center spine base under stick
  cockBox(cockpit, 0.14, 0.03, 0.7, offWhite, 0, 0.02, -0.2, { edge: 16 });

  // Pedals (low, forward)
  for (const s of [-1, 1]) {
    cockBox(cockpit, 0.09, 0.02, 0.12, gripMat, s * 0.12, 0.04, -0.55, {
      rx: -0.35,
      edge: 18,
    });
  }

  // ── Side sills only (no tall walls) — concept lower coaming ──
  for (const s of [-1, 1]) {
    // Flat sill strip
    cockBox(cockpit, 0.14, 0.04, 1.4, white, s * 0.48, 0.06, -0.5, {
      rz: s * 0.04,
      edge: 12,
    });
    // Thin ink rail along sill top
    cockBox(cockpit, 0.02, 0.02, 1.5, frameMat, s * 0.52, 0.1, -0.55, {
      rz: s * 0.06,
      edge: 16,
    });
    // Forward taper of sill toward wing root
    cockBox(cockpit, 0.1, 0.03, 0.8, white, s * 0.55, 0.07, -1.4, {
      rz: s * 0.05,
      ry: s * -0.08,
      edge: 14,
    });
  }

  // ── Slim instrument panel (thin strip, not a bulkhead) ──
  // Top of panel ~ y 0.18 — well under eye at 0.62
  const panelGroup = new THREE.Group();
  panelGroup.name = 'panel';
  panelGroup.position.set(0, 0.08, -0.42);

  cockBox(panelGroup, 0.55, 0.12, 0.04, panelMat, 0, 0.04, 0, {
    rx: -0.45,
    edge: 12,
  });
  // Tiny gauge pips (don't dominate)
  for (const x of [-0.14, 0, 0.14]) {
    const bezel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.028, 0.015, 7),
      dark
    );
    bezel.rotation.x = Math.PI / 2 - 0.45;
    bezel.position.set(x, 0.055, 0.025);
    panelGroup.add(bezel);
    addEdges(bezel, 20);
    const hub = new THREE.Mesh(
      new THREE.SphereGeometry(0.006, 4, 3),
      fillMaterial({ color: 0x3cc8dc })
    );
    hub.position.set(x, 0.06, 0.032);
    panelGroup.add(hub);
  }
  cockBox(panelGroup, 0.4, 0.008, 0.012, accent, 0, -0.01, 0.02, {
    rx: -0.45,
    edge: 20,
  });
  cockpit.add(panelGroup);

  // ── LONG nose spine — concept hero (extends far forward) ──
  const spine = new THREE.Group();
  spine.name = 'noseSpine';

  // Stick pedestal (compact)
  cockBox(spine, 0.1, 0.06, 0.22, white, 0, 0.06, -0.05, { edge: 14 });
  cockBox(spine, 0.08, 0.05, 0.16, offWhite, 0, 0.09, -0.22, { edge: 16 });
  // Low equipment stack
  cockBox(spine, 0.09, 0.045, 0.14, white, 0, 0.1, -0.38, { edge: 14 });
  cockBox(spine, 0.06, 0.03, 0.08, dark, 0, 0.13, -0.42, { edge: 18 });

  // Tapering deck plates — long run to tip (~4.5 m)
  // y stays low so silhouette is a thin wedge in frame
  const plates = [
    { w: 0.38, h: 0.035, d: 0.4, y: 0.06, z: -0.75 },
    { w: 0.34, h: 0.032, d: 0.4, y: 0.07, z: -1.15 },
    { w: 0.3, h: 0.03, d: 0.4, y: 0.08, z: -1.55 },
    { w: 0.26, h: 0.028, d: 0.4, y: 0.09, z: -1.95 },
    { w: 0.22, h: 0.026, d: 0.4, y: 0.1, z: -2.35 },
    { w: 0.18, h: 0.024, d: 0.4, y: 0.11, z: -2.75 },
    { w: 0.14, h: 0.022, d: 0.4, y: 0.12, z: -3.15 },
    { w: 0.11, h: 0.02, d: 0.4, y: 0.13, z: -3.55 },
    { w: 0.08, h: 0.018, d: 0.35, y: 0.14, z: -3.9 },
    { w: 0.055, h: 0.016, d: 0.3, y: 0.145, z: -4.2 },
  ];
  for (const p of plates) {
    const rx = 0.02 + (-p.z) * 0.008;
    cockBox(spine, p.w, p.h, p.d, white, 0, p.y, p.z, { rx, edge: 11 });
    // Centerline ridge (concept ink spine)
    cockBox(spine, 0.02, 0.014, p.d * 0.92, offWhite, 0, p.y + 0.02, p.z, {
      rx,
      edge: 18,
    });
  }

  // Parallel stringers along full nose length
  for (const s of [-1, 1]) {
    cockBox(spine, 0.015, 0.018, 3.6, frameMat, s * 0.1, 0.09, -2.3, {
      rz: s * 0.02,
      edge: 16,
    });
    // Sparse structural ribs
    for (const z of [-1.2, -1.9, -2.6, -3.3, -3.9]) {
      const t = clamp01Local((-z - 0.5) / 4);
      const w = 0.08 * (1 - t * 0.55);
      cockBox(spine, w, 0.025, 0.015, ink, s * (0.08 + t * 0.02), 0.1 + t * 0.04, z, {
        edge: 20,
      });
    }
  }

  // Nose tip
  const noseTip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.28, 6), white);
  noseTip.rotation.x = -Math.PI / 2;
  noseTip.position.set(0, 0.155, -4.45);
  spine.add(noseTip);
  addEdges(noseTip, 12);

  cockpit.add(spine);

  // ── Wing roots — flat, low, extending out (concept side planes) ──
  for (const s of [-1, 1]) {
    const root = new THREE.Group();
    root.position.set(s * 0.55, 0.05, -0.9);
    root.rotation.z = s * 0.06;
    // Long chord, thin thickness
    cockBox(root, 1.4, 0.03, 0.7, white, s * 0.55, 0, -0.4, { edge: 10 });
    // Forward LE wedge
    cockBox(root, 1.2, 0.025, 0.15, offWhite, s * 0.5, 0.015, -0.72, {
      rx: 0.4,
      edge: 14,
    });
    // Fairing into fuselage
    cockBox(root, 0.25, 0.05, 0.5, white, s * 0.05, 0.01, -0.1, {
      rz: s * -0.15,
      edge: 14,
    });
    // Far outer tip hint
    cockBox(root, 0.5, 0.025, 0.45, white, s * 1.35, 0.02, -0.35, {
      rz: s * 0.04,
      edge: 14,
    });
    // Rib lines
    for (const x of [0.25, 0.55, 0.9, 1.25]) {
      cockBox(root, 0.012, 0.02, 0.55, ink, s * x, 0.02, -0.35, { edge: 20 });
    }
    cockpit.add(root);
  }

  // ── Stick (short, low — bottom of frame only) ──
  cockBox(cockpit, 0.06, 0.03, 0.06, dark, 0, 0.06, 0.02, { edge: 18 });
  const stickPivot = new THREE.Group();
  stickPivot.name = 'stickPivot';
  stickPivot.position.set(0, 0.08, 0.02);
  cockpit.add(stickPivot);
  const stickShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.016, 0.22, 5),
    offWhite
  );
  stickShaft.position.set(0, 0.11, 0);
  stickPivot.add(stickShaft);
  addEdges(stickShaft, 16);
  cockBox(stickPivot, 0.045, 0.06, 0.035, gripMat, 0, 0.22, 0, { edge: 16 });
  cockBox(stickPivot, 0.018, 0.02, 0.018, red, 0, 0.2, 0.02, { edge: 20 });

  // ── Levers (low on sills) ──
  const brakeLever = new THREE.Group();
  brakeLever.name = 'brakeLever';
  brakeLever.position.set(-0.28, 0.1, -0.18);
  cockpit.add(brakeLever);
  cockBox(brakeLever, 0.03, 0.05, 0.03, dark, 0, 0, 0, { edge: 18 });
  cockBox(brakeLever, 0.014, 0.12, 0.014, offWhite, 0, 0.06, 0, { edge: 16 });
  const brakeKnob = new THREE.Mesh(new THREE.SphereGeometry(0.02, 5, 4), red);
  brakeKnob.position.set(0, 0.13, 0);
  brakeLever.add(brakeKnob);

  const gearLever = new THREE.Group();
  gearLever.name = 'gearLever';
  gearLever.position.set(0.28, 0.1, -0.18);
  cockpit.add(gearLever);
  cockBox(gearLever, 0.03, 0.05, 0.03, dark, 0, 0, 0, { edge: 18 });
  cockBox(gearLever, 0.014, 0.12, 0.014, offWhite, 0, 0.06, 0, { edge: 16 });
  const gearKnob = new THREE.Mesh(new THREE.SphereGeometry(0.02, 5, 4), red);
  gearKnob.position.set(0, 0.13, 0);
  gearLever.add(gearKnob);

  cockpit.userData.stickPivot = stickPivot;
  cockpit.userData.brakeLever = brakeLever;
  cockpit.userData.gearLever = gearLever;
  return cockpit;
}

function clamp01Local(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Spin main wheel while ground-rolling (speed m/s). */
export function updateWheelSpin(glider, speedMs, dt) {
  const wheel = glider?.userData?.surfaces?.wheel;
  if (!wheel || !dt) return;
  const r = 0.14;
  const omega = speedMs / Math.max(0.05, r);
  // Cylinder spun 90° about Z → rolling spin is local X
  wheel.rotation.x += omega * dt;
}

/**
 * Animate control surfaces from pilot inputs.
 * pitch / roll / yaw / brakes as before; gear 0..1 (1 = down).
 */
export function updateControlSurfaces(glider, ctrl, dt = 0.016) {
  const s = glider?.userData?.surfaces;
  if (!s) return;

  const lag = 1 - Math.exp(-14 * Math.max(0.001, dt));
  const gearLag = 1 - Math.exp(-6.5 * Math.max(0.001, dt)); // ~0.5–0.6s travel, matches short whir
  s.pitch += ((ctrl.pitch || 0) - s.pitch) * lag;
  s.roll += ((ctrl.roll || 0) - s.roll) * lag;
  s.yaw += ((ctrl.yaw || 0) - s.yaw) * lag;
  s.brakes += ((ctrl.brakes || 0) - s.brakes) * lag;
  const gearTarget = ctrl.gear !== undefined ? ctrl.gear : 1;
  s.gear += (gearTarget - s.gear) * gearLag;

  // Elevator: pitch up → TE up
  if (s.elevator) {
    s.elevator.rotation.x = -s.pitch * MAX_ELEVATOR;
  }

  // Ailerons: bank right → right TE up, left down
  if (s.rightAileron) {
    s.rightAileron.rotation.x = -s.roll * MAX_AILERON;
  }
  if (s.leftAileron) {
    s.leftAileron.rotation.x = s.roll * MAX_AILERON;
  }

  // Rudder: yaw right → TE right
  if (s.rudder) {
    s.rudder.rotation.y = s.yaw * MAX_RUDDER;
  }

  // Airbrakes
  const b = s.brakes * MAX_BRAKE;
  if (s.leftBrake) s.leftBrake.rotation.x = -b;
  if (s.rightBrake) s.rightBrake.rotation.x = -b;

  // Landing gear: 1 = down (extended), 0 = up (retracted into belly)
  // Rotate about X: 0 = down, ~+1.35 rad = tucked aft/up
  if (s.gearHinge) {
    const down = THREE.MathUtils.clamp(s.gear, 0, 1);
    s.gearHinge.rotation.x = (1 - down) * 1.35;
  }

  // 3D stick in cockpit
  const stickPivot = glider.userData.stickPivot;
  if (stickPivot) {
    // Pull stick (pitch up) → grip toward pilot (+X rot in our local layout)
    stickPivot.rotation.z = -s.roll * 0.4;
    stickPivot.rotation.x = s.pitch * 0.45;
  }
  // Airbrake lever: stowed → full forward/out
  const brakeLever = glider.userData.brakeLever;
  if (brakeLever) {
    brakeLever.rotation.x = -0.15 - s.brakes * 1.0;
  }
  // Gear lever: down = near vertical, up = flipped aft
  const gearLever = glider.userData.gearLever;
  if (gearLever) {
    const down = THREE.MathUtils.clamp(s.gear, 0, 1);
    gearLever.rotation.x = -0.15 - (1 - down) * 1.05;
  }
}

export function getWheelMesh(glider) {
  return glider?.userData?.surfaces?.wheel ?? null;
}

/**
 * Cockpit camera: show 3D interior (with concept wing roots / nose spine);
 * hide exterior airframe / canopy glass. Chase: full glider, hide interior.
 */
export function setCockpitVisible(glider, cockpitMode) {
  const c = glider.getObjectByName('cockpitInterior');
  const wings = glider.getObjectByName('wings');
  const fuse = glider.userData.fuse;
  const canopyObj = glider.userData.canopy;
  const tail = glider.userData.tail || glider.getObjectByName('tail');

  if (cockpitMode) {
    if (c) c.visible = true;
    // Exterior wings hidden — cockpit has its own wing-root props
    if (wings) wings.visible = false;
    if (canopyObj) canopyObj.visible = false;
    if (fuse) {
      fuse.visible = true;
      fuse.traverse((o) => {
        if (o.isMesh || o.isLineSegments) o.visible = false;
      });
    }
    if (tail) tail.visible = false;
  } else {
    if (c) c.visible = false;
    if (wings) wings.visible = true;
    if (canopyObj) canopyObj.visible = true;
    if (fuse) {
      fuse.visible = true;
      fuse.traverse((o) => {
        o.visible = true;
      });
    }
    if (tail) tail.visible = true;
  }
}
