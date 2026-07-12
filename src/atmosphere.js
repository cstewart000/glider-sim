/**
 * Atmosphere + 3D wind field for realistic soaring.
 * - Density altitude (ISA-ish)
 * - Ambient wind with shear
 * - Orographic ridge wind (coastal)
 * - Thermal cores with lean + shell
 */

import * as THREE from 'three';
import {
  getTerrainProfile,
  ridgeFaceInfo,
  terrainHeight,
  SEA_LEVEL,
} from './terrain.js';

const RHO0 = 1.225; // sea-level ISA kg/m³
const T0 = 288.15; // K
const LAPSE = 0.0065; // K/m
const G = 9.81;
const R_AIR = 287.05;

/** Ambient wind at reference height (m/s) — light sea breeze inland, stronger on coast */
const AMBIENT = {
  airfield: { x: 1.2, z: -0.4 },
  coastal: { x: 0.5, z: -6.5 }, // onshore toward −Z (into the mountains)
};

const _wind = new THREE.Vector3();
const _amb = new THREE.Vector3();
const _ridge = new THREE.Vector3();

/**
 * Air density at geometric altitude (m ASL). ISA troposphere approx.
 */
export function airDensity(altM) {
  const h = Math.max(0, Math.min(11000, altM));
  const T = T0 - LAPSE * h;
  const p = 101325 * Math.pow(T / T0, G / (LAPSE * R_AIR));
  return p / (R_AIR * T);
}

/**
 * Density ratio σ = ρ/ρ0 (useful for TAS/IAS)
 */
export function densityRatio(altM) {
  return airDensity(altM) / RHO0;
}

/**
 * Ambient wind with logarithmic-ish shear (stronger aloft a bit, light near ground).
 */
function ambientWind(x, y, z, profile, out) {
  const base = profile === 'coastal' ? AMBIENT.coastal : AMBIENT.airfield;
  const ground = terrainHeight(x, z);
  const agl = Math.max(0, y - ground);
  // Shear: ~0.55 at surface, 1.0 by 300 m AGL
  const shear = 0.55 + 0.45 * Math.min(1, agl / 300);
  // Light gust (smooth)
  const t = performance.now() * 0.001;
  const gust = 0.15 * Math.sin(t * 0.7 + x * 0.01) + 0.1 * Math.sin(t * 1.3 + z * 0.008);
  return out.set(base.x * shear, 0, base.z * shear + gust);
}

/**
 * Orographic wind: onshore flow deflects up the windward face, lee sink/rotor.
 */
function ridgeWind(x, y, z, out) {
  if (getTerrainProfile() !== 'coastal') {
    return out.set(0, 0, 0);
  }
  const { crestZ, ridgeH, run, windDeg } = ridgeFaceInfo(x);
  const ground = terrainHeight(x, z);
  const agl = y - ground;
  if (agl < 0 || agl > ridgeH + 180) return out.set(0, 0, 0);

  const faceDist = z - crestZ; // + seaward
  if (faceDist < -run * 0.85 || faceDist > run * 1.5) return out.set(0, 0, 0);

  // Free-stream onshore speed (m/s) scaled by slope steepness
  const U = 7 + (windDeg - 30) * 0.08 + ridgeH * 0.02;
  const mid = run * 0.38;
  const face =
    faceDist >= 0
      ? Math.exp(-((faceDist - mid) ** 2) / ((run * 0.48) ** 2))
      : 0;

  // Height band along terrain-following stream
  const streamAgl =
    6 + clamp01(1 - Math.max(0, faceDist) / Math.max(run, 1)) * (14 + ridgeH * 0.4);
  const streamY = ground + streamAgl;
  const streamProx = Math.exp(-((y - streamY) ** 2) / (32 * 32));
  const heightBand =
    agl > 3 && agl < ridgeH + 90 ? 1 : agl < ridgeH + 140 ? 0.4 : 0;

  // Vertical: U * sin(θ) concentrated on face
  const theta = (windDeg * Math.PI) / 180;
  let w = U * Math.sin(theta) * face * streamProx * heightBand * 1.15;
  // Horizontal toward crest (−Z) on windward
  let vHoriz = -U * Math.cos(theta * 0.35) * (0.35 + 0.65 * face) * heightBand;

  // Lee: rotor / sink
  if (faceDist < 0) {
    const lee = Math.exp(-(faceDist * faceDist) / ((run * 0.4) ** 2));
    w = -U * 0.35 * lee * heightBand;
    vHoriz = -U * 0.25 * lee;
    vHoriz += Math.sin(x * 0.08 + performance.now() * 0.002) * lee * 1.2;
  }

  return out.set(0, w, vHoriz);
}

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Thermal wind contribution. Cores lean with ambient wind; outer shell weaker.
 * @param {import('./thermals.js').ThermalSystem | null} thermalSystem
 */
function thermalWind(x, y, z, thermalSystem) {
  if (!thermalSystem || !thermalSystem.group?.visible) {
    return { x: 0, y: 0, z: 0 };
  }
  // sampleVec returns {u,v,w} or we use enhanced sample
  if (typeof thermalSystem.sampleWind === 'function') {
    return thermalSystem.sampleWind(x, y, z);
  }
  const lift = thermalSystem.sample(x, y, z);
  return { x: 0, y: lift, z: 0 };
}

/**
 * Full wind vector at a point (m/s, world frame).
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {import('./thermals.js').ThermalSystem | null} [thermals]
 * @param {THREE.Vector3} [out]
 */
export function sampleWind(x, y, z, thermals = null, out = _wind) {
  const profile = getTerrainProfile();
  ambientWind(x, y, z, profile, _amb);
  ridgeWind(x, y, z, _ridge);
  out.copy(_amb).add(_ridge);

  const th = thermalWind(x, y, z, thermals);
  out.x += th.x || 0;
  out.y += th.y || 0;
  out.z += th.z || 0;

  return out;
}

/**
 * Vertical air-mass component only (for HUD uplift hint).
 */
export function sampleVerticalWind(x, y, z, thermals = null) {
  return sampleWind(x, y, z, thermals).y;
}

export { RHO0 };
