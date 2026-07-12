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

/**
 * Single continuous fuselage loft: nose → pod → boom.
 * Elliptical stations along Z (forward −Z). Low radial segs keep edges clean.
 */
function makeFuselageLoftGeo() {
  // { z, rx, ry, y } — y = section center height
  const stations = [
    { z: -2.95, rx: 0.015, ry: 0.015, y: 0.02 }, // needle tip
    { z: -2.55, rx: 0.1, ry: 0.09, y: 0.02 },
    { z: -2.1, rx: 0.18, ry: 0.16, y: 0.025 },
    { z: -1.5, rx: 0.26, ry: 0.24, y: 0.03 },
    { z: -0.85, rx: 0.31, ry: 0.29, y: 0.03 }, // max pod
    { z: -0.25, rx: 0.32, ry: 0.3, y: 0.03 },
    { z: 0.35, rx: 0.28, ry: 0.26, y: 0.04 },
    { z: 0.95, rx: 0.2, ry: 0.18, y: 0.05 }, // tail cone into boom
    { z: 1.6, rx: 0.13, ry: 0.12, y: 0.06 },
    { z: 2.3, rx: 0.1, ry: 0.09, y: 0.065 },
    { z: 3.0, rx: 0.08, ry: 0.075, y: 0.07 },
    { z: 3.65, rx: 0.065, ry: 0.06, y: 0.07 }, // boom end (tail attaches ~3.55)
  ];
  const radial = 10; // keep modest for concept edge lines
  const pos = [];
  const idx = [];

  for (let s = 0; s < stations.length; s++) {
    const st = stations[s];
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      // Slight bottom flatten (sailplane pod)
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const flat = sin < 0 ? 0.88 : 1;
      pos.push(st.rx * cos, st.y + st.ry * sin * flat, st.z);
    }
  }

  for (let s = 0; s < stations.length - 1; s++) {
    for (let i = 0; i < radial; i++) {
      const i0 = s * radial + i;
      const i1 = s * radial + ((i + 1) % radial);
      const j0 = (s + 1) * radial + i;
      const j1 = (s + 1) * radial + ((i + 1) % radial);
      idx.push(i0, j0, i1, i1, j0, j1);
    }
  }

  // Cap nose tip
  const tip = pos.length / 3;
  pos.push(0, stations[0].y, stations[0].z - 0.08);
  for (let i = 0; i < radial; i++) {
    idx.push(tip, i, (i + 1) % radial);
  }
  // Cap boom end
  const last = stations.length - 1;
  const base = last * radial;
  const end = pos.length / 3;
  pos.push(0, stations[last].y, stations[last].z + 0.04);
  for (let i = 0; i < radial; i++) {
    idx.push(end, base + ((i + 1) % radial), base + i);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Single long low canopy blister (upper shell only).
 * Local: sits on pod top, long fore-aft, flat-ish sides for clean ink edges.
 */
function makeCanopyBlisterGeo() {
  // Stations along z: half-ellipse upper surface
  const stations = [
    { z: -1.55, rx: 0.06, ry: 0.04, y0: 0.2 }, // front tip
    { z: -1.25, rx: 0.16, ry: 0.12, y0: 0.18 },
    { z: -0.85, rx: 0.22, ry: 0.18, y0: 0.16 },
    { z: -0.4, rx: 0.24, ry: 0.2, y0: 0.15 }, // peak
    { z: 0.05, rx: 0.2, ry: 0.15, y0: 0.16 },
    { z: 0.35, rx: 0.1, ry: 0.07, y0: 0.18 }, // aft fade into fuse
  ];
  // Arc from left rail (−π) to right rail (0) over the top — only upper half
  const arcSegs = 8;
  const pos = [];
  const idx = [];

  for (const st of stations) {
    for (let i = 0; i <= arcSegs; i++) {
      const u = i / arcSegs;
      // π → 0 goes left → top → right (upper semicircle)
      const a = Math.PI - u * Math.PI;
      pos.push(st.rx * Math.cos(a), st.y0 + st.ry * Math.sin(a), st.z);
    }
  }

  const stride = arcSegs + 1;
  for (let s = 0; s < stations.length - 1; s++) {
    for (let i = 0; i < arcSegs; i++) {
      const a = s * stride + i;
      const b = a + 1;
      const c = (s + 1) * stride + i;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return { geo, stations, arcSegs };
}

/** Ink frame rails along canopy base + a few hoop ribs. */
function addCanopyFrame(canopy, stations, arcSegs) {
  const lineMat = lineMaterial(false);

  // Left / right longerons (sill rails)
  for (const side of [-1, 1]) {
    const verts = [];
    for (const st of stations) {
      verts.push(side * st.rx * 0.98, st.y0 + 0.004, st.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const line = new THREE.Line(g, lineMat);
    line.renderOrder = 3;
    canopy.add(line);
  }
  // Center ridge (top of blister)
  {
    const verts = [];
    for (const st of stations) {
      verts.push(0, st.y0 + st.ry, st.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const line = new THREE.Line(g, lineMat);
    line.renderOrder = 3;
    canopy.add(line);
  }
  // Hoop ribs at mid stations (concept arch frames)
  for (const si of [1, 2, 3, 4]) {
    const st = stations[si];
    if (!st) continue;
    const verts = [];
    for (let i = 0; i <= arcSegs; i++) {
      const u = i / arcSegs;
      const a = Math.PI - u * Math.PI;
      verts.push(st.rx * Math.cos(a), st.y0 + st.ry * Math.sin(a), st.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const line = new THREE.Line(g, lineMat);
    line.renderOrder = 3;
    canopy.add(line);
  }
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
    color: 0xc8dce8,
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
  });

  // —— Fuselage: one continuous loft ——
  const fuse = new THREE.Group();
  fuse.name = 'fuse';
  root.add(fuse);
  root.userData.fuse = fuse;

  const body = new THREE.Mesh(makeFuselageLoftGeo(), white);
  body.name = 'fuselageBody';
  fuse.add(body);
  // Higher threshold → fewer facet lines, more silhouette / feature edges
  addEdges(body, 28);

  // —— Canopy: single blister + frame lines ——
  const canopy = new THREE.Group();
  canopy.name = 'canopy';
  const { geo: canopyGeo, stations: canopyStations, arcSegs } =
    makeCanopyBlisterGeo();
  const blister = new THREE.Mesh(canopyGeo, canopyMat);
  blister.name = 'canopyBlister';
  canopy.add(blister);
  addEdges(blister, 22);
  addCanopyFrame(canopy, canopyStations, arcSegs);
  fuse.add(canopy);
  root.userData.canopy = canopy;

  // Thin accent stripe along pod shoulder (kept subtle)
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.025, 1.1), accent);
  stripe.position.set(0, 0.2, -0.9);
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
  // Clean eye; coaming is 2D concept overlay (not a 3D tub)
  camAnchor.position.set(0, 0.42, 0.05);
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

/**
 * Minimal 3D cockpit anchors only — visual coaming is the 2D concept-art SVG.
 * Stick/lever groups exist so animation hooks keep working if re-enabled later.
 */
function buildCockpitInterior(_mats) {
  const cockpit = new THREE.Group();
  cockpit.name = 'cockpitInterior';
  // Invisible pivots (SVG draws stick/levers; 3D stays empty for clean FP)
  const stickPivot = new THREE.Group();
  stickPivot.name = 'stickPivot';
  stickPivot.visible = false;
  cockpit.add(stickPivot);
  const brakeLever = new THREE.Group();
  brakeLever.name = 'brakeLever';
  brakeLever.visible = false;
  cockpit.add(brakeLever);
  const gearLever = new THREE.Group();
  gearLever.name = 'gearLever';
  gearLever.visible = false;
  cockpit.add(gearLever);
  cockpit.userData.stickPivot = stickPivot;
  cockpit.userData.brakeLever = brakeLever;
  cockpit.userData.gearLever = gearLever;
  return cockpit;
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
