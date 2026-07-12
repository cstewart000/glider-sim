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

/**
 * Ridged multifractal — sharp crest chains (concept-art crystalline ridges).
 * Returns ~0..1 with highs along knife-edge spines.
 */
function ridgedFbm(x, z, octaves = 4) {
  let v = 0;
  let a = 1;
  let f = 1;
  let s = 0;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = smoothNoise(x * f, z * f);
    n = 1 - Math.abs(n * 2 - 1); // ridge
    n *= n;
    n *= weight;
    v += n * a;
    s += a;
    weight = clamp01(n * 1.35);
    a *= 0.5;
    f *= 2.05;
  }
  return s > 0 ? v / s : 0;
}

/**
 * Sparse crystalline peaks on a coarse grid (skyline spikes).
 * Cheap max-of-neighbors; sharp power falloff reads as drawn facets.
 */
function peakCluster(x, z, cell = 400, hScale = 1) {
  const ix = Math.floor(x / cell);
  const iz = Math.floor(z / cell);
  let h = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cz = iz + dz;
      const jx = hash2(cx * 1.71, cz * 2.37);
      const jz = hash2(cx * 3.13, cz * 0.91);
      // Skip some cells so peaks aren't a regular grid
      if (hash2(cx + 4.2, cz + 8.1) < 0.38) continue;
      const px = (cx + 0.18 + jx * 0.64) * cell;
      const pz = (cz + 0.18 + jz * 0.64) * cell;
      const ph = (55 + hash2(cx, cz + 9.4) * 240) * hScale;
      const sharp = 1.5 + hash2(cx + 2.1, cz) * 1.4;
      const rad = 70 + ph * 0.32;
      const d = Math.hypot(x - px, z - pz);
      if (d >= rad) continue;
      const t = 1 - d / rad;
      h = Math.max(h, ph * Math.pow(t, sharp));
    }
  }
  return h;
}

/** High in valleys / low on ridges — for forest placement and height carve. */
function valleyTerm(x, z) {
  const r = ridgedFbm(x * 0.0021 + 3.1, z * 0.0021 + 1.4, 3);
  return Math.pow(1 - r, 1.45);
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
 * Level field around the runway; crystalline ranges ring the horizon
 * (concept art: sharp peaks, ridgelines, carved valleys).
 */
function heightAirfield(x, z) {
  const dx = x - RW_X;
  const dz = z - RW_Z;
  const r = Math.hypot(dx, dz);

  // Soft field undulation (almost level) — open white country near strip
  let h = RW_Y - 2 + fbm(x * 0.0055, z * 0.0055, 3) * 8;
  h += fbm(x * 0.018 + 4, z * 0.018, 2) * 2.8;

  // Broad plateau so the strip sits in open country
  const plateau = Math.exp(-(r * r) / (520 * 520));
  h = h * (1 - plateau * 0.55) + RW_Y * plateau * 0.55 + h * plateau * 0.2;

  // Mid ring: crumpled ridged rises + watershed valleys (concept mid-ground)
  const midRing = smoothstep(280, 620, r) * (1 - smoothstep(900, 1400, r));
  const midRidge = ridgedFbm(x * 0.0038 + 1.2, z * 0.0038, 4);
  const midDetail = fbm(x * 0.011 + 2, z * 0.011, 2);
  h += midRing * (10 + midRidge * 62 + midDetail * 18);
  h -= midRing * valleyTerm(x, z) * 26;

  // Distant crystalline skyline — ridge chains + sparse spikes
  const far = smoothstep(520, 1050, r);
  const range = ridgedFbm(x * 0.00155 + 7, z * 0.00155 + 3, 5);
  const warp = (fbm(x * 0.0012, z * 0.0012 + 5, 2) - 0.5) * 180;
  const range2 = ridgedFbm(x * 0.0021 + warp * 0.01, z * 0.0021, 3);
  const peaks = peakCluster(x, z, 430, 1);
  h += far * (40 + range * 165 + range2 * 55 + peaks * 0.92);
  // Extra needle peaks on the outer ring
  if (r > 750) {
    const spike = peakCluster(x * 1.15 + 90, z * 1.15 - 40, 520, 0.7);
    h += far * spike * 0.55 * smoothstep(750, 1100, r);
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

  // Long final corridor (+Z past threshold only): chop hills under the 3° path.
  // Never runs on the hard runway deck (would sink the strip).
  const thrZ = RW_Z + RW_HL;
  const apprLen = 500;
  const apprHalfW = 58;
  if (!hard && z > thrZ && z < thrZ + apprLen && adx < apprHalfW) {
    const tz = clamp01((z - thrZ) / apprLen);
    const tx = adx / apprHalfW;
    // Strong near threshold / centerline; still meaningful near landing spawn
    const along = 1 - tz * tz * (0.35 + 0.65 * tz);
    const w = along * (1 - tx) * (1 - tx);
    // Field-level target with gentle rise — always ≤ path − margin, ≥ deck
    const pathClear =
      RW_Y + (z - thrZ) * Math.tan((3 * Math.PI) / 180) - 16;
    const target = Math.max(
      RW_Y - 0.12,
      Math.min(pathClear, RW_Y - 0.12 + tz * 12)
    );
    if (h > target) {
      h = h * (1 - w) + target * w;
    }
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

  const faceH =
    distCrest >= 0
      ? ridgeFaceElev(distCrest, ridgeH, windDeg)
      : ridgeFaceElev(distCrest, ridgeH, leeDeg);

  let h = base + faceH;

  // Inland alpine mass (lee of soaring ridge) — concept-art crumpled ranges
  if (z < crestZ) {
    const inland = smoothstep(crestZ + 5, crestZ - 520, z);
    const foothill = smoothstep(crestZ, crestZ - 160, z);
    const ridges = ridgedFbm(x * 0.0032 + 11, z * 0.0032, 4);
    const detail = fbm(x * 0.012 + 3, z * 0.012, 2);
    const peaks = peakCluster(x + 40, z - 80, 380, 0.55);
    h += foothill * (8 + ridges * 22 + detail * 8);
    h += inland * (ridges * 78 + detail * 20 + peaks * 0.75);
    h -= inland * valleyTerm(x * 0.95, z * 0.95) * 22;
  }

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

/**
 * Concept-art forest mass 0..1 — multi-scale density:
 * dense valley stands, medium scrub, open meadow gaps (like the drawing).
 * Drives vertex greys + tree prop density.
 */
export function forestMask(x, z, y = null) {
  const elev = y == null ? terrainHeight(x, z) : y;

  if (activeProfile === 'coastal') {
    const crest = coastalCrestZ(x);
    // Stay off open windward face, beach, high rock
    if (z > crest + 8) return 0;
    if (elev < SEA_LEVEL + 14 || elev > SEA_LEVEL + 100) return 0;
    const n = fbm(x * 0.0075 + 2.4, z * 0.0075, 3);
    const clump = fbm(x * 0.018 + 5, z * 0.018, 2);
    const fine = fbm(x * 0.04 + 1, z * 0.04, 2);
    const lee = smoothstep(crest + 6, crest - 100, z);
    const elevBand =
      smoothstep(SEA_LEVEL + 14, SEA_LEVEL + 28, elev) *
      (1 - smoothstep(SEA_LEVEL + 72, SEA_LEVEL + 100, elev));
    const valley = valleyTerm(x, z);
    // Dense core + scrubby edge
    const core = smoothstep(0.42, 0.72, n + valley * 0.25) * (0.55 + clump * 0.55);
    const scrub = smoothstep(0.28, 0.5, n) * 0.35 * (0.4 + fine * 0.6);
    return clamp01(lee * elevBand * (core + scrub));
  }

  // Airfield / XC: open strip + final corridor; forests on hills & valleys beyond
  const adx = Math.abs(x - RW_X);
  const adz = Math.abs(z - RW_Z);
  if (adx < RW_HW + 45 && adz < RW_HL + 55) return 0;
  // Keep approach corridor clear (landing finals)
  const thrZ = RW_Z + RW_HL;
  if (z > thrZ - 20 && z < thrZ + 480 && adx < 70) return 0;

  const r = Math.hypot(x - RW_X, z - RW_Z);
  if (r < 180) return 0;

  // Multi-scale cover: large stands + medium clumps + fine stipple gaps
  const large = fbm(x * 0.0038 + 1.7, z * 0.0038, 4); // big forest bodies
  const clump = fbm(x * 0.012 + 4, z * 0.012, 3); // medium patches
  const fine = fbm(x * 0.035 + 8, z * 0.035, 2); // edge freckle / openings
  const valley = valleyTerm(x, z);

  // Prefer valleys & mid slopes; allow some cover on gentle hills (concept)
  const elevBand =
    smoothstep(55, 72, elev) * (1 - smoothstep(145, 195, elev));
  // Fade in away from field; still present across XC triangle (~1 km)
  const ring =
    smoothstep(180, 320, r) * (1 - smoothstep(1600, 2200, r) * 0.55);

  // Dense stand cores — less frequent but very solid (concept ink blobs)
  const denseCore =
    smoothstep(0.52, 0.72, large + valley * 0.22) *
    smoothstep(0.4, 0.68, clump);
  const dense = denseCore * (0.92 + fine * 0.08);

  // Medium woodland around cores
  const medium =
    smoothstep(0.36, 0.58, large * 0.7 + clump * 0.5 + valley * 0.18) *
    (0.5 + fine * 0.4) *
    0.78 *
    (1 - denseCore * 0.35);

  // Light scrub freckle on open slopes
  const scrub =
    smoothstep(0.24, 0.45, large * 0.45 + clump * 0.4) *
    (0.28 + fine * 0.5) *
    0.42 *
    (1 - denseCore);

  // Small clearings only at edges of dense stands
  const clearing = smoothstep(0.78, 0.92, fine) * 0.35 * (1 - denseCore * 0.7);

  let m = Math.max(dense, medium, scrub);
  // Boost density inside cores so they read as solid ink (not sparse freckle)
  if (denseCore > 0.3) {
    m = Math.max(m, 0.72 + denseCore * 0.28);
  }
  m *= 1 - clearing;
  return clamp01(ring * elevBand * m);
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

// Low-poly canopy blobs — instanced; forest mass is mainly vertex colour
const crownGeo = new THREE.ConeGeometry(1.05, 1.7, 5);
const crownMat = fillMaterial({ color: 0x4a4a50 });
const crownMatLight = fillMaterial({ color: 0x6a6a70 }); // scrub / edge trees
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
  // —— Coastal specials (sand / wet / high rock) ——
  if (activeProfile === 'coastal') {
    const coastZ = coastalCoastZ(x, z);
    const sandW = coastalSandWidth(x);
    const sandIn = coastZ - sandW;
    if (z > sandIn - 12 && z < coastZ + 14 && y < SEA_LEVEL + 16) {
      const edge =
        smoothstep(sandIn - 12, sandIn + 5, z) *
        (1 - smoothstep(coastZ - 4, coastZ + 14, z));
      const n = lod === 'far' ? 0.5 : fbm(x * 0.05, z * 0.05, 2);
      const tint = fbm(x * 0.01 + 2, 1.4, 2);
      const r = 0.94 + n * 0.04 + tint * 0.02;
      const g = 0.9 + n * 0.03 + tint * 0.01;
      const b = 0.78 + n * 0.03 - tint * 0.02;
      if (edge > 0.12) {
        const wet = smoothstep(coastZ - 12 - sandW * 0.1, coastZ + 5, z);
        return {
          r: r * (1 - wet * 0.08) * (0.78 + edge * 0.22),
          g: g * (1 - wet * 0.05) * (0.78 + edge * 0.22),
          b: (b + wet * 0.04) * (0.78 + edge * 0.22),
        };
      }
    }
    if (y <= SEA_LEVEL + 1.2) {
      const n = fbm(x * 0.04, z * 0.04, 2);
      return { r: 0.86 + n * 0.03, g: 0.84 + n * 0.03, b: 0.78 + n * 0.03 };
    }
  }

  // —— Airfield asphalt (must stay readable) ——
  if (activeProfile === 'airfield') {
    const adx = Math.abs(x - RW_X);
    const adz = Math.abs(z - RW_Z);
    if (adx <= RW_HW + 2 && adz <= RW_HL + 2) {
      const n = lod === 'far' ? 0.5 : fbm(x * 0.08, z * 0.08, 2);
      const g = 0.42 + n * 0.04;
      return { r: g, g: g, b: g * 1.02 };
    }
    if (adx <= RW_HW + 18 && adz <= RW_HL + 22) {
      const n = lod === 'far' ? 0.5 : fbm(x * 0.05, z * 0.05, 2);
      const g = 0.58 + n * 0.05;
      return { r: g, g: g * 0.99, b: g * 0.97 };
    }
  }

  // —— Concept base: near-white fill; interest is lines + forest mass ——
  const n = lod === 'far' ? 0.45 : fbm(x * 0.018, z * 0.018, 2);
  let g = 0.94 - n * 0.035; // bright white-grey field

  // High rock / snowcap slightly brighter
  if (y > 160) g = 0.97 - n * 0.02;
  else if (y > 120) g = 0.95 - n * 0.025;
  // Rock face band: tiny cool shift so slopes read under lines
  if (y > 90 && y < 200) {
    const rock = smoothstep(90, 130, y) * (1 - smoothstep(170, 210, y));
    g -= rock * 0.03 * (0.4 + n);
  }

  // Forest / ground cover mass (concept: solid dark stands + lighter scrub)
  const forest =
    lod === 'far'
      ? forestMask(x, z, y) * 0.82
      : forestMask(x, z, y);
  if (forest > 0.04) {
    // Multi-scale stipple — dense cores near-charcoal, edges freckled
    const stipple =
      lod === 'far'
        ? 0.5
        : fbm(x * 0.08 + 3, z * 0.08, 2) * 0.6 + fbm(x * 0.24, z * 0.24, 1) * 0.4;
    // Heavier darkening so dense places match concept ink masses
    const dark =
      forest * (0.22 + forest * 0.38) + // base mass (stronger in dense)
      forest * stipple * 0.14;
    g = Math.max(0.26, g - dark);
  }

  // Coastal high ridge: slightly cooler pale rock
  if (activeProfile === 'coastal' && y > SEA_LEVEL + 70) {
    const high = smoothstep(SEA_LEVEL + 70, SEA_LEVEL + 110, y);
    g = g * (1 - high * 0.08) + 0.96 * high;
  }

  return { r: g, g: g, b: g * 0.995 };
}

/**
 * Topographic isolines from a displaced grid PlaneGeometry.
 * Cheap concept-art contour hatching (near/mid only).
 */
function addIsolines(group, geo, segs, ox, oz, lod, lineMat) {
  const pos = geo.attributes.position;
  const cols = segs + 1;
  const rows = segs + 1;
  const interval = lod === 'near' ? 26 : 40;
  const positions = [];

  function crossPoint(iA, iB, level) {
    const yA = pos.getY(iA);
    const yB = pos.getY(iB);
    const t = (level - yA) / (yB - yA);
    return {
      x: pos.getX(iA) + (pos.getX(iB) - pos.getX(iA)) * t,
      y: level + 0.45,
      z: pos.getZ(iA) + (pos.getZ(iB) - pos.getZ(iA)) * t,
    };
  }

  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const i00 = j * cols + i;
      const i10 = i00 + 1;
      const i01 = i00 + cols;
      const i11 = i01 + 1;
      const y00 = pos.getY(i00);
      const y10 = pos.getY(i10);
      const y11 = pos.getY(i11);
      const y01 = pos.getY(i01);
      const minY = Math.min(y00, y10, y11, y01);
      const maxY = Math.max(y00, y10, y11, y01);
      let level = Math.ceil((minY + 0.05) / interval) * interval;
      for (; level < maxY; level += interval) {
        const pts = [];
        const edges = [
          [i00, i10],
          [i10, i11],
          [i11, i01],
          [i01, i00],
        ];
        for (let e = 0; e < 4; e++) {
          const a = edges[e][0];
          const b = edges[e][1];
          const ya = pos.getY(a);
          const yb = pos.getY(b);
          if ((ya < level && yb >= level) || (yb < level && ya >= level)) {
            pts.push(crossPoint(a, b, level));
          }
        }
        if (pts.length === 2) {
          positions.push(
            pts[0].x,
            pts[0].y,
            pts[0].z,
            pts[1].x,
            pts[1].y,
            pts[1].z
          );
        } else if (pts.length === 4) {
          positions.push(
            pts[0].x,
            pts[0].y,
            pts[0].z,
            pts[1].x,
            pts[1].y,
            pts[1].z,
            pts[2].x,
            pts[2].y,
            pts[2].z,
            pts[3].x,
            pts[3].y,
            pts[3].z
          );
        }
      }
    }
  }

  if (positions.length < 6) return;

  // Cap mid-LOD line budget
  let buf = positions;
  if (lod === 'mid' && positions.length > 9000) {
    buf = [];
    for (let i = 0; i < positions.length; i += 12) {
      buf.push(
        positions[i],
        positions[i + 1],
        positions[i + 2],
        positions[i + 3],
        positions[i + 4],
        positions[i + 5]
      );
    }
  }

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(buf, 3));
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.position.set(ox, 0, oz);
  lines.frustumCulled = true;
  lines.renderOrder = 1;
  group.add(lines);
}

function buildChunkMesh(cx, cz, mat, edgeMatNear, edgeMatMid, isoMat, ring) {
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

  // Feature edges: dense near (concept slope hatching), soft mid, none far
  if (lod === 'near') {
    const edges = new THREE.EdgesGeometry(geo, 10);
    const outline = new THREE.LineSegments(edges, edgeMatNear);
    outline.position.copy(mesh.position);
    outline.frustumCulled = true;
    outline.renderOrder = 1;
    group.add(outline);
    addIsolines(group, geo, segs, ox, oz, lod, isoMat);
  } else if (lod === 'mid') {
    const edges = new THREE.EdgesGeometry(geo, 16);
    const outline = new THREE.LineSegments(edges, edgeMatMid);
    outline.position.copy(mesh.position);
    outline.frustumCulled = true;
    outline.renderOrder = 1;
    group.add(outline);
    addIsolines(group, geo, segs, ox, oz, lod, isoMat);
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

  // Tree props: denser near, lighter mid (concept stipple from air)
  if (lod === 'near') {
    addChunkTrees(group, originX, originZ, 1);
  } else if (lod === 'mid') {
    addChunkTrees(group, originX, originZ, 0.45);
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

/**
 * Place tree canopy instances by forest density.
 * Dense stands pack tighter; scrub edges are fewer/taller mix.
 * Uses InstancedMesh for performance at XC-scale cover.
 */
function addChunkTrees(group, originX, originZ, densityScale) {
  const rng = mulberry32(((originX * 73856093) ^ (originZ * 19349663)) >>> 0);
  // Tighter grid in dense near LOD — concept packed stands
  const cell = densityScale > 0.7 ? 18 : 36;
  const maxN = densityScale > 0.7 ? 160 : 55;
  const matrices = [];
  const matricesLight = [];
  const dummy = new THREE.Object3D();

  for (let gx = 0; gx < CHUNK_SIZE; gx += cell) {
    for (let gz = 0; gz < CHUNK_SIZE; gz += cell) {
      if (matrices.length + matricesLight.length >= maxN) break;
      const x = originX + gx + (rng() - 0.5) * cell * 0.85;
      const z = originZ + gz + (rng() - 0.5) * cell * 0.85;
      const y = terrainHeight(x, z);
      const fm = forestMask(x, z, y);
      if (fm < 0.14) continue;
      // High keep-rate in dense cores
      if (rng() > 0.08 + fm * 0.95) continue;

      // Pack tight clusters where mask is high
      const cluster =
        fm > 0.5
          ? 2 + Math.floor(rng() * 4 * densityScale)
          : fm > 0.32
            ? 1 + Math.floor(rng() * 2)
            : 1;
      for (let c = 0; c < cluster; c++) {
        if (matrices.length + matricesLight.length >= maxN) break;
        const spread = fm > 0.5 ? 9 : 14;
        const jx = x + (rng() - 0.5) * spread * (c > 0 ? 1 : 0.35);
        const jz = z + (rng() - 0.5) * spread * (c > 0 ? 1 : 0.35);
        const jy = terrainHeight(jx, jz);
        const fm2 = forestMask(jx, jz, jy);
        if (fm2 < 0.12) continue;

        // Size mix: tall packed canopy in dense, small freckles on edges
        const s =
          fm2 > 0.5
            ? 1.4 + rng() * 2.4
            : 0.65 + rng() * 1.15;
        dummy.position.set(jx, jy + 0.72 * s, jz);
        dummy.scale.set(
          s * (0.95 + rng() * 0.45),
          s * (0.7 + rng() * 0.4),
          s * (0.95 + rng() * 0.45)
        );
        dummy.rotation.set(0, rng() * Math.PI * 2, (rng() - 0.5) * 0.1);
        dummy.updateMatrix();
        if (fm2 > 0.36) matrices.push(dummy.matrix.clone());
        else matricesLight.push(dummy.matrix.clone());
      }
    }
  }

  if (matrices.length > 0) {
    const inst = new THREE.InstancedMesh(crownGeo, crownMat, matrices.length);
    for (let i = 0; i < matrices.length; i++) inst.setMatrixAt(i, matrices[i]);
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = true;
    inst.castShadow = false;
    group.add(inst);
  }
  if (matricesLight.length > 0) {
    const inst = new THREE.InstancedMesh(crownGeo, crownMatLight, matricesLight.length);
    for (let i = 0; i < matricesLight.length; i++) inst.setMatrixAt(i, matricesLight[i]);
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = true;
    group.add(inst);
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
    // Near: inked concept contours; mid: softer; isolines shared soft grey
    this.edgeMatNear = new THREE.LineBasicMaterial({
      color: 0x2a2a2e,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    this.edgeMatMid = new THREE.LineBasicMaterial({
      color: 0x3a3a40,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });
    this.isoMat = new THREE.LineBasicMaterial({
      color: 0x34343a,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
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

    const chunk = buildChunkMesh(
      scx,
      scz,
      this.mat,
      this.edgeMatNear,
      this.edgeMatMid,
      this.isoMat,
      ring
    );
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
