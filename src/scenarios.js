/**
 * Opening-menu flight scenarios — spawn + optional active forces (winch/tow).
 */

import * as THREE from 'three';
import { RUNWAY } from './runway.js';
import { terrainHeight, ridgeFaceInfo } from './terrain.js';
import { flightAudio } from './flightAudio.js';

/** @typedef {{ id: string, name: string, blurb: string, gear: number, spawn: Function, update?: Function, setupVisuals?: Function }} Scenario */

const _fwd = new THREE.Vector3();
const _force = new THREE.Vector3();

function makeSpawn(x, y, z, vx, vy, vz, pitch = -0.04, yaw = 0) {
  return {
    position: new THREE.Vector3(x, y, z),
    velocity: new THREE.Vector3(vx, vy, vz),
    quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')),
  };
}

/**
 * Active winch / tow state lives on scenarioRuntime, cleared each start.
 * Tow: tug pose + rope metrics are the single source of truth for physics & visuals.
 */
export const scenarioRuntime = {
  id: 'ridge',
  t: 0,
  phase: 'flight', // 'winch' | 'tow' | 'flight'
  released: false,
  // —— Shared aerotow state ——
  tugPos: new THREE.Vector3(),
  tugVel: new THREE.Vector3(),
  tugQuat: new THREE.Quaternion(),
  /** Ideal rope rest length (m) */
  ropeRest: 52,
  /** Current hook-to-hook distance (m) */
  ropeDist: 52,
  /** 0 = slack/none … 1 = near weak-link */
  ropeTension: 0,
  ropeSlack: true,
  /** 'ok' | 'high' | 'low' | 'left' | 'right' | 'danger' */
  station: 'ok',
  /** Vertical station error (m): + = glider above ideal */
  stationVert: 0,
  /** Lateral station error (m): + = glider right of tug track */
  stationLat: 0,
  releaseReady: false,
  weakLinkWarn: false,
  /** Accumulated tug distress 0…1 — high → abort */
  tugStress: 0,
  /** Rope pitch angle at glider (rad): + = rope above nose / high tow */
  ropePitch: 0,
  /** Rope yaw angle at glider (rad): + = rope to the right */
  ropeYaw: 0,
  /** Oscillating snatch component 0…1 for HUD */
  ropeOsc: 0,
  /** 'ok' | 'weaklink' | 'tug_abort' | 'pilot' last release cause */
  towAbort: null,
  // —— Landing approach / score ——
  landingActive: false,
  /** Horizontal distance to threshold (m) */
  landDist: 0,
  /** Height above runway elevation (m) */
  landAgl: 0,
  /** 'on' | 'high' | 'low' */
  landPath: 'on',
  /** meters above/below 3° path (+ = high) */
  landPathErr: 0,
  /** 'ok' | 'high' | 'low' approach IAS band */
  landIas: 'ok',
  /** lateral offset from centerline (m), + = right */
  landAlign: 0,
  landGearOk: true,
  /** 0–4 style PAPI (2 = on path): number of white lights from left */
  landPapiWhite: 2,
  landScored: false,
  /** @type {null | { total: number, grade: string, debrief: string[], detail: object }} */
  landScore: null,
  /** Track if brakes used on final */
  landBrakesUsed: false,
  landWasRolling: false,
  /** Sink rate at first touchdown (m/s, positive down) */
  landTouchSink: 0,
  landTouchSpd: 0,
  landTouchZ: 0,
  landTouchX: 0,
  /** 'base' | 'final' | 'over' approach phase for HUD */
  landPhase: 'final',
  // —— Cross country task ——
  xcActive: false,
  /** Index into XC_WAYPOINTS */
  xcWp: 0,
  /** Distance to current turnpoint (m) */
  xcDist: 0,
  /** Bearing to TP deg (0 = north / −Z) */
  xcBearing: 0,
  /** Legs completed */
  xcLegs: 0,
  xcDone: false,
  /** Cumulative horizontal distance flown this task (m) */
  xcTrack: 0,
  /** Best altitude this flight (m AGL approx via y) */
  xcMaxAlt: 0,
  /** Last position for track integration */
  xcLastX: 0,
  xcLastZ: 0,
  /** @type {null | { total: number, grade: string, debrief: string[], detail: object }} */
  xcScore: null,
  xcScored: false,
};

/**
 * FAI-style triangle turnpoints (airfield world).
 * Cylinders ~150 m; home is the runway.
 * Thermals cluster near these spots so the task is soarable.
 */
export const XC_WAYPOINTS = [
  { id: 'tp1', name: 'TP1 · Quarry', x: 420, z: -520, r: 150 },
  { id: 'tp2', name: 'TP2 · Ridge Line', x: -480, z: -380, r: 150 },
  { id: 'home', name: 'HOME · Field', x: RUNWAY.x, z: RUNWAY.z, r: 180 },
];

/** Approach threshold (near +Z end); landings fly toward −Z. */
export function runwayThresholdZ() {
  return RUNWAY.z + RUNWAY.halfLength;
}

/** 3° glide path height above runway at distance d from threshold (m). */
export function glidePathHeight(distToThreshold) {
  return Math.max(0, distToThreshold) * Math.tan((3 * Math.PI) / 180);
}

/**
 * Update approach metrics for landing scenario.
 * @param {import('./physics.js').GliderPhysics} physics
 * @param {{ brakes?: number, gear?: number }} ctrl
 */
function updateLandingApproach(physics, ctrl) {
  const thrZ = runwayThresholdZ();
  const x = physics.position.x;
  const z = physics.position.z;
  const y = physics.position.y;

  // Distance along approach: how far past threshold toward approach end (+Z)
  const dist = z - thrZ; // >0 still on final; <0 past threshold
  scenarioRuntime.landDist = dist;
  scenarioRuntime.landAgl = y - RUNWAY.y;
  scenarioRuntime.landAlign = x - RUNWAY.x;

  // Phase: large lateral offset / not yet on the extended centerline → base
  const lat = Math.abs(x - RUNWAY.x);
  if (dist < -20) scenarioRuntime.landPhase = 'over';
  else if (lat > 55 || (lat > 28 && dist > 80)) scenarioRuntime.landPhase = 'base';
  else scenarioRuntime.landPhase = 'final';

  // Ideal height on 3° path (only meaningful on final / near centerline)
  const pathDist = Math.max(0, dist);
  const idealAgl = glidePathHeight(pathDist);
  const pathErr = scenarioRuntime.landAgl - idealAgl;
  scenarioRuntime.landPathErr = pathErr;

  // Path band grows slightly with distance; looser while still on base
  const band =
    (8 + pathDist * 0.02) * (scenarioRuntime.landPhase === 'base' ? 1.6 : 1);
  if (pathErr > band) scenarioRuntime.landPath = 'high';
  else if (pathErr < -band) scenarioRuntime.landPath = 'low';
  else scenarioRuntime.landPath = 'on';

  // PAPI: 4 lights — more white = higher (classic)
  // err large positive → all white; large negative → all red
  if (pathErr > band * 1.4) scenarioRuntime.landPapiWhite = 4;
  else if (pathErr > band * 0.45) scenarioRuntime.landPapiWhite = 3;
  else if (pathErr > -band * 0.45) scenarioRuntime.landPapiWhite = 2;
  else if (pathErr > -band * 1.4) scenarioRuntime.landPapiWhite = 1;
  else scenarioRuntime.landPapiWhite = 0;

  // Approach speed band (EAS m/s): ~22–32 ok for this glider
  const ias = physics.airspeed;
  if (ias > 34) scenarioRuntime.landIas = 'high';
  else if (ias < 20) scenarioRuntime.landIas = 'low';
  else scenarioRuntime.landIas = 'ok';

  scenarioRuntime.landGearOk = (ctrl?.gear ?? 1) > 0.5;
  if ((ctrl?.brakes ?? 0) > 0.2 && scenarioRuntime.landAgl < 120) {
    scenarioRuntime.landBrakesUsed = true;
  }

  // Capture touchdown snapshot once
  if (physics.rolling && !scenarioRuntime.landWasRolling) {
    scenarioRuntime.landTouchSink = Math.max(0, -physics.vario);
    // prefer actual vertical speed if available
    if (physics.velocity) {
      scenarioRuntime.landTouchSink = Math.max(0, -physics.velocity.y);
    }
    scenarioRuntime.landTouchSpd = physics.airspeed;
    scenarioRuntime.landTouchZ = z;
    scenarioRuntime.landTouchX = x;
  }
  scenarioRuntime.landWasRolling = !!physics.rolling;

  // Score when flight ends after a landing attempt
  if (
    scenarioRuntime.landingActive &&
    !scenarioRuntime.landScored &&
    !physics.alive &&
    (physics.grounded || physics.landingQuality)
  ) {
    scenarioRuntime.landScore = scoreLanding(physics);
    scenarioRuntime.landScored = true;
  }
}

/**
 * Cross-country triangle: cylinder turnpoints + home.
 * @param {import('./physics.js').GliderPhysics} physics
 * @param {number} dt
 */
function updateCrossCountry(physics, dt) {
  if (!scenarioRuntime.xcActive || scenarioRuntime.xcDone) return;

  const x = physics.position.x;
  const z = physics.position.z;
  const y = physics.position.y;

  // Track distance flown
  const dx = x - scenarioRuntime.xcLastX;
  const dz = z - scenarioRuntime.xcLastZ;
  const step = Math.hypot(dx, dz);
  if (step < 80) scenarioRuntime.xcTrack += step; // ignore teleports
  scenarioRuntime.xcLastX = x;
  scenarioRuntime.xcLastZ = z;

  const agl = y - RUNWAY.y;
  if (agl > scenarioRuntime.xcMaxAlt) scenarioRuntime.xcMaxAlt = agl;

  const wp = XC_WAYPOINTS[scenarioRuntime.xcWp];
  if (!wp) return;

  const ddx = wp.x - x;
  const ddz = wp.z - z;
  const dist = Math.hypot(ddx, ddz);
  scenarioRuntime.xcDist = dist;
  // Bearing: 0 = −Z (runway heading / “north” in this world)
  scenarioRuntime.xcBearing =
    ((Math.atan2(ddx, -ddz) * 180) / Math.PI + 360) % 360;

  if (dist < wp.r) {
    scenarioRuntime.xcLegs += 1;
    scenarioRuntime.xcWp += 1;
    if (scenarioRuntime.xcWp >= XC_WAYPOINTS.length) {
      scenarioRuntime.xcDone = true;
      scenarioRuntime.xcWp = XC_WAYPOINTS.length - 1;
      scenarioRuntime.xcScore = scoreCrossCountry(physics);
      scenarioRuntime.xcScored = true;
    }
  }

  // Score out-landing / crash
  if (
    !scenarioRuntime.xcScored &&
    !physics.alive &&
    (physics.grounded || physics.landingQuality)
  ) {
    scenarioRuntime.xcScore = scoreCrossCountry(physics);
    scenarioRuntime.xcScored = true;
  }
}

/**
 * Score XC triangle: legs, height management, finish.
 * @param {import('./physics.js').GliderPhysics} physics
 */
export function scoreCrossCountry(physics) {
  const debrief = [];
  const detail = {};
  let total = 0;

  const legs = scenarioRuntime.xcLegs;
  const done = scenarioRuntime.xcDone;
  const trackKm = scenarioRuntime.xcTrack / 1000;
  const maxAlt = scenarioRuntime.xcMaxAlt;

  // Legs (3 = full triangle → 45 pts)
  let legPts = Math.min(45, legs * 15);
  if (done) {
    legPts = 45;
    debrief.push('Triangle complete — all turnpoints claimed.');
  } else if (legs === 2) {
    debrief.push('Two turnpoints — almost home.');
  } else if (legs === 1) {
    debrief.push('First turnpoint in the bag.');
  } else {
    debrief.push('No turnpoints yet — circle the yellow thermal columns.');
  }
  detail.legs = legPts;
  total += legPts;

  // Distance / endurance (max 20)
  let distPts = 3;
  if (trackKm > 8) distPts = 20;
  else if (trackKm > 5) distPts = 14;
  else if (trackKm > 2.5) distPts = 8;
  detail.distance = distPts;
  total += distPts;
  debrief.push(`Track flown: ${trackKm.toFixed(1)} km.`);

  // Height management (max 15)
  let altPts = 4;
  if (maxAlt > 320) {
    altPts = 15;
    debrief.push('Good height — climbed in lift.');
  } else if (maxAlt > 220) {
    altPts = 10;
    debrief.push('Some climb achieved.');
  } else {
    debrief.push('Stayed low — thermals help stay aloft.');
  }
  detail.altitude = altPts;
  total += altPts;

  // Finish quality (max 20)
  if (done && !physics.alive && physics.onRunway) {
    total += 20;
    debrief.push('Finished and landed back on the field.');
  } else if (done) {
    total += 12;
    debrief.push('Task finished — land when ready.');
  } else if (physics.landingQuality === 'crash') {
    total = Math.max(0, total - 15);
    debrief.push('Flight ended in a crash.');
  } else if (!physics.alive) {
    total = Math.max(0, total - 5);
    debrief.push('Out-landing before completing the triangle.');
  }

  total = THREE.MathUtils.clamp(Math.round(total), 0, 100);
  let grade = 'F';
  if (done && total >= 85) grade = 'A';
  else if (done && total >= 70) grade = 'B';
  else if (legs >= 2 || total >= 55) grade = 'C';
  else if (total >= 35) grade = 'D';

  return {
    total,
    grade,
    debrief,
    detail: { ...detail, legs, trackKm, maxAlt, done },
  };
}

/**
 * Score landing quality with debrief bullets.
 * @param {import('./physics.js').GliderPhysics} physics
 */
export function scoreLanding(physics) {
  const thrZ = runwayThresholdZ();
  const len = RUNWAY.halfLength * 2;
  // Prefer landing-scenario samples; else physics touchdown snapshot
  const tz =
    scenarioRuntime.landTouchZ ||
    physics.touchZ ||
    physics.position.z;
  const tx =
    scenarioRuntime.landTouchX ||
    physics.touchX ||
    physics.position.x;
  const sink =
    scenarioRuntime.landTouchSink ||
    physics.touchSink ||
    0;
  const bank = Math.abs(
    physics.touchBank ?? physics.rollAngle?.() ?? 0
  );
  const onRw = physics.onRunway;
  const q = physics.landingQuality;

  let total = 100;
  const debrief = [];
  const detail = {};

  // —— Touchdown zone (first third of strip from threshold toward −Z) ——
  const zoneStart = thrZ; // approach end
  const zoneEnd = thrZ - len / 3;
  // Good if z between zoneEnd and zoneStart (and on runway)
  const inZone = onRw && tz <= zoneStart + 5 && tz >= zoneEnd - 10;
  const pastEnd = tz < RUNWAY.z - RUNWAY.halfLength;
  const shortField = tz > thrZ + 15; // landed before threshold
  let zonePts = 25;
  if (q === 'crash') {
    zonePts = 0;
    debrief.push('Hard impact — not a usable landing.');
  } else if (inZone) {
    zonePts = 25;
    debrief.push('Touchdown in the zone (first third of the strip).');
  } else if (onRw && tz < zoneEnd) {
    zonePts = 14;
    debrief.push('Long — touched down past the aiming zone.');
    total -= 8;
  } else if (shortField) {
    zonePts = 6;
    debrief.push('Short — undershot the threshold.');
    total -= 16;
  } else if (!onRw) {
    zonePts = 4;
    debrief.push('Off the runway — field landing.');
    total -= 18;
  } else {
    zonePts = 12;
    debrief.push('On pavement but outside the ideal zone.');
    total -= 6;
  }
  detail.zone = zonePts;

  // —— Sink rate ——
  let sinkPts = 25;
  if (sink < 1.2) {
    sinkPts = 25;
    debrief.push('Soft touchdown sink rate.');
  } else if (sink < 2.5) {
    sinkPts = 18;
    debrief.push('Acceptable sink — a bit firm.');
    total -= 5;
  } else if (sink < 4.5) {
    sinkPts = 8;
    debrief.push('Firm arrival — more flare next time.');
    total -= 12;
  } else {
    sinkPts = 0;
    debrief.push('Heavy arrival — high sink at touchdown.');
    total -= 20;
  }
  detail.sink = sinkPts;

  // —— Alignment ——
  const lat = Math.abs(tx - RUNWAY.x);
  let alignPts = 20;
  if (lat < 4) {
    alignPts = 20;
    debrief.push('Good centerline alignment.');
  } else if (lat < 9) {
    alignPts = 12;
    debrief.push('Slightly off centerline.');
    total -= 5;
  } else {
    alignPts = 4;
    debrief.push('Poor alignment — wide of the centerline.');
    total -= 12;
  }
  if (bank > 0.35) {
    alignPts = Math.max(0, alignPts - 8);
    debrief.push('Wings not level at touchdown.');
    total -= 8;
  }
  detail.align = alignPts;

  // —— Configuration ——
  let cfgPts = 15;
  // landGearOk is set during landing scenario; free-flight uses physics gear / default DN
  const gearOk =
    scenarioRuntime.landGearOk !== undefined
      ? !!scenarioRuntime.landGearOk
      : true;
  if (!gearOk) {
    cfgPts = 0;
    debrief.push('Gear was up — belly risk.');
    total -= 20;
  } else {
    debrief.push('Gear down for landing.');
  }
  if (scenarioRuntime.landBrakesUsed) {
    cfgPts = Math.min(15, cfgPts + 0);
    // small bonus already in total
  } else if (scenarioRuntime.landIas === 'high' || scenarioRuntime.landPath === 'high') {
    debrief.push('Hot/high final — airbrakes would help bleed energy.');
    total -= 6;
    cfgPts = Math.max(5, cfgPts - 5);
  } else {
    debrief.push('Energy was manageable on final.');
  }
  detail.config = cfgPts;

  // —— Energy / IAS memory ——
  let energyPts = 15;
  if (scenarioRuntime.landIas === 'high') {
    energyPts = 6;
    debrief.push('Approach speed was high.');
    total -= 8;
  } else if (scenarioRuntime.landIas === 'low') {
    energyPts = 8;
    debrief.push('Approach speed was low — near the backside.');
    total -= 6;
  } else {
    energyPts = 15;
    debrief.push('Approach speed in the slot.');
  }
  detail.energy = energyPts;

  // Roll-out
  if (physics.rollDistance > 1 && onRw) {
    debrief.push(`Roll-out ${physics.rollDistance.toFixed(0)} m.`);
  }
  if (pastEnd && onRw) {
    debrief.push('Used most of the strip — watch speed next time.');
    total -= 5;
  }

  total = Math.max(0, Math.min(100, Math.round(total)));
  // Prefer physics grade but upgrade messaging from score
  let grade = q || 'rough';
  if (q !== 'crash') {
    if (total >= 85 && onRw) grade = 'runway';
    else if (total >= 65) grade = 'good';
    else grade = 'rough';
  }

  // Cap debrief length
  const unique = [];
  for (const line of debrief) {
    if (!unique.includes(line)) unique.push(line);
  }

  return {
    total,
    grade,
    debrief: unique.slice(0, 6),
    detail,
  };
}

const _tugFwd = new THREE.Vector3();
const _tugUp = new THREE.Vector3();
const _tugRight = new THREE.Vector3();
const _hookG = new THREE.Vector3();
const _hookT = new THREE.Vector3();
const _rope = new THREE.Vector3();

/** Ideal formation: slightly below and behind the tug (classic low tow). */
const TOW_BEHIND = 47;
const TOW_BELOW = 6;
const TOW_REST = 50;
const WEAK_LINK_G = 2.0; // × weight — room for takeoff; still breakable off-station
const WARN_G = 1.4;
/** Tug aborts when cumulative distress hits this */
const TUG_ABORT_STRESS = 1.0;

// Oscillator state for snatch loads (underdamped rope / whip)
let _towStretch = 0;
let _towStretchV = 0;
let _towOscPhase = 0;
let _towPrevTen = 0;
/** Low-pass filtered tension (N) — keeps forces from frame-snatching */
let _towSmoothTen = 0;

/** Tug ground roll duration before rotate (s) */
const TUG_TAKEOFF_T = 7.5;
/** Tug starts this far ahead of glider along −Z (m) */
const TUG_START_AHEAD = 52;

/**
 * Tug: standing start → ground roll → climb-out.
 * Bad rope loads slow the climb, increase weave, and bank the tug (upset).
 */
/** Ground-roll accel (m/s²) — shared so lift-off state matches airborne start */
const TUG_ACCEL = 4.2;
/** Nose-up at lift-off (rad) */
const TUG_LIFT_PITCH = 0.18;
/** Vertical rate at wheels-up (m/s) — continuous into climb */
const TUG_LIFT_VY = 1.2;
/** CG height gain during rotate (m) */
const TUG_ROTATE_LIFT = 0.72;

function updateTugState(t, dt) {
  const stress = scenarioRuntime.tugStress || 0;
  const prev = scenarioRuntime.tugPos.clone();

  // Glider start z (same as tow spawn) used as reference
  const gliderStartZ = RUNWAY.z + RUNWAY.halfLength - 40;
  const tugStartZ = gliderStartZ - TUG_START_AHEAD; // ahead toward −Z
  const gearY = RUNWAY.y + 2.4; // tug CG approx on gear
  const loftS = 0.5 * TUG_ACCEL * TUG_TAKEOFF_T * TUG_TAKEOFF_T;
  const liftSpd = TUG_ACCEL * TUG_TAKEOFF_T;
  const liftY = gearY + TUG_ROTATE_LIFT;

  if (t < TUG_TAKEOFF_T) {
    // Ground roll: a ≈ 4 m/s², s = ½at² → continuous rotate into lift-off
    const s = 0.5 * TUG_ACCEL * t * t;
    const spd = TUG_ACCEL * t;
    const rotT = 1.4;
    const rotStart = TUG_TAKEOFF_T - rotT;
    const rotBlend =
      t > rotStart ? THREE.MathUtils.smoothstep(t, rotStart, TUG_TAKEOFF_T) : 0;
    const pitchUp = 0.02 + rotBlend * (TUG_LIFT_PITCH - 0.02);
    // CG rises smoothly with rotate (no step at airborne handoff)
    const y = gearY + rotBlend * TUG_ROTATE_LIFT;
    const vy = rotBlend * TUG_LIFT_VY;
    scenarioRuntime.tugPos.set(0, y, tugStartZ - s);
    scenarioRuntime.tugVel.set(0, vy, -spd);
    _tugFwd.set(0, Math.sin(pitchUp), -Math.cos(pitchUp)).normalize();
    _tugUp.set(0, 1, 0);
    _tugRight.set(1, 0, 0);
    _tugUp.crossVectors(_tugFwd, _tugRight).normalize();
    _tugRight.crossVectors(_tugUp, _tugFwd).normalize();
  } else {
    // Airborne: position/velocity continuous with lift-off state
    const ta = t - TUG_TAKEOFF_T;
    const climbTarget = 10.5 * (1 - 0.55 * stress);
    const fwdTarget = 30 * (1 - 0.25 * stress);
    // Exponential approach of rates → y,z and ẏ,ż match at ta=0
    // s(ta) = v∞·ta − (v∞−v0)·τ·(1−e^{−ta/τ})
    // s(0)=0, s'(0)=v0, s'(∞)=v∞
    const tauY = 2.8;
    const tauZ = 2.2;
    const eY = Math.exp(-ta / tauY);
    const eZ = Math.exp(-ta / tauZ);
    const dY =
      climbTarget * ta - (climbTarget - TUG_LIFT_VY) * tauY * (1 - eY);
    const dS =
      fwdTarget * ta - (fwdTarget - liftSpd) * tauZ * (1 - eZ);
    const baseY = liftY + dY;
    const baseZ = tugStartZ - loftS - dS;
    // Weave / bob fade in after lift-off (no lateral pop)
    const airRamp = THREE.MathUtils.smoothstep(ta, 0, 5);
    const weaveAmp = 4 + stress * 18 + (scenarioRuntime.ropeOsc || 0) * 6;
    const weave =
      Math.sin(ta * (0.45 + stress * 0.7) + (scenarioRuntime.ropeOsc || 0) * 0.5) *
      weaveAmp *
      airRamp;
    const bob =
      (Math.sin(ta * (0.55 + stress * 0.8)) * (0.7 + stress * 3) +
        Math.sin(ta * 1.1) * (scenarioRuntime.ropeOsc || 0) * 0.8) *
      airRamp;
    scenarioRuntime.tugPos.set(weave, baseY + bob, baseZ);

    // Analytic rates (stable vs finite-diff on bob/weave)
    const vy = climbTarget - (climbTarget - TUG_LIFT_VY) * eY;
    const vz = -(fwdTarget - (fwdTarget - liftSpd) * eZ);
    // Weave/bob derivative is small; blend finite-diff for those only
    if (dt > 1e-6) {
      const dPos = scenarioRuntime.tugPos.clone().sub(prev).multiplyScalar(1 / dt);
      scenarioRuntime.tugVel.set(
        dPos.x,
        THREE.MathUtils.lerp(vy, dPos.y, 0.35),
        THREE.MathUtils.lerp(vz, dPos.z, 0.35)
      );
    } else {
      scenarioRuntime.tugVel.set(0, vy, vz);
    }

    // Attitude: blend lift-off pitch into flight-path pitch (no instant snap)
    const pathPitch = Math.atan2(
      Math.max(0.05, scenarioRuntime.tugVel.y),
      Math.max(8, -scenarioRuntime.tugVel.z)
    );
    const attBlend = THREE.MathUtils.smoothstep(ta, 0, 2.5);
    const pitch = THREE.MathUtils.lerp(TUG_LIFT_PITCH, pathPitch, attBlend);
    _tugFwd.set(0, Math.sin(pitch), -Math.cos(pitch)).normalize();
    // Slight heading follow from lateral velocity
    if (Math.abs(scenarioRuntime.tugVel.x) > 0.15) {
      const yaw = Math.atan2(scenarioRuntime.tugVel.x, -scenarioRuntime.tugVel.z);
      _tugFwd.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw * 0.85);
      _tugFwd.normalize();
    }
    _tugUp.set(0, 1, 0);
    _tugRight.crossVectors(_tugUp, _tugFwd).normalize();
    _tugUp.crossVectors(_tugFwd, _tugRight).normalize();
    const bank =
      (-Math.sin(ta * (0.45 + stress * 0.6)) * (0.08 + stress * 0.45) -
        (scenarioRuntime.stationLat || 0) * 0.008 * stress) *
      airRamp;
    _tugUp.applyAxisAngle(_tugFwd, THREE.MathUtils.clamp(bank, -0.55, 0.55));
    _tugRight.crossVectors(_tugUp, _tugFwd).normalize();
  }

  const m = new THREE.Matrix4().makeBasis(
    _tugRight,
    _tugUp,
    _tugFwd.clone().negate()
  );
  scenarioRuntime.tugQuat.setFromRotationMatrix(m);
}

/**
 * Nose hook (glider) and tail hook (tug) world positions.
 */
function towHooks(physics) {
  _fwd.set(0, 0, -1).applyQuaternion(physics.quaternion);
  _hookG.copy(physics.position).addScaledVector(_fwd, 2.2).addScaledVector(
    new THREE.Vector3(0, 1, 0).applyQuaternion(physics.quaternion),
    -0.15
  );
  // Tug tail hook: slightly below and aft of tug origin
  _tugFwd.set(0, 0, -1).applyQuaternion(scenarioRuntime.tugQuat);
  _tugUp.set(0, 1, 0).applyQuaternion(scenarioRuntime.tugQuat);
  _hookT
    .copy(scenarioRuntime.tugPos)
    .addScaledVector(_tugFwd, -2.4)
    .addScaledVector(_tugUp, -0.35);
  return { glider: _hookG, tug: _hookT };
}

export const SCENARIOS = {
  cable: {
    id: 'cable',
    name: 'Cable launch',
    blurb:
      'Winch launch — accelerate on the strip, rotate, then kite steeply on the cable. R releases.',
    gear: 1,
    terrain: 'airfield',
    spawn() {
      // Standing start on runway (gear on deck)
      const z0 = RUNWAY.z + RUNWAY.halfLength - 55;
      return makeSpawn(0, RUNWAY.y + 1.05, z0, 0, 0, 0, 0.01, 0);
    },
    /** @param {import('./physics.js').GliderPhysics} physics */
    onStart(physics) {
      scenarioRuntime.phase = 'winch';
      scenarioRuntime.released = false;
      scenarioRuntime.t = 0;
      scenarioRuntime._winchAir = false;
      scenarioRuntime._winchAirT = 0;
      physics.suppressGround = true;
      physics.rolling = false;
      physics.grounded = false;
      if (physics.velocity) physics.velocity.set(0, 0, 0);
      if (physics.omega) physics.omega.set(0, 0, 0);
    },
    /**
     * Classic winch: ground roll → rotate → kite (steep pitch on the cable).
     * Ground phase is pinned to the deck so rolling physics cannot kill accel.
     * @param {import('./physics.js').GliderPhysics} physics
     */
    update(physics, dt) {
      if (scenarioRuntime.phase !== 'winch' || scenarioRuntime.released) return;
      scenarioRuntime.t += dt;
      const t = scenarioRuntime.t;
      const agl = physics.position.y - RUNWAY.y;
      const spd = Math.hypot(physics.velocity.x, physics.velocity.z);

      // Winch drum at far end of strip, on the ground
      const winchPt = new THREE.Vector3(
        0,
        RUNWAY.y + 0.8,
        RUNWAY.z - RUNWAY.halfLength - 70
      );

      const fwdB = new THREE.Vector3(0, 0, -1).applyQuaternion(physics.quaternion);
      const upB = new THREE.Vector3(0, 1, 0).applyQuaternion(physics.quaternion);
      const hook = physics.position
        .clone()
        .addScaledVector(fwdB, 1.6)
        .addScaledVector(upB, -0.3);

      _fwd.copy(winchPt).sub(hook);
      const dist = Math.max(3, _fwd.length());
      _fwd.multiplyScalar(1 / dist);

      // Spool-up → full power → ease only very high
      const power =
        t < 1.0 ? 0.6 + t * 0.45 : t < 14 ? 1.1 : Math.max(0.35, 1.1 - (t - 14) / 10);
      const mass = 380;
      const weight = mass * 9.81;
      const Tmax = weight * 2.05 * power;

      const vAlong = physics.velocity.dot(_fwd);
      const reelWant = t < 2 ? 14 + t * 6 : 26 + power * 6;
      let tension = THREE.MathUtils.clamp(
        Tmax * 0.55 + (reelWant + vAlong) * mass * 2.8,
        0,
        Tmax
      );
      if (vAlong > 5) tension *= 0.25;

      if (tension > weight * 2.4) {
        releaseLaunch(physics, { weakLink: true });
        return;
      }

      // —— Phases ——
      const rotateSpd = 15;
      if (!scenarioRuntime._winchAir && (spd >= rotateSpd || t > 4.5)) {
        scenarioRuntime._winchAir = true;
        scenarioRuntime._winchAirT = t;
      }
      const airborne = !!scenarioRuntime._winchAir;
      const sinceAir = airborne ? t - (scenarioRuntime._winchAirT || t) : 0;

      physics.suppressGround = true;
      physics.rolling = false;
      physics.grounded = false;

      // Pitch schedule
      let targetPitch = 0.03;
      if (!airborne) {
        targetPitch = spd > 10 ? 0.05 + (spd - 10) * 0.012 : 0.02;
        // Pin to deck — pure acceleration along strip
        physics.position.y = RUNWAY.y + 1.05;
        physics.velocity.y = 0;
        physics.velocity.x *= 0.8;
        // Cable accel (mostly −Z)
        physics.velocity.addScaledVector(_fwd, (tension / mass) * dt);
        // Guarantee forward accel on roll
        physics.velocity.z -= (tension / mass) * 0.85 * dt;
      } else {
        // Kite: circular-ish climb on the cable (swing up while reeling in)
        const kiteT = THREE.MathUtils.clamp(sinceAir / 5.5, 0, 1);
        const kiteEase = kiteT * kiteT * (3 - 2 * kiteT);
        const topEase = THREE.MathUtils.clamp(1 - (agl - 320) / 120, 0.5, 1);
        targetPitch = THREE.MathUtils.lerp(0.25, 0.75, kiteEase) * topEase; // ~43°

        // Work done by winch → gain altitude (main kite energy source)
        // dE = T * reel_speed; put most of it into height
        const reelSpeed = Math.max(0, -vAlong + 4); // m/s cable shortening
        const powerW = tension * Math.max(reelSpeed, 8);
        const climbBoost = (powerW / (mass * 9.81)) * 0.92; // m/s equivalent
        physics.velocity.y += climbBoost * dt * 9.5;

        // Keep pulling along cable (shortens radius of the kite arc)
        physics.velocity.addScaledVector(_fwd, (tension / mass) * 0.65 * dt);

        // Align flight path with pitch (positive AoA, not pure stall)
        const horiz = Math.hypot(physics.velocity.x, physics.velocity.z);
        const spd3 = Math.max(12, physics.velocity.length());
        const wantPath = Math.min(targetPitch * 0.78, 0.62);
        const pathNow = Math.atan2(physics.velocity.y, Math.max(1, horiz));
        const pathAng = pathNow + (wantPath - pathNow) * (1 - Math.exp(-2.2 * dt));
        const hSpd = Math.cos(pathAng) * spd3;
        physics.velocity.x *= 0.9;
        physics.velocity.z = -Math.abs(hSpd);
        physics.velocity.y = Math.max(physics.velocity.y, Math.sin(pathAng) * spd3);

        // Soft speed floor so the kite doesn't fall out of the air
        const spdNow = physics.velocity.length();
        if (spdNow < 14 && agl < 350) {
          physics.velocity.multiplyScalar(14 / Math.max(spdNow, 1));
        }
      }

      // Auto-release near top of useful launch
      if (agl > 360 || (sinceAir > 12 && agl > 200) || (t > 20 && agl > 120)) {
        releaseLaunch(physics);
        return;
      }

      const e = new THREE.Euler().setFromQuaternion(physics.quaternion, 'YXZ');
      const lag = 1 - Math.exp(-(airborne ? 3.5 : 2.2) * dt);
      e.x = THREE.MathUtils.lerp(e.x, targetPitch, lag);
      e.z = THREE.MathUtils.lerp(e.z, 0, 1 - Math.exp(-4 * dt));
      e.y = THREE.MathUtils.lerp(e.y, 0, 1 - Math.exp(-2.5 * dt));
      physics.quaternion.setFromEuler(e);
      if (physics.omega) {
        physics.omega.x *= 0.8;
        physics.omega.y *= 0.8;
        physics.omega.z *= 0.7;
      }

      physics.airspeed = physics.velocity.length();
      physics.tas = physics.airspeed;
    },
  },

  landing: {
    id: 'landing',
    name: 'Landing',
    blurb:
      'High right base — not lined up. Turn final, capture the 3° path, gear down, flare on centerline. Brakes after touchdown.',
    gear: 1,
    terrain: 'airfield',
    spawn() {
      // High right base: offset laterally, past threshold, NOT on centerline.
      // Pilot must turn, lose height, and establish a final.
      const thrZ = RUNWAY.z + RUNWAY.halfLength;
      const x0 = 420; // well right of strip
      const z0 = thrZ + 160; // abeam / short base, not a long final
      const ground = terrainHeight(x0, z0);
      // ~230 m above runway — high enough for a base → final pattern
      const y0 = Math.max(RUNWAY.y + 230, ground + 90);
      // Heading −X (toward centerline), slight sink, some −Z for base geometry
      // yaw = −π/2 → nose along −X
      return makeSpawn(x0, y0, z0, -20, -1.8, -10, -0.04, -Math.PI / 2);
    },
    onStart(physics) {
      scenarioRuntime.phase = 'flight';
      scenarioRuntime.released = true;
      scenarioRuntime.t = 0;
      scenarioRuntime.landingActive = true;
      scenarioRuntime.landScored = false;
      scenarioRuntime.landScore = null;
      scenarioRuntime.landBrakesUsed = false;
      scenarioRuntime.landWasRolling = false;
      scenarioRuntime.landTouchSink = 0;
      scenarioRuntime.landPhase = 'base';
      scenarioRuntime.xcActive = false;
      if (physics) {
        physics.landingQuality = 'crash';
      }
    },
    /** Track approach phase / speed / config; score on stop. */
    update(physics, dt, ctrl) {
      if (!scenarioRuntime.landingActive) return;
      scenarioRuntime.t += dt;
      updateLandingApproach(physics, ctrl || {});
    },
  },

  crosscountry: {
    id: 'crosscountry',
    name: 'Cross country',
    blurb:
      'Triangle task after a high release. Circle yellow thermals, claim TP1 → TP2 → HOME. Stay aloft and close the task.',
    gear: 0,
    terrain: 'airfield',
    spawn() {
      // High free release near the field, pointed toward TP1 (SE/NE of field)
      const x0 = -40;
      const z0 = RUNWAY.z - 60;
      const ground = terrainHeight(x0, z0);
      const y0 = Math.max(RUNWAY.y + 380, ground + 300);
      // Cruise toward first TP (~420, −520): roughly −Z with a little +X
      const yaw = Math.atan2(0.35, 1); // slight right of runway heading
      const spd = 28;
      const vx = Math.sin(yaw) * spd;
      const vz = -Math.cos(yaw) * spd;
      return makeSpawn(x0, y0, z0, vx, -0.6, vz, -0.03, yaw);
    },
    onStart(physics) {
      scenarioRuntime.phase = 'flight';
      scenarioRuntime.released = true;
      scenarioRuntime.t = 0;
      scenarioRuntime.landingActive = false;
      scenarioRuntime.xcActive = true;
      scenarioRuntime.xcWp = 0;
      scenarioRuntime.xcLegs = 0;
      scenarioRuntime.xcDone = false;
      scenarioRuntime.xcTrack = 0;
      scenarioRuntime.xcMaxAlt = 0;
      scenarioRuntime.xcDist = 0;
      scenarioRuntime.xcBearing = 0;
      scenarioRuntime.xcScore = null;
      scenarioRuntime.xcScored = false;
      if (physics) {
        scenarioRuntime.xcLastX = physics.position.x;
        scenarioRuntime.xcLastZ = physics.position.z;
        scenarioRuntime.xcMaxAlt = physics.position.y - RUNWAY.y;
      }
    },
    update(physics, dt) {
      if (!scenarioRuntime.xcActive) return;
      scenarioRuntime.t += dt;
      updateCrossCountry(physics, dt);
    },
  },

  tow: {
    id: 'tow',
    name: 'Tow launch',
    blurb:
      'Standing start behind the tug. Stay in low-tow after lift-off. Off-station rope yanks the nose and can abort the tow. R releases.',
    gear: 1,
    terrain: 'airfield',
    spawn() {
      // Standing start on runway behind the tug
      const z0 = RUNWAY.z + RUNWAY.halfLength - 40;
      return makeSpawn(0, RUNWAY.y + 1.05, z0, 0, 0, 0, 0.01, 0);
    },
    onStart(physics) {
      scenarioRuntime.phase = 'tow';
      scenarioRuntime.released = false;
      scenarioRuntime.t = 0;
      scenarioRuntime.ropeRest = TOW_REST;
      scenarioRuntime.ropeTension = 0;
      scenarioRuntime.ropeSlack = true;
      scenarioRuntime.station = 'ok';
      scenarioRuntime.releaseReady = false;
      scenarioRuntime.weakLinkWarn = false;
      scenarioRuntime.tugStress = 0;
      scenarioRuntime.ropePitch = 0;
      scenarioRuntime.ropeYaw = 0;
      scenarioRuntime.ropeOsc = 0;
      scenarioRuntime.towAbort = null;
      scenarioRuntime._towAir = false;
      scenarioRuntime._towAirT = 0;
      scenarioRuntime._towWeakT = 0;
      _towStretch = 0;
      _towStretchV = 0;
      _towOscPhase = 0;
      _towPrevTen = 0;
      _towSmoothTen = 0;
      updateTugState(0, 1 / 60);
      if (physics) {
        physics.suppressGround = true;
        physics.velocity.set(0, 0, 0);
        if (physics.omega) physics.omega.set(0, 0, 0);
      }
    },
    /**
     * Aerotow from standing start: ground roll with tug → climb formation.
     * Rope snatch / nose pull / tug abort when off-station.
     * @param {import('./physics.js').GliderPhysics} physics
     */
    update(physics, dt) {
      if (scenarioRuntime.phase !== 'tow' || scenarioRuntime.released) return;
      scenarioRuntime.t += dt;
      const t = scenarioRuntime.t;
      const agl = physics.position.y - RUNWAY.y;
      const gndSpd = Math.hypot(physics.velocity.x, physics.velocity.z);

      scenarioRuntime.releaseReady = agl > 280 || t > 28;
      if (t > 45 || agl > 480) {
        scenarioRuntime.towAbort = 'pilot';
        releaseLaunch(physics);
        return;
      }

      // Tug first (uses current stress / station from last frame)
      updateTugState(t, dt);

      // Rotate / unstick with the tug (don't stay pinned when rope goes skyward)
      if (
        !scenarioRuntime._towAir &&
        (gndSpd > 17 || t >= TUG_TAKEOFF_T - 0.8 || agl > 2.5)
      ) {
        scenarioRuntime._towAir = true;
        scenarioRuntime._towAirT = t;
        // Rotate into the climb with the tug
        physics.velocity.y = Math.max(physics.velocity.y, 4);
        physics.position.y = Math.max(physics.position.y, RUNWAY.y + 2.2);
      }
      const onGround = !scenarioRuntime._towAir;
      const airAge = onGround ? 0 : t - (scenarioRuntime._towAirT || t);
      physics.suppressGround = true;
      physics.rolling = false;
      physics.grounded = false;

      if (onGround) {
        // Pin glider to deck; accelerate only via rope
        physics.position.y = RUNWAY.y + 1.05;
        physics.velocity.y = 0;
        physics.velocity.x *= Math.exp(-2.5 * dt);
        const e = new THREE.Euler().setFromQuaternion(physics.quaternion, 'YXZ');
        e.x = THREE.MathUtils.lerp(
          e.x,
          gndSpd > 12 ? 0.1 : 0.02,
          1 - Math.exp(-2 * dt)
        );
        e.z = THREE.MathUtils.lerp(e.z, 0, 1 - Math.exp(-2.5 * dt));
        e.y = THREE.MathUtils.lerp(e.y, 0, 1 - Math.exp(-2 * dt));
        physics.quaternion.setFromEuler(e);
      } else if (airAge < 4) {
        // Early climb: gentle match so rope doesn't snatch (no hard snaps)
        const e = new THREE.Euler().setFromQuaternion(physics.quaternion, 'YXZ');
        e.x = THREE.MathUtils.lerp(e.x, 0.14, 1 - Math.exp(-1.4 * dt));
        e.z = THREE.MathUtils.lerp(e.z, 0, 1 - Math.exp(-1.8 * dt));
        physics.quaternion.setFromEuler(e);
        const a = 1 - Math.exp(-2.2 * dt);
        physics.velocity.y += (scenarioRuntime.tugVel.y - physics.velocity.y) * 0.55 * a;
        physics.velocity.z += (scenarioRuntime.tugVel.z - physics.velocity.z) * 0.4 * a;
      }

      const { glider: hookG, tug: hookT } = towHooks(physics);
      _rope.copy(hookT).sub(hookG);
      const dist = Math.max(0.5, _rope.length());
      scenarioRuntime.ropeDist = dist;
      const ropeDir = _rope.clone().multiplyScalar(1 / dist); // glider → tug

      // —— Station box (ideal low tow) ——
      const ideal = scenarioRuntime.tugPos.clone();
      ideal.y -= TOW_BELOW;
      ideal.z += TOW_BEHIND;
      ideal.x = scenarioRuntime.tugPos.x;
      const vErr = physics.position.y - ideal.y;
      const lErr = physics.position.x - ideal.x;
      // Fore/aft station: + = too far behind
      const longErr =
        (physics.position.z - scenarioRuntime.tugPos.z) - TOW_BEHIND;
      scenarioRuntime.stationVert = vErr;
      scenarioRuntime.stationLat = lErr;

      // Station only enforced once airborne (ground roll is just "stay behind tug")
      let station = 'ok';
      if (!onGround) {
        if (Math.abs(lErr) > 12) station = lErr > 0 ? 'right' : 'left';
        else if (vErr > 8) station = 'high';
        else if (vErr < -11) station = 'low';
      }
      scenarioRuntime.station = station;
      const offStation = station !== 'ok';
      const offAmt = offStation
        ? THREE.MathUtils.clamp(
            Math.max(
              Math.abs(vErr) / 11,
              Math.abs(lErr) / 12,
              Math.abs(longErr) / 15
            ),
            0.35,
            2.8
          )
        : THREE.MathUtils.clamp(
            Math.max(Math.abs(vErr) / 22, Math.abs(lErr) / 24),
            0,
            0.4
          );

      // —— Rope angle in glider body frame (pulls the nose around) ——
      const fwdB = new THREE.Vector3(0, 0, -1).applyQuaternion(physics.quaternion);
      const upB = new THREE.Vector3(0, 1, 0).applyQuaternion(physics.quaternion);
      const rightB = new THREE.Vector3(1, 0, 0).applyQuaternion(physics.quaternion);
      const rF = ropeDir.dot(fwdB);
      const rU = ropeDir.dot(upB);
      const rR = ropeDir.dot(rightB);
      scenarioRuntime.ropePitch = Math.atan2(rU, Math.max(0.05, rF));
      scenarioRuntime.ropeYaw = Math.atan2(rR, Math.max(0.05, rF));

      // —— Spring-damper rope (smooth forces; off-station still swings) ——
      const restLen = scenarioRuntime.ropeRest;
      const stretch = dist - restLen;
      const vSep = scenarioRuntime.tugVel.clone().sub(physics.velocity).dot(ropeDir);
      _towStretch = stretch;
      _towStretchV = vSep;

      const mass = 380;
      const weight = mass * 9.81;
      // Softer spring + more damping → less frame-to-frame snatch
      const k = onGround
        ? 140
        : offStation
          ? 220 + offAmt * 180
          : 170;
      const c = onGround ? 320 : offStation ? 90 + 40 * Math.max(0, 1 - offAmt) : 380;
      let tensionRaw = 0;
      scenarioRuntime.ropeSlack = stretch <= 0.45;

      // Slower whip phase (was ~1–3 Hz → felt like vibration)
      _towOscPhase += dt * (2.2 + offAmt * 3.5 + (offStation ? 1.2 : 0));
      const ph = _towOscPhase;
      const wave =
        Math.sin(ph) * 1.0 +
        Math.sin(ph * 1.7 + 0.4) * 0.45 +
        Math.sin(ph * 2.4 + lErr * 0.08) * 0.2;
      const surge = THREE.MathUtils.clamp(wave / 1.4, -1, 1);

      if (stretch > 0.45) {
        tensionRaw = k * stretch + c * Math.max(0, vSep);

        if (offStation && stretch > 1.2 && vSep > 3) {
          tensionRaw += mass * Math.min(8, vSep) * (0.55 + offAmt * 0.35);
        }

        if (offStation) {
          // Tension still varies with station error, but without hard zero troughs
          const amp = offAmt * weight * (0.45 + 0.35 * Math.min(1, stretch / 6));
          const oscMul = 0.45 + 0.7 * (0.5 + 0.5 * surge); // ~0.45…1.15
          tensionRaw = tensionRaw * oscMul + amp * Math.max(0, 0.15 + 0.55 * surge);
          if (surge < -0.5) {
            tensionRaw *= THREE.MathUtils.clamp(0.35 + (surge + 1) * 0.4, 0.3, 0.75);
          }
          scenarioRuntime.ropeOsc = THREE.MathUtils.clamp(
            offAmt * 0.4 + Math.abs(surge) * 0.35,
            0,
            1
          );
        } else {
          scenarioRuntime.ropeOsc *= Math.exp(-3 * dt);
          _towOscPhase *= 0.995;
        }

        if (station === 'low') tensionRaw *= 1.12 + Math.min(0.4, -vErr / 32);
        if (station === 'left' || station === 'right') {
          tensionRaw *= 1.12 + Math.min(0.35, Math.abs(lErr) / 40);
        }
        if (station === 'high') {
          if (stretch < 2.5) tensionRaw *= 0.35;
          else tensionRaw *= 1.35 + Math.min(0.55, stretch / 14);
        }

        tensionRaw = THREE.MathUtils.clamp(tensionRaw, 0, weight * 2.0);

        if (onGround) {
          tensionRaw = Math.min(tensionRaw, weight * 1.0);
        } else if (airAge < 5) {
          tensionRaw = Math.min(tensionRaw, weight * 1.25);
        } else if (!offStation) {
          tensionRaw = Math.min(tensionRaw, weight * 1.2);
        }

        // Low-pass: apply smoothed tension so velocity/omega don't step
        const tenTau = offStation ? 6 : 10; // 1/s — faster response off-station
        const tenAlpha = 1 - Math.exp(-tenTau * dt);
        _towSmoothTen += (tensionRaw - _towSmoothTen) * tenAlpha;
        const tensionN = _towSmoothTen;

        scenarioRuntime.ropeTension = THREE.MathUtils.clamp(
          tensionN / (weight * WEAK_LINK_G),
          0,
          1.45
        );
        scenarioRuntime.weakLinkWarn = tensionN > weight * WARN_G;

        const overload =
          !onGround &&
          airAge >= 5 &&
          offStation &&
          offAmt > 0.85 &&
          tensionN > weight * WEAK_LINK_G;
        if (overload) {
          scenarioRuntime._towWeakT = (scenarioRuntime._towWeakT || 0) + dt;
        } else {
          scenarioRuntime._towWeakT = Math.max(
            0,
            (scenarioRuntime._towWeakT || 0) - dt * 1.5
          );
        }
        if ((scenarioRuntime._towWeakT || 0) > 1.1) {
          scenarioRuntime.station = 'danger';
          scenarioRuntime.towAbort = 'weaklink';
          releaseLaunch(physics, { weakLink: true });
          return;
        }

        // —— Pull along rope (primary force) ——
        const tenNorm = tensionN / weight;
        const pullGain = offStation ? 1.15 + offAmt * 0.45 : 0.85;
        physics.velocity.addScaledVector(
          ropeDir,
          (tensionN / mass) * pullGain * dt
        );

        // Speed eases with tension off-station — no per-frame hard scale jumps
        if (offStation && !onGround) {
          const tugSpd = Math.max(10, scenarioRuntime.tugVel.length());
          const tenSpd =
            tugSpd *
            (0.55 + 0.45 * Math.min(1.4, tenNorm) + 0.08 * Math.max(0, tenNorm - 1));
          const spdTarget = tenSpd * (0.9 + 0.18 * (0.5 + 0.5 * surge));
          const spdNow = Math.max(1, physics.velocity.length());
          // Gentle chase (~1–2 s time constant)
          const lag = 1 - Math.exp(-(1.2 + offAmt * 0.8) * dt);
          const scale = 1 + ((spdTarget - spdNow) / spdNow) * lag;
          physics.velocity.multiplyScalar(
            THREE.MathUtils.clamp(scale, 0.94, 1.08)
          );
          // Soft caps
          const s2 = physics.velocity.length();
          const spdCapHi = tugSpd * (1.25 + offAmt * 0.12);
          if (s2 > spdCapHi) {
            physics.velocity.multiplyScalar(
              1 - (1 - spdCapHi / s2) * (1 - Math.exp(-3 * dt))
            );
          }
        }

        // Mild snatch response from rising tension (no multi-m/s frame kicks)
        const dTen = (tensionN - _towPrevTen) / Math.max(dt, 1e-3);
        _towPrevTen = tensionN;
        if (offStation && dTen > weight * 2.5) {
          const kick = Math.min(4, (dTen / weight) * 0.35) * (0.5 + offAmt * 0.35);
          physics.velocity.addScaledVector(ropeDir, kick * dt * 8);
          if (physics.omega) {
            physics.omega.z += scenarioRuntime.ropePitch * kick * 0.12 * dt * 10;
            physics.omega.y += -scenarioRuntime.ropeYaw * kick * 0.1 * dt * 10;
          }
        } else if (offStation && dTen < -weight * 3) {
          // Gradual unload bleed
          const drop = Math.min(0.06, (-dTen / weight) * 0.012) * dt * 4;
          physics.velocity.multiplyScalar(1 - drop);
        }

        // —— Moments from smoothed rope force ——
        const rHook = fwdB.clone().multiplyScalar(2.2).addScaledVector(upB, -0.15);
        const F = ropeDir.clone().multiplyScalar(tensionN);
        const torque = new THREE.Vector3().crossVectors(rHook, F);
        const mPitch = torque.dot(rightB) / (mass * 11);
        const mYaw = torque.dot(upB) / (mass * 12);
        const mRoll = torque.dot(fwdB) / (mass * 14);

        const mScale = offStation
          ? (0.55 + offAmt * 0.55) * (0.55 + scenarioRuntime.ropeTension * 0.7)
          : 0.28 * (0.5 + scenarioRuntime.ropeTension);
        const oscKick = offStation
          ? 1 + scenarioRuntime.ropeOsc * Math.sin(_towOscPhase) * 0.45
          : 1;

        if (physics.omega) {
          physics.omega.z += mPitch * mScale * oscKick * 2.4 * dt;
          physics.omega.y += mYaw * mScale * oscKick * 2.1 * dt;
          physics.omega.x += mRoll * mScale * oscKick * 1.5 * dt;
          // Rope angle bias (milder)
          physics.omega.z +=
            scenarioRuntime.ropePitch * (offStation ? 0.9 : 0.22) * Math.min(1.2, offAmt) * dt * 2;
          physics.omega.y +=
            -scenarioRuntime.ropeYaw *
            (offStation ? 1.0 : 0.25) *
            (0.6 + Math.min(1, offAmt)) *
            dt *
            2;
          physics.omega.x +=
            Math.sign(scenarioRuntime.ropeYaw || lErr || 1) *
            Math.min(0.9, Math.abs(scenarioRuntime.ropeYaw) * 1.2 + Math.abs(lErr) * 0.04) *
            (offStation ? 0.7 : 0.2) *
            Math.min(1.2, offAmt) *
            dt *
            1.6;

          if (offStation) {
            const buffet = (0.35 + offAmt * 0.35) * scenarioRuntime.ropeOsc;
            physics.omega.z += Math.sin(ph) * buffet * 1.1 * dt * 3;
            physics.omega.y += Math.sin(ph * 1.3 + 0.5) * buffet * 0.9 * dt * 2.5;
            physics.omega.x += Math.sin(ph * 0.9 + 1.1) * buffet * 0.7 * dt * 2.5;
            physics.omega.y +=
              -Math.sign(lErr) * Math.min(0.8, Math.abs(lErr) / 16) * dt * 2;
            physics.omega.x +=
              Math.sign(lErr) * Math.min(0.65, Math.abs(lErr) / 18) * dt * 1.8;
            physics.omega.z +=
              Math.sign(vErr) * Math.min(0.75, Math.abs(vErr) / 16) * dt * 1.8;
            // Light wash-out only when thrashing hard
            if (offAmt > 1.0) {
              physics.omega.multiplyScalar(1 - Math.min(0.25, (offAmt - 1) * 0.12) * dt * 6);
            }
          }
        }
      } else {
        // Slack: ease tension down, don't zero force in one frame
        const slackAlpha = 1 - Math.exp(-8 * dt);
        _towSmoothTen += (0 - _towSmoothTen) * slackAlpha;
        scenarioRuntime.ropeTension = THREE.MathUtils.clamp(
          _towSmoothTen / (weight * WEAK_LINK_G),
          0,
          1.45
        );
        scenarioRuntime.weakLinkWarn = false;
        scenarioRuntime.ropeOsc = offStation
          ? Math.max(scenarioRuntime.ropeOsc * Math.exp(-1.2 * dt), 0.15)
          : scenarioRuntime.ropeOsc * Math.exp(-1.5 * dt);
        _towPrevTen = _towSmoothTen;
        if (offStation && !onGround) {
          physics.velocity.multiplyScalar(1 - Math.min(0.35, 0.12 + offAmt * 0.08) * dt * 3);
          physics.velocity.y -= 0.9 * dt;
        }
        if (station === 'high') {
          physics.velocity.y -= 1.4 * dt;
          if (physics.omega) {
            physics.omega.z -= 0.25 * dt;
            physics.omega.z += Math.sin(_towOscPhase * 0.5) * offAmt * 0.35 * dt * 2;
          }
        }
      }

      // —— Formation assist when on-station (calm box) ——
      if (station === 'ok') {
        const a = 1 - Math.exp(-2.2 * dt);
        physics.velocity.y +=
          (scenarioRuntime.tugVel.y - physics.velocity.y) * 0.65 * a;
        physics.velocity.z +=
          (scenarioRuntime.tugVel.z - physics.velocity.z) * 0.48 * a;
        physics.velocity.x +=
          (scenarioRuntime.tugVel.x - physics.velocity.x) * 0.42 * a;
      } else if (scenarioRuntime.ropeTension < 0.12 && station !== 'high') {
        physics.velocity.y -= 0.6 * dt;
      }

      // —— Tug distress → abort (needs sustained bad flying) ——
      const sideLoad = Math.abs(lErr) / 22 + Math.abs(scenarioRuntime.ropeYaw) * 1.1;
      const vertLoad =
        Math.max(0, -vErr - 4) / 14 +
        Math.max(0, vErr - 10) / 20 +
        Math.max(0, scenarioRuntime.ropePitch - 0.35) * 1.0;
      const tenLoad = Math.max(0, scenarioRuntime.ropeTension - 0.35);
      const distress =
        (sideLoad * 0.5 + vertLoad * 0.45 + tenLoad * 0.7) *
        (offStation ? 1.45 : 0.08);
      // Only accumulate serious stress when clearly off-station
      if (offStation && offAmt > 0.55 && distress > 0.45) {
        scenarioRuntime.tugStress = Math.min(
          1.15,
          scenarioRuntime.tugStress + distress * 0.22 * dt
        );
      } else {
        scenarioRuntime.tugStress = Math.max(
          0,
          scenarioRuntime.tugStress - 0.35 * dt
        );
      }

      if (scenarioRuntime.tugStress >= TUG_ABORT_STRESS) {
        scenarioRuntime.station = 'danger';
        scenarioRuntime.towAbort = 'tug_abort';
        scenarioRuntime.weakLinkWarn = true;
        // Tug releases the glider (not necessarily weak-link snap)
        releaseLaunch(physics, { tugAbort: true });
        return;
      }

      if (scenarioRuntime.weakLinkWarn) scenarioRuntime.station = 'danger';
      else if (scenarioRuntime.tugStress > 0.55) scenarioRuntime.station = 'upset';
    },
  },

  ridge: {
    id: 'ridge',
    name: 'Ridge soaring',
    blurb: 'Coastal ridge — follow the vapour streams up the face. Fly into the mist for strong lift.',
    gear: 0,
    terrain: 'coastal',
    spawn() {
      // Parallel to ridge along +X, seaward of mid-face with room to soar.
      // Low AGL + fixed z used to dig into crest meander / rising face on start.
      const x0 = -160;
      const info = ridgeFaceInfo(x0);
      // Well seaward of the steep band so crest wander has clearance
      const z0 = info.crestZ + Math.max(info.run * 0.85, 55);
      const ground = terrainHeight(x0, z0);
      // High enough to clear rising terrain for a few hundred meters along-chain
      const y0 = Math.max(ground + 75, info.crestH + 40);
      // yaw = -π/2: nose along +X; slight seaward (+Z) keeps clear of face
      return makeSpawn(x0, y0, z0, 28, 0.5, 2.5, -0.015, -Math.PI / 2);
    },
    onStart() {
      scenarioRuntime.phase = 'flight';
      scenarioRuntime.released = true;
      scenarioRuntime.t = 0;
    },
    // Orographic lift is applied via sampleRidgeLift in the physics thermal sample
  },
};

export const SCENARIO_LIST = [
  SCENARIOS.cable,
  SCENARIOS.tow,
  SCENARIOS.ridge,
  SCENARIOS.landing,
  SCENARIOS.crosscountry,
];

export let activeScenario = SCENARIOS.ridge;

export function setActiveScenario(id) {
  activeScenario = SCENARIOS[id] || SCENARIOS.ridge;
  scenarioRuntime.id = activeScenario.id;
  // Clear session flags when switching scenarios in the menu
  if (activeScenario.id !== 'landing') {
    scenarioRuntime.landingActive = false;
    scenarioRuntime.landScore = null;
    scenarioRuntime.landScored = false;
  }
  if (activeScenario.id !== 'crosscountry') {
    scenarioRuntime.xcActive = false;
    scenarioRuntime.xcScore = null;
    scenarioRuntime.xcScored = false;
    scenarioRuntime.xcDone = false;
  }
  return activeScenario;
}

export function getActiveScenario() {
  return activeScenario;
}

/** True while winch or aerotow rope is still attached. */
export function isLaunchAttached() {
  return (
    !scenarioRuntime.released &&
    (scenarioRuntime.phase === 'winch' || scenarioRuntime.phase === 'tow')
  );
}

/**
 * Manual / auto release of winch cable or tow rope.
 * @param {import('./physics.js').GliderPhysics} [physics]
 * @returns {boolean} true if a launch was released
 */
export function releaseLaunch(physics, opts = {}) {
  if (!isLaunchAttached()) return false;
  const wasPhase = scenarioRuntime.phase;
  scenarioRuntime.released = true;
  scenarioRuntime.phase = 'flight';
  if (opts.tugAbort) scenarioRuntime.towAbort = scenarioRuntime.towAbort || 'tug_abort';
  if (opts.weakLink) scenarioRuntime.towAbort = 'weaklink';
  if (physics) {
    physics.suppressGround = false;
    // Mild slack on release so you don't keep the full pull vector
    if (physics.velocity.y > 12) {
      physics.velocity.y *= 0.85;
    }
    // Snatch release: leftover rope whip on the nose
    if (wasPhase === 'tow' && physics.omega && (opts.weakLink || opts.tugAbort)) {
      physics.omega.z += (Math.random() - 0.3) * 0.8;
      physics.omega.y += (Math.random() - 0.5) * 0.6;
      physics.velocity.y += (Math.random() - 0.2) * 2;
    }
  }
  // Cable / tow release snap (or weak-link pop)
  if (opts.weakLink) flightAudio.playWeakLink();
  else if (opts.tugAbort) flightAudio.playWeakLink(); // sharp cutaway
  else if (wasPhase === 'winch' || wasPhase === 'tow') flightAudio.playCableRelease();
  return true;
}
