/**
 * Opening-menu flight scenarios — spawn + optional active forces (winch/tow).
 */

import * as THREE from 'three';
import { RUNWAY } from './runway.js';
import { terrainHeight } from './terrain.js';
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
};

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
    blurb: 'Final to a runway in open fields — distant hills on the horizon. Gear down, manage energy, roll out.',
    gear: 1,
    terrain: 'airfield',
    spawn() {
      // High final, aligned with runway, gentle descent toward −Z
      const z0 = RUNWAY.z + RUNWAY.halfLength + 380;
      const y0 = RUNWAY.y + 95;
      return makeSpawn(0, y0, z0, 0, -2.8, -26, -0.06, 0);
    },
    onStart() {
      scenarioRuntime.phase = 'flight';
      scenarioRuntime.released = true;
      scenarioRuntime.t = 0;
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
      // Parallel to ridge along +X, mid windward face
      const x0 = -220;
      const z0 = 75;
      const ground = terrainHeight(x0, z0);
      const y0 = ground + 28;
      // yaw = -π/2: nose along +X (along the chain)
      return makeSpawn(x0, y0, z0, 26, 0.25, 0, -0.02, -Math.PI / 2);
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
];

export let activeScenario = SCENARIOS.ridge;

export function setActiveScenario(id) {
  activeScenario = SCENARIOS[id] || SCENARIOS.ridge;
  scenarioRuntime.id = activeScenario.id;
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
