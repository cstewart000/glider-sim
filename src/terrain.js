/**
 * Infinite low-poly terrain with LOD streaming.
 * Two scenario worlds:
 *  - airfield: level field + runway, large hills on the horizon
 *  - coastal: mountain chain on a coastline, ocean, orographic ridge lift
 */

import * as THREE from 'three';
import { fillMaterial } from './styleUtil.js';

export const CHUNK_SIZE = 360;
const SEG_NEAR = 24;
const SEG_MID = 14;
const SEG_FAR = 8;
/** ~2.1 km radius */
const VIEW_RADIUS = 6;
const DETAIL_RADIUS = 2;
const MID_RADIUS = 4;
const MAX_BUILDS_PER_FRAME = 3;
const CULL_PADDING = 1;

// Runway constants (match runway.js)
// Match runway.js RUNWAY extents (keep in sync)
const RW_X = 0;
const RW_Z = -40;
const RW_Y = 92;
const RW_HW = 14;
const RW_HL = 170;

/** Coastal sea surface height (m) */
export const SEA_LEVEL = 8;

// —— Noise ——
function hash2(x, z) {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function smoothNoise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a * (1 - ux) * (1 - uz) + b * ux * (1 - uz) + c * (1 - ux) * uz + d * ux * uz;
}

function fbm(x, z, octaves = 4) {
  let v = 0, a = 1, f = 1, s = 0;
  for (let i = 0; i < octaves; i++) {
    v += a * smoothNoise(x * f, z * f);
    s += a;
    a *= 0.5;
    f *= 2;
  }
  return v / s;
}

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// —— Active profile ——
/** @type {'airfield' | 'coastal'} */
let activeProfile = 'airfield';

export function getTerrainProfile() {
  return activeProfile;
}

/**
 * Switch height model. Caller should rebuild chunk meshes after this.
 * @param {'airfield' | 'coastal'} id
 */
export function setTerrainProfile(id) {
  activeProfile = id === 'coastal' ? 'coastal' : 'airfield';
}

// —— Height models ——

/**
 * Level field around the runway; large hills ring the horizon.
 */
function heightAirfield(x, z) {
  const dx = x - RW_X;
  const dz = z - RW_Z;
  const r = Math.hypot(dx, dz);

  // Soft field undulation (almost level)
  let h = RW_Y - 2 + fbm(x * 0.0055, z * 0.0055, 3) * 10;
  h += fbm(x * 0.018 + 4, z * 0.018, 2) * 3.5;

  // Broad plateau so the strip sits in open country
  const plateau = Math.exp(-(r * r) / (520 * 520));
  h = h * (1 - plateau * 0.55) + RW_Y * plateau * 0.55 + h * plateau * 0.2;

  // Mid ring: gentle rises
  const midRing = smoothstep(280, 620, r) * (1 - smoothstep(900, 1400, r));
  h += midRing * (18 + fbm(x * 0.0035 + 1.2, z * 0.0035, 3) * 45);

  // Distant large hills / ranges (surrounding the field)
  const far = smoothstep(550, 1100, r);
  const range = fbm(x * 0.0018 + 7, z * 0.0018 + 3, 4);
  h += far * (55 + range * 210);
  // Occasional higher peaks on the skyline
  if (range > 0.58 && r > 700) {
    h += (range - 0.58) * 180 * far;
  }

  // Flatten home runway + wide apron so LOD chunks cannot bury the strip
  // (far LOD segs ~45 m — pad must extend past one segment beyond the asphalt)
  const adx = Math.abs(x - RW_X);
  const adz = Math.abs(z - RW_Z);
  const hard =
    adx <= RW_HW + 6 && adz <= RW_HL + 8;
  const padX = RW_HW + 70;
  const padZ = RW_HL + 90;
  if (hard) {
    // Deck sits slightly below visual asphalt so mesh never pokes through
    h = RW_Y - 0.12;
  } else if (adx < padX && adz < padZ) {
    const tx = adx / padX;
    const tz = adz / padZ;
    const t = Math.max(tx, tz);
    const w = (1 - t) * (1 - t);
    h = h * (1 - w) + (RW_Y - 0.12) * w;
  }

  return h;
}

/**
 * Coastal ridge chain: crest height 40–120 m above the coastal plain,
 * face slopes varied 30–60° (windward and leeward can differ).
 * Ocean toward +Z (onshore wind). Crest near z ≈ 40–70.
 */
function coastalCrestZ(x) {
  // Ridge alignment meanders — not a straight chain
  return (
    48 +
    (fbm(x * 0.0011 + 0.7, 1.1, 4) - 0.5) * 48 +
    (fbm(x * 0.0045 + 2.2, 3.4, 2) - 0.5) * 18 +
    Math.sin(x * 0.0042 + 1.1) * 14
  );
}

/**
 * Full-range 0..1 along the chain — sine waves reach highs/lows; light fbm jitter.
 */
function coastalVary01(x, seed) {
  const w1 = 0.5 + 0.5 * Math.sin(x * 0.0055 + seed * 2.3);
  const w2 = 0.5 + 0.5 * Math.sin(x * 0.012 + seed * 1.1 + 0.8);
  const n = (fbm(x * 0.005 + seed, 1.2, 2) - 0.5) * 0.3; // ±0.15
  return clamp01(w1 * 0.62 + w2 * 0.38 + n);
}

/** Ridge height above coastal plain at crest (m), range 40–120. */
function coastalRidgeHeight(x) {
  return 40 + coastalVary01(x, 5.1) * 80;
}

/** Face slope angle in degrees, clamped to 30–60, varies along chain. */
function coastalSlopeDeg(x, side) {
  // side 0 = windward (ocean), 1 = leeward (inland) — independent variation
  return 30 + coastalVary01(x, 4.2 + side * 11.7) * 30;
}

/**
 * Constant-angle triangular face: run = height / tan(angle).
 * Tiny crest rounding only (keeps measured angle inside 30–60°).
 */
function ridgeFaceElev(distFromCrest, ridgeH, slopeDeg) {
  const ang = (slopeDeg * Math.PI) / 180;
  const run = ridgeH / Math.tan(ang);
  const d = Math.abs(distFromCrest);
  if (d >= run) return 0;
  const t = 1 - d / run;
  // 4% smoothstep at peak so the crest isn't a knife-edge in the mesh
  const round = t * t * (3 - 2 * t);
  return ridgeH * (t * 0.96 + round * 0.04);
}

/**
 * Meandering waterline z. Multi-scale bays / headlands; always seaward of ridge toe.
 * Optional zHint adds local jogs so the shore is not a pure X-function.
 */
function coastalCoastZ(x, zHint = null) {
  const crestZ = coastalCrestZ(x);
  const ridgeH = coastalRidgeHeight(x);
  const windDeg = coastalSlopeDeg(x, 0);
  const windRun = ridgeH / Math.tan((windDeg * Math.PI) / 180);
  const minCoast = crestZ + windRun + 22;

  const meander =
    (fbm(x * 0.0009 + 1.7, 0.3, 4) - 0.5) * 110 +
    (fbm(x * 0.0035 + 4.1, 1.9, 3) - 0.5) * 55 +
    (fbm(x * 0.011 + 8.2, 2.6, 2) - 0.5) * 22 +
    Math.sin(x * 0.0068 + 0.9) * 28 +
    Math.sin(x * 0.019 + 2.4) * 14 +
    Math.sin(x * 0.041 + fbm(x * 0.002, 3.1, 2) * 2) * 8;

  let coast = crestZ + windRun + 48 + meander;

  if (zHint != null) {
    const jog =
      (fbm(x * 0.018 + 6.5, zHint * 0.014 + 2.2, 3) - 0.5) * 16 +
      (fbm(x * 0.05, zHint * 0.04, 2) - 0.5) * 7;
    coast += jog;
  }

  return Math.max(minCoast, coast);
}

/** Sand strip width inland of waterline (m) — pocket beaches & rocky spits. */
function coastalSandWidth(x) {
  let w = 16 + coastalVary01(x, 9.2) * 42; // ~16–58 m base
  const pocket = fbm(x * 0.016 + 12.4, 3.7, 3);
  if (pocket > 0.62) w += (pocket - 0.62) * 90;
  if (pocket < 0.32) w *= 0.45 + pocket;
  w += (fbm(x * 0.03 + 1.1, 5.5, 2) - 0.5) * 10;
  return Math.max(10, Math.min(85, w));
}

const SAND_STRIP_W_MAX = 90;

function heightCoastal(x, z) {
  const crestZ = coastalCrestZ(x);
  const distCrest = z - crestZ; // + = ocean / windward side

  const ridgeH = coastalRidgeHeight(x);
  const windDeg = coastalSlopeDeg(x, 0);
  const leeDeg = coastalSlopeDeg(x, 1);
  const coastZ = coastalCoastZ(x, z);
  const sandW = coastalSandWidth(x);

  // Flat coastal plain under the ridge (minimal noise so face angle stays true)
  let base = SEA_LEVEL + 12 + fbm(x * 0.01, z * 0.01, 2) * 3;
  // Gentle foothills inland only (low, not another mountain range)
  if (z < crestZ) {
    const inland = fbm(x * 0.003 + 11, z * 0.003, 2);
    base += inland * 10 * smoothstep(crestZ, crestZ - 200, z);
  }

  const faceH =
    distCrest >= 0
      ? ridgeFaceElev(distCrest, ridgeH, windDeg)
      : ridgeFaceElev(distCrest, ridgeH, leeDeg);

  let h = base + faceH;

  // Pale sandy strip: irregular terrace along meandering waterline
  const sandIn = coastZ - sandW;
  const sandOut = coastZ + 4 + fbm(x * 0.02, 2.2, 2) * 6;
  if (z > sandIn - 18 && z < sandOut + 12) {
    const dunes =
      fbm(x * 0.03 + 3, z * 0.055, 3) * 2.4 +
      fbm(x * 0.08, z * 0.09, 2) * 1.1;
    const cusp = Math.sin(x * 0.09 + fbm(x * 0.01, 1, 2) * 4) * 0.9;
    const sandY =
      SEA_LEVEL +
      0.9 +
      dunes +
      cusp +
      smoothstep(coastZ + 2, sandIn, z) * (1.2 + fbm(x * 0.02, 4, 2));
    const blendIn = 8 + fbm(x * 0.04, 6.1, 2) * 10;
    const blendOut = 3 + fbm(x * 0.05 + 2, 7.2, 2) * 6;
    const sandMask =
      smoothstep(sandIn - blendIn, sandIn + 4 + fbm(x * 0.03, 1, 2) * 5, z) *
      (1 - smoothstep(coastZ - 3, sandOut + blendOut, z));
    h = h * (1 - sandMask) + sandY * sandMask;
  }

  // Irregular drop from sand into the water
  if (z > coastZ - 8) {
    const lip = 3 + fbm(x * 0.04 + z * 0.02, 3.3, 2) * 8;
    const intoSea = smoothstep(coastZ - lip, coastZ + 8 + fbm(x * 0.03, 2, 2) * 6, z);
    const wetY = SEA_LEVEL + 0.35 - intoSea * (2.2 + fbm(x * 0.05, z * 0.05, 2) * 2);
    h = h * (1 - intoSea * 0.88) + wetY * intoSea * 0.88;
  }

  // Open ocean (flat floor under water plane)
  if (z > coastZ + 6) {
    const deepStart = coastZ + 6 + fbm(x * 0.01, 1.5, 2) * 10;
    const deep = smoothstep(deepStart, deepStart + 100, z);
    h = THREE.MathUtils.lerp(h, SEA_LEVEL - 6 - deep * 18, deep);
  }

  // Rocky points / islets — clustered, not uniform
  if (z > coastZ - 25 && z < coastZ + 100) {
    const isle = fbm(x * 0.014 + 3, z * 0.014 + 8, 3);
    const cluster = fbm(x * 0.004 + 9, 2.2, 2);
    if (isle > 0.7 && cluster > 0.45) {
      h = Math.max(h, SEA_LEVEL + (isle - 0.7) * 28 * cluster);
    }
  }

  return h;
}

export function terrainHeight(x, z) {
  return activeProfile === 'coastal' ? heightCoastal(x, z) : heightAirfield(x, z);
}

/** Ridge face parameters at x — shared by lift sampling and vapor streams. */
export function ridgeFaceInfo(x) {
  const crestZ = coastalCrestZ(x);
  const ridgeH = coastalRidgeHeight(x);
  const windDeg = coastalSlopeDeg(x, 0);
  const run = ridgeH / Math.tan((windDeg * Math.PI) / 180);
  return {
    crestZ,
    ridgeH,
    windDeg,
    run,
    crestH: heightCoastal(x, crestZ),
  };
}

/**
 * Orographic lift: onshore wind hits the windward (ocean) face.
 * Core of the band is strong; proximity to the face mid-band pushes hard.
 */
export function sampleRidgeLift(x, y, z) {
  if (activeProfile !== 'coastal') return 0;

  const { crestZ, ridgeH, windDeg, run, crestH } = ridgeFaceInfo(x);
  const ground = heightCoastal(x, z);
  const agl = y - ground;
  if (agl < 3 || agl > ridgeH + 120) return 0;

  const faceDist = z - crestZ; // + = ocean / windward
  if (faceDist < -run * 0.4 || faceDist > run * 1.25) return 0;

  // Peak lift mid-face
  const mid = run * 0.38;
  const face =
    faceDist >= 0
      ? Math.exp(-((faceDist - mid) ** 2) / ((run * 0.42) ** 2))
      : 0;
  const lee =
    faceDist < 0
      ? Math.exp(-(faceDist * faceDist) / ((run * 0.28) ** 2)) * -0.55
      : 0;

  const aboveCrest = y - crestH;
  // Tight height band along the rising stream (terrain-following)
  const streamY = ground + 8 + clamp01(1 - faceDist / Math.max(run, 1)) * ridgeH * 0.55;
  const distToStream = Math.abs(y - streamY);
  const streamProx = Math.exp(-(distToStream * distToStream) / (28 * 28));

  const heightBand =
    aboveCrest > -ridgeH * 0.55 && aboveCrest < ridgeH * 1.0
      ? 1
      : aboveCrest > -ridgeH
        ? 0.5
        : aboveCrest < ridgeH * 1.5
          ? 0.28
          : 0;

  const slopeBoost = 0.55 + 0.45 * clamp01((windDeg - 30) / 30);
  const hBoost = 0.6 + 0.4 * clamp01((ridgeH - 40) / 80);

  // Base orographic + strong core when in the vapour stream
  const base = (face * 7.5 + lee * 2.4) * heightBand * slopeBoost * hBoost;
  const core = face * streamProx * heightBand * (14 + ridgeH * 0.08);
  return base + core;
}

/**
 * Ridge body forces when in the current.
 * @returns {{ up: number, into: number }} up = vertical accel (m/s²),
 *   into = accel toward the mountain face / crest (m/s², always ≥ 0)
 */
export function sampleRidgePush(x, y, z) {
  if (activeProfile !== 'coastal') return { up: 0, into: 0 };
  const lift = sampleRidgeLift(x, y, z);
  if (lift < 2.5) return { up: 0, into: 0 };

  // Strong vertical shove in the mist (~8–28 m/s² in the core)
  const up = Math.min(28, Math.max(0, (lift - 2.5) * 2.8));

  // Slight horizontal pull into the mountain (toward crest, −Z on windward)
  const { crestZ, run } = ridgeFaceInfo(x);
  const faceDist = z - crestZ;
  let into = 0;
  if (faceDist > 0 && faceDist < run * 1.2 && lift > 3) {
    const mid = run * 0.4;
    const face = Math.exp(-((faceDist - mid) ** 2) / ((run * 0.5) ** 2));
    into = face * (0.9 + Math.min(1.2, lift * 0.05)); // gentle ~0.5–2 m/s²
  }
  return { up, into };
}

function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

function ringDist(dx, dz) {
  return Math.max(Math.abs(dx), Math.abs(dz));
}

function lodForRing(ring) {
  if (ring <= DETAIL_RADIUS) return 'near';
  if (ring <= MID_RADIUS) return 'mid';
  return 'far';
}

const LOD_RANK = { far: 0, mid: 1, near: 2 };

const trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 1.0, 4);
const crownGeo = new THREE.ConeGeometry(0.95, 2.2, 4);
const trunkMat = fillMaterial({ color: 0xb8b8bc });
const crownMat = fillMaterial({ color: 0x6a6a70 });
// Concept-art water: cool pale blue-grey
const waterMat = fillMaterial({
  color: 0xa8c0d4,
  transparent: true,
  opacity: 0.82,
});
const oceanMat = fillMaterial({
  color: 0x96b4cc,
  transparent: true,
  opacity: 0.88,
});
// Pale sandy shoreline strip (warm cream, concept-art light)
const sandMat = fillMaterial({
  color: 0xe8dfc8,
  transparent: true,
  opacity: 0.92,
});

function vertexColor(x, z, y, lod) {
  if (activeProfile === 'coastal') {
    const coastZ = coastalCoastZ(x, z);
    const sandW = coastalSandWidth(x);
    const sandIn = coastZ - sandW;
    // Pale sand band — follows meander + variable width
    if (z > sandIn - 12 && z < coastZ + 14 && y < SEA_LEVEL + 16) {
      const edge =
        smoothstep(sandIn - 12, sandIn + 5, z) *
        (1 - smoothstep(coastZ - 4, coastZ + 14, z));
      const n = lod === 'far' ? 0.5 : fbm(x * 0.05, z * 0.05, 2);
      // Warm pale sand with slight colour variation along shore
      const tint = fbm(x * 0.01 + 2, 1.4, 2);
      const r = 0.92 + n * 0.05 + tint * 0.02;
      const g = 0.88 + n * 0.03 + tint * 0.01;
      const b = 0.76 + n * 0.04 - tint * 0.02;
      if (edge > 0.12) {
        const wet = smoothstep(coastZ - 12 - sandW * 0.1, coastZ + 5, z);
        return {
          r: r * (1 - wet * 0.1) * (0.72 + edge * 0.28),
          g: g * (1 - wet * 0.06) * (0.72 + edge * 0.28),
          b: (b + wet * 0.05) * (0.72 + edge * 0.28),
        };
      }
    }
    if (y <= SEA_LEVEL + 1.2) {
      // Intertidal / wet shore
      const n = fbm(x * 0.04, z * 0.04, 2);
      return { r: 0.82 + n * 0.04, g: 0.8 + n * 0.03, b: 0.74 + n * 0.03 };
    }
    if (y > SEA_LEVEL + 95) {
      // Higher ridge rock
      const n = lod === 'far' ? 0.5 : fbm(x * 0.02, z * 0.02, 2);
      const g = 0.9 + n * 0.04;
      return { r: g, g: g, b: g * 0.99 };
    }
    if (y > SEA_LEVEL + 45) {
      const n = lod === 'far' ? 0.5 : fbm(x * 0.02, z * 0.02, 2);
      const g = 0.84 + n * 0.06;
      return { r: g, g: g, b: g * 0.98 };
    }
  }

  // Airfield: grey asphalt pad under / around the strip (visible even without mesh)
  if (activeProfile === 'airfield') {
    const adx = Math.abs(x - RW_X);
    const adz = Math.abs(z - RW_Z);
    if (adx <= RW_HW + 2 && adz <= RW_HL + 2) {
      // Medium grey runway surface
      const n = lod === 'far' ? 0.5 : fbm(x * 0.08, z * 0.08, 2);
      const g = 0.42 + n * 0.04;
      return { r: g, g: g, b: g * 1.02 };
    }
    if (adx <= RW_HW + 18 && adz <= RW_HL + 22) {
      // Lighter grey apron / shoulders
      const n = lod === 'far' ? 0.5 : fbm(x * 0.05, z * 0.05, 2);
      const g = 0.58 + n * 0.05;
      return { r: g, g: g * 0.99, b: g * 0.97 };
    }
  }

  // Default greyscale land
  let g;
  if (lod === 'far') {
    g = 0.82 + Math.min(0.12, y * 0.0004);
  } else {
    const n = fbm(x * 0.02, z * 0.02, lod === 'far' ? 2 : 3);
    g = 0.88 - n * 0.08;
    if (y > 160) g = 0.94;
    else if (y > 120) g = 0.86 + n * 0.04;
    else if (y < 55) g = 0.78 + n * 0.05;
    if (y > 55 && y < 130 && n > 0.55) g -= 0.18;
  }
  return { r: g, g, b: g };
}

function buildChunkMesh(cx, cz, mat, edgeMat, ring) {
  const lod = lodForRing(ring);
  const segs = lod === 'near' ? SEG_NEAR : lod === 'mid' ? SEG_MID : SEG_FAR;

  const group = new THREE.Group();
  group.name = `chunk_${cx}_${cz}`;
  group.userData.cx = cx;
  group.userData.cz = cz;
  group.userData.lod = lod;

  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;

  const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, segs, segs);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const ox = originX + CHUNK_SIZE * 0.5;
  const oz = originZ + CHUNK_SIZE * 0.5;

  let minY = Infinity;
  let maxY = -Infinity;
  let oceanVerts = 0;

  for (let i = 0; i < pos.count; i++) {
    const x = ox + pos.getX(i);
    const z = oz + pos.getZ(i);
    const y = terrainHeight(x, z);
    pos.setY(i, y);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (y <= SEA_LEVEL + 2) oceanVerts++;

    const c = vertexColor(x, z, y, lod);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(ox, 0, oz);
  mesh.frustumCulled = true;
  group.add(mesh);

  if (lod === 'near') {
    const edges = new THREE.EdgesGeometry(geo, 15);
    const outline = new THREE.LineSegments(edges, edgeMat);
    outline.position.copy(mesh.position);
    outline.frustumCulled = true;
    group.add(outline);
  }

  // Local ponds (airfield) or coastal water patches
  if (activeProfile === 'airfield' && lod === 'near') {
    maybeAddPond(group, originX, originZ);
  }

  // Ocean surface for coastal chunks that touch the sea
  if (activeProfile === 'coastal' && oceanVerts > pos.count * 0.08) {
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(CHUNK_SIZE * 0.98, CHUNK_SIZE * 0.98, 1, 1),
      oceanMat
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(ox, SEA_LEVEL + 0.15, oz);
    water.frustumCulled = true;
    group.add(water);
  }

  // Pale sandy shoreline strip (reads clearly from the air)
  if (activeProfile === 'coastal' && (lod === 'near' || lod === 'mid')) {
    maybeAddSandStrip(group, originX, originZ, lod);
  }

  if (lod === 'near') {
    addChunkTrees(group, originX, originZ, 1);
  } else if (lod === 'mid') {
    addChunkTrees(group, originX, originZ, 0.35);
  }

  return group;
}

/**
 * Overlay a pale sand band that follows the meandering coastline.
 * Width and alignment vary per sample along X — not a straight strip.
 */
function maybeAddSandStrip(group, originX, originZ, lod) {
  const x0 = originX;
  const x1 = originX + CHUNK_SIZE;
  const samples = lod === 'near' ? 12 : 5;
  let coastMin = Infinity;
  let coastMax = -Infinity;
  let widthMax = 0;
  for (let i = 0; i <= samples; i++) {
    const x = x0 + ((x1 - x0) * i) / samples;
    const c = coastalCoastZ(x);
    const w = coastalSandWidth(x);
    if (c < coastMin) coastMin = c;
    if (c > coastMax) coastMax = c;
    if (w > widthMax) widthMax = w;
  }
  const zMid = originZ + CHUNK_SIZE * 0.5;
  // Chunk must overlap the varying sand band
  if (zMid < coastMin - widthMax - 50 || zMid > coastMax + 55) return;

  // Build a ribbon: high segs along shore, 2 across (inland edge → waterline)
  const segsX = lod === 'near' ? 14 : 6;
  const segsZ = 2;
  const geo = new THREE.PlaneGeometry(1, 1, segsX, segsZ);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const ox = originX + CHUNK_SIZE * 0.5;
  const oz = originZ + CHUNK_SIZE * 0.5;

  for (let i = 0; i < pos.count; i++) {
    // Plane local: u in [-0.5,0.5] along X index, v in [-0.5,0.5] across strip
    const u = pos.getX(i) + 0.5; // 0..1 along chunk X
    const v = pos.getZ(i) + 0.5; // 0 = inland edge, 1 = seaward edge
    const wx = x0 + u * CHUNK_SIZE;
    const coast = coastalCoastZ(wx);
    const sandW = coastalSandWidth(wx);
    // Local warp so edges aren't parallel
    const edgeWobble = (fbm(wx * 0.04, v * 3 + 2, 2) - 0.5) * 6;
    const inland = coast - sandW - 4 + edgeWobble;
    const seaward = coast + 3 + (fbm(wx * 0.05 + 1, 4.2, 2) - 0.5) * 5;
    const wz = inland * (1 - v) + seaward * v;
    const wy = Math.max(SEA_LEVEL + 0.3, terrainHeight(wx, wz) + 0.1);
    pos.setXYZ(i, wx - ox, wy, wz - oz);
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();

  const sand = new THREE.Mesh(geo, sandMat);
  sand.position.set(ox, 0, oz);
  sand.frustumCulled = true;
  sand.renderOrder = 1;
  group.add(sand);
}

function addChunkTrees(group, originX, originZ, densityScale) {
  const seed = Math.abs(Math.sin(originX * 12.9898 + originZ * 78.233) * 43758.5453);
  const count = Math.floor((4 + (seed % 1) * 10) * densityScale);
  if (count <= 0) return;
  const rng = mulberry32(((originX * 73856093) ^ (originZ * 19349663)) >>> 0);

  for (let i = 0; i < count; i++) {
    const x = originX + rng() * CHUNK_SIZE;
    const z = originZ + rng() * CHUNK_SIZE;
    const y = terrainHeight(x, z);
    if (activeProfile === 'coastal') {
      if (y < SEA_LEVEL + 14 || y > SEA_LEVEL + 100) continue;
      // Skip open windward face / beach (trees on lee + lower slopes)
      if (z > coastalCrestZ(x) + 15) continue;
    } else {
      if (y < 70 || y > 145) continue;
      if (Math.abs(x - RW_X) < RW_HW + 8 && Math.abs(z - RW_Z) < RW_HL + 10) continue;
    }

    const s = 0.75 + rng() * 1.2;
    const crown = new THREE.Mesh(crownGeo, crownMat);
    crown.position.set(x, y + 1.2 * s, z);
    crown.scale.setScalar(s);
    crown.rotation.y = rng() * Math.PI * 2;
    crown.frustumCulled = true;
    group.add(crown);

    if (densityScale > 0.6) {
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.set(x, y + 0.5 * s, z);
      trunk.scale.setScalar(s);
      trunk.rotation.y = crown.rotation.y;
      trunk.frustumCulled = true;
      group.add(trunk);
    }
  }
}

function maybeAddPond(group, originX, originZ) {
  const cx = originX + CHUNK_SIZE * 0.5;
  const cz = originZ + CHUNK_SIZE * 0.5;
  const h = terrainHeight(cx, cz);
  const n = fbm(cx * 0.003 + 2, cz * 0.003, 2);
  if (h > 100 || n > 0.4) return;
  if (Math.abs(cx - RW_X) < 80 && Math.abs(cz - RW_Z) < 200) return;

  const w = 35 + n * 70;
  const water = new THREE.Mesh(new THREE.PlaneGeometry(w, w * (0.55 + n), 1, 1), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.set(cx, h - 1.5, cz);
  group.add(water);
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TerrainWorld {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'terrainWorld';
    scene.add(this.root);

    this.chunks = new Map();
    /** @type {{ key: string, targetLod: string, priority: number }[]} */
    this.queue = [];
    this.queued = new Set();
    this._cx = null;
    this._cz = null;
    this._fwd = null;

    // Far ocean disc (coastal only) — unbroken seaward horizon
    this._oceanHorizon = new THREE.Mesh(
      new THREE.CircleGeometry(2800, 48),
      oceanMat
    );
    this._oceanHorizon.rotation.x = -Math.PI / 2;
    this._oceanHorizon.position.set(0, SEA_LEVEL, 900);
    this._oceanHorizon.visible = false;
    this._oceanHorizon.renderOrder = -1;
    this.root.add(this._oceanHorizon);

    this.mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
    });
    this.edgeMat = new THREE.LineBasicMaterial({
      color: 0x2c2c30,
      transparent: true,
      opacity: 0.5,
    });

    this.update(new THREE.Vector3(0, 100, 0), true);
  }

  worldToChunk(x, z) {
    return {
      cx: Math.floor(x / CHUNK_SIZE),
      cz: Math.floor(z / CHUNK_SIZE),
    };
  }

  /**
   * Dispose all chunks and rebuild around pos for the current profile.
   */
  rebuild(pos) {
    for (const [key, chunk] of [...this.chunks.entries()]) {
      this._disposeChunk(key, chunk);
    }
    this.queue = [];
    this.queued.clear();
    this._cx = null;
    this._cz = null;
    if (this._oceanHorizon) {
      this._oceanHorizon.visible = activeProfile === 'coastal';
      this._oceanHorizon.position.y = SEA_LEVEL;
    }
    const p = pos || new THREE.Vector3(0, 120, 0);
    this.update(p, true);
  }

  update(pos, flush = false, forward = null) {
    const { cx, cz } = this.worldToChunk(pos.x, pos.z);
    if (forward) this._fwd = forward;

    // Drift ocean disc under / seaward of pilot (coastal)
    if (this._oceanHorizon && this._oceanHorizon.visible) {
      this._oceanHorizon.position.x = pos.x;
      this._oceanHorizon.position.z = Math.max(pos.z + 400, 500);
      this._oceanHorizon.position.y = SEA_LEVEL;
    }

    if (cx !== this._cx || cz !== this._cz || this.queue.length === 0) {
      this._cx = cx;
      this._cz = cz;
      this._enqueueWork(cx, cz);
      this._cull(cx, cz);
    }

    let builds = flush ? 180 : MAX_BUILDS_PER_FRAME;
    if (!flush && this.queue.length > 20) builds = 5;
    if (!flush && this.queue.length > 40) builds = 7;

    while (builds-- > 0 && this.queue.length > 0) {
      const job = this.queue.shift();
      this.queued.delete(job.key);
      this._processJob(job);
    }
  }

  _processJob(job) {
    const { key, targetLod } = job;
    const [scx, scz] = key.split(',').map(Number);
    const ring = ringDist(scx - this._cx, scz - this._cz);
    if (ring > VIEW_RADIUS + CULL_PADDING) return;

    const desired = lodForRing(ring);
    const existing = this.chunks.get(key);

    if (existing) {
      const have = existing.userData.lod || 'far';
      if (LOD_RANK[desired] <= LOD_RANK[have]) return;
      this._disposeChunk(key, existing);
    }

    const chunk = buildChunkMesh(scx, scz, this.mat, this.edgeMat, ring);
    chunk.userData.lod = desired;
    this.root.add(chunk);
    this.chunks.set(key, chunk);
  }

  _disposeChunk(key, chunk) {
    this.root.remove(chunk);
    chunk.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.chunks.delete(key);
  }

  _enqueueWork(cx, cz) {
    let fdx = 0;
    let fdz = -1;
    if (this._fwd) {
      const len = Math.hypot(this._fwd.x, this._fwd.z) || 1;
      fdx = this._fwd.x / len;
      fdz = this._fwd.z / len;
    }

    const pending = [];
    for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
      for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
        const key = chunkKey(cx + dx, cz + dz);
        const ring = ringDist(dx, dz);
        const targetLod = lodForRing(ring);
        const existing = this.chunks.get(key);

        let needsWork = false;
        if (!existing) {
          needsWork = true;
        } else {
          const have = existing.userData.lod || 'far';
          needsWork = LOD_RANK[targetLod] > LOD_RANK[have];
        }
        if (!needsWork) continue;

        const ahead = dx * fdx + dz * fdz;
        const dist = dx * dx + dz * dz;
        const upgradeBoost = existing ? -30 * LOD_RANK[targetLod] : 0;
        const priority = -ahead * 45 + dist + upgradeBoost;
        pending.push({ key, targetLod, priority });
      }
    }

    pending.sort((a, b) => a.priority - b.priority);
    this.queue = [];
    this.queued.clear();
    for (const job of pending) {
      if (this.queued.has(job.key)) continue;
      this.queued.add(job.key);
      this.queue.push(job);
    }
  }

  _cull(cx, cz) {
    const keep = VIEW_RADIUS + CULL_PADDING;
    for (const [key, chunk] of this.chunks) {
      const [scx, scz] = key.split(',').map(Number);
      if (Math.abs(scx - cx) > keep || Math.abs(scz - cz) > keep) {
        this._disposeChunk(key, chunk);
      }
    }
  }

  get heightAt() {
    return terrainHeight;
  }
}

export function createTerrain(scene) {
  const world = new TerrainWorld(scene);
  return {
    world,
    heightAt: terrainHeight,
    mesh: world.root,
    size: CHUNK_SIZE * (VIEW_RADIUS * 2 + 1),
    rebuild(pos) {
      world.rebuild(pos);
    },
    setProfile(id, pos) {
      setTerrainProfile(id);
      world.rebuild(pos || new THREE.Vector3(0, 120, 0));
    },
  };
}

export function createTrees() {
  return { trunks: null, crowns: null };
}

/**
 * Map scenario id → terrain profile.
 * @param {string} scenarioId
 * @returns {'airfield' | 'coastal'}
 */
export function profileForScenario(scenarioId) {
  return scenarioId === 'ridge' ? 'coastal' : 'airfield';
}
