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
  const tz = scenarioRuntime.landTouchZ || physics.position.z;
  const tx = scenarioRuntime.landTouchX || physics.position.x;
  const sink = scenarioRuntime.landTouchSink || 0;
  const bank = Math.abs(physics.rollAngle?.() || 0);
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
  if (!scenarioRuntime.landGearOk) {
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
const TOW_REST = 48;
const WEAK_LINK_G = 1.55; // × weight
const WARN_G = 1.25;

/**
 * Advance tug along climb-out; slight weave so it feels alive.
 * Writes scenarioRuntime.tugPos / tugVel / tugQuat.
 */
function updateTugState(t, dt) {
  // Nominal path: climb and run down-strip (−Z)
  const baseY = RUNWAY.y + 45 + t * 11;
  const baseZ = RUNWAY.z + 20 - t * 32;
  // Gentle lateral weave + pitch bob
  const weave = Math.sin(t * 0.55) * 6;
  const bob = Math.sin(t * 0.9) * 1.2;

  const prev = scenarioRuntime.tugPos.clone();
  scenarioRuntime.tugPos.set(weave, baseY + bob, baseZ);
  if (dt > 1e-6) {
    scenarioRuntime.tugVel
      .copy(scenarioRuntime.tugPos)
      .sub(prev)
      .multiplyScalar(1 / dt);
  } else {
    scenarioRuntime.tugVel.set(0, 11, -32);
  }

  // Face velocity (climb attitude)
  _tugFwd.copy(scenarioRuntime.tugVel);
  if (_tugFwd.lengthSq() < 1e-4) _tugFwd.set(0, 0.3, -1);
  _tugFwd.normalize();
  _tugUp.set(0, 1, 0);
  _tugRight.crossVectors(_tugUp, _tugFwd).normalize();
  _tugUp.crossVectors(_tugFwd, _tugRight).normalize();
  // Bank slightly into weave
  const bank = -Math.sin(t * 0.55) * 0.12;
  _tugUp.applyAxisAngle(_tugFwd, bank);
  _tugRight.crossVectors(_tugUp, _tugFwd).normalize();
  // Matrix from axes: +X right, +Y up, −Z forward → columns
  const m = new THREE.Matrix4().makeBasis(_tugRight, _tugUp, _tugFwd.clone().negate());
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
    blurb: 'Winch launch — hard acceleration and climb from the start. Press R to release the cable.',
    gear: 1,
    terrain: 'airfield',
    spawn() {
      // On runway, facing down-strip (−Z), rolling start
      const z0 = RUNWAY.z + RUNWAY.halfLength - 40;
      return makeSpawn(0, RUNWAY.y + 1.15, z0, 0, 0, -6, 0.1, 0);
    },
    /** @param {import('./physics.js').GliderPhysics} physics */
    onStart(physics) {
      scenarioRuntime.phase = 'winch';
      scenarioRuntime.released = false;
      scenarioRuntime.t = 0;
      physics.suppressGround = true;
      physics.rolling = false;
      physics.grounded = false;
    },
    /**
     * Winch as cable tension along hook→drum (not free velocity hacks).
     * @param {import('./physics.js').GliderPhysics} physics
     */
    update(physics, dt) {
      if (scenarioRuntime.phase !== 'winch' || scenarioRuntime.released) return;
      scenarioRuntime.t += dt;
      const t = scenarioRuntime.t;
      const agl = physics.position.y - RUNWAY.y;

      if (t > 18 || agl > 380 || physics.airspeed > 55) {
        releaseLaunch(physics);
        return;
      }

      physics.suppressGround = true;
      if (physics.rolling) {
        physics.rolling = false;
        physics.grounded = false;
      }

      // Drum / cable point down-field, rises as launch progresses
      const winchPt = new THREE.Vector3(
        0,
        RUNWAY.y + 6 + Math.min(40, t * 4),
        RUNWAY.z - RUNWAY.halfLength - 90
      );
      _fwd.copy(winchPt).sub(physics.position);
      const dist = Math.max(2, _fwd.length());
      _fwd.multiplyScalar(1 / dist);

      // Winch reels in: tension scales with power setting and cable stretch feel
      const power = t < 2 ? 0.55 + t * 0.22 : t < 11 ? 1.0 : Math.max(0.3, 1.0 - (t - 11) / 8);
      // Peak tension ~1.4–1.8× weight early (real winches can be aggressive)
      const mass = 380;
      const Tmax = mass * 9.81 * (1.55 * power);
      // Closing rate along cable
      const vAlong = physics.velocity.dot(_fwd);
      // Pay-out target: want cable shortening ~12–22 m/s early
      const reel = 14 + power * 12;
      const err = reel + vAlong; // positive if not approaching fast enough
      let tension = THREE.MathUtils.clamp(Tmax * 0.35 + err * mass * 1.8, 0, Tmax);
      // Slack if flying past / diving into cable
      if (vAlong > 2) tension *= 0.25;

      // Weak-link style: excess load auto-releases
      if (tension > mass * 9.81 * 2.05) {
        releaseLaunch(physics, { weakLink: true });
        return;
      }

      physics.velocity.addScaledVector(_fwd, (tension / mass) * dt);

      // Mild pitch cue only (pilot still flies) — not hard lock
      if (t < 10 && agl < 200) {
        const e = new THREE.Euler().setFromQuaternion(physics.quaternion, 'YXZ');
        const targetPitch = THREE.MathUtils.clamp(0.12 + agl * 0.0004, 0.1, 0.32);
        e.x = THREE.MathUtils.lerp(e.x, targetPitch, 1 - Math.exp(-1.2 * dt));
        physics.quaternion.setFromEuler(e);
      }

      physics.airspeed = physics.velocity.length();
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
      'Stay slightly below the tug, wings level. High tow slacks the rope; low/side loads the weak link. R releases.',
    gear: 1,
    terrain: 'airfield',
    spawn() {
      // Ideal low-tow station behind / below tug at t=0
      const tugY = RUNWAY.y + 45;
      const tugZ = RUNWAY.z + 20;
      return makeSpawn(
        0,
        tugY - TOW_BELOW,
        tugZ + TOW_BEHIND,
        0,
        2.2,
        -28,
        0.06,
        0
      );
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
      updateTugState(0, 1 / 60);
      if (physics) {
        physics.suppressGround = true;
        // Match tug climb speed roughly
        physics.velocity.set(0, 2.2, -28);
      }
    },
    /**
     * Shared tug state + station-keeping rope forces.
     * @param {import('./physics.js').GliderPhysics} physics
     */
    update(physics, dt) {
      if (scenarioRuntime.phase !== 'tow' || scenarioRuntime.released) return;
      scenarioRuntime.t += dt;
      const t = scenarioRuntime.t;
      const agl = physics.position.y - RUNWAY.y;

      // Soft auto-release when high enough (manual R always works)
      scenarioRuntime.releaseReady = agl > 280 || t > 24;
      if (t > 36 || agl > 450) {
        releaseLaunch(physics);
        return;
      }

      physics.suppressGround = true;
      updateTugState(t, dt);

      const { glider: hookG, tug: hookT } = towHooks(physics);
      _rope.copy(hookT).sub(hookG);
      const dist = Math.max(0.5, _rope.length());
      scenarioRuntime.ropeDist = dist;
      _rope.multiplyScalar(1 / dist); // glider → tug

      // Station errors relative to ideal low-tow box behind tug
      const ideal = scenarioRuntime.tugPos.clone();
      ideal.y -= TOW_BELOW;
      ideal.z += TOW_BEHIND; // behind along +Z while tug flies −Z
      // Account for weave: ideal lateral tracks tug X
      ideal.x = scenarioRuntime.tugPos.x;
      scenarioRuntime.stationVert = physics.position.y - ideal.y;
      scenarioRuntime.stationLat = physics.position.x - ideal.x;

      // Station label
      const vErr = scenarioRuntime.stationVert;
      const lErr = scenarioRuntime.stationLat;
      let station = 'ok';
      if (Math.abs(lErr) > 16) station = lErr > 0 ? 'right' : 'left';
      else if (vErr > 11) station = 'high';
      else if (vErr < -14) station = 'low';
      scenarioRuntime.station = station;

      // Rope: spring-damper only when taut; high station can go slack then snatch
      const restLen = scenarioRuntime.ropeRest;
      const stretch = dist - restLen;
      const mass = 380;
      const weight = mass * 9.81;
      let tensionN = 0;
      scenarioRuntime.ropeSlack = stretch <= 0.35;

      if (stretch > 0.35) {
        const vClose = physics.velocity.dot(_rope); // + if flying toward tug
        const k = 520;
        const c = 200;
        tensionN = k * stretch + c * Math.max(0, -vClose);

        // Station load factors: snatch after high slack; low/side continuous load
        if (station === 'low') tensionN *= 1.15;
        if (station === 'left' || station === 'right') tensionN *= 1.18;
        if (station === 'high' && stretch > 5) tensionN *= 1.4;

        tensionN = THREE.MathUtils.clamp(tensionN, 0, weight * 1.7);
        scenarioRuntime.ropeTension = THREE.MathUtils.clamp(
          tensionN / (weight * WEAK_LINK_G),
          0,
          1.2
        );
        scenarioRuntime.weakLinkWarn = tensionN > weight * WARN_G;

        if (tensionN > weight * WEAK_LINK_G) {
          scenarioRuntime.station = 'danger';
          releaseLaunch(physics, { weakLink: true });
          return;
        }

        // Force along rope toward tug + pitch/roll couples from bad station
        physics.velocity.addScaledVector(_rope, (tensionN / mass) * dt);
        if (physics.omega) {
          if (vErr > 8) physics.omega.z -= 0.5 * dt * Math.min(1, vErr / 16);
          if (vErr < -10) physics.omega.z += 0.35 * dt * Math.min(1, -vErr / 16);
          if (Math.abs(lErr) > 10) {
            physics.omega.x += Math.sign(lErr) * 0.3 * dt;
          }
        }
      } else {
        scenarioRuntime.ropeTension = 0;
        scenarioRuntime.weakLinkWarn = false;
        // High tow with slack: gentle sink cue
        if (station === 'high') {
          physics.velocity.y -= 1.4 * dt;
        }
      }

      // Mild formation assist when roughly on station (still punish extremes)
      if (station === 'ok' || (station === 'low' && vErr > -18)) {
        const a = 1 - Math.exp(-2.2 * dt);
        physics.velocity.y += (scenarioRuntime.tugVel.y - physics.velocity.y) * 0.55 * a;
        physics.velocity.z += (scenarioRuntime.tugVel.z - physics.velocity.z) * 0.4 * a;
        physics.velocity.x += (scenarioRuntime.tugVel.x - physics.velocity.x) * 0.35 * a;
      }

      // Danger band near weak link even if not broken
      if (scenarioRuntime.weakLinkWarn) scenarioRuntime.station = 'danger';
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
  if (physics) {
    physics.suppressGround = false;
    // Mild slack on release so you don't keep the full pull vector
    if (physics.velocity.y > 12) {
      physics.velocity.y *= 0.85;
    }
  }
  // Cable / tow release snap (or weak-link pop)
  if (opts.weakLink) flightAudio.playWeakLink();
  else if (wasPhase === 'winch' || wasPhase === 'tow') flightAudio.playCableRelease();
  return true;
}
