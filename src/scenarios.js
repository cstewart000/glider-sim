/**
 * Opening-menu flight scenarios — spawn + optional active forces (winch/tow).
 */

import * as THREE from 'three';
import { RUNWAY } from './runway.js';
import { terrainHeight } from './terrain.js';

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
 */
export const scenarioRuntime = {
  id: 'ridge',
  t: 0,
  phase: 'flight', // 'winch' | 'tow' | 'flight'
  released: false,
};

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
        releaseLaunch(physics);
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
    blurb: 'Aerotow from a level field strip. Climb with the tug — press R to release the rope.',
    gear: 1,
    terrain: 'airfield',
    spawn() {
      // Airborne already, climbing gently on tow
      const z0 = RUNWAY.z + 20;
      return makeSpawn(0, RUNWAY.y + 45, z0, 0, 2.5, -28, 0.08, 0);
    },
    onStart(physics) {
      scenarioRuntime.phase = 'tow';
      scenarioRuntime.released = false;
      scenarioRuntime.t = 0;
      if (physics) physics.suppressGround = true;
    },
    update(physics, dt) {
      if (scenarioRuntime.phase !== 'tow' || scenarioRuntime.released) return;
      scenarioRuntime.t += dt;
      const agl = physics.position.y - RUNWAY.y;
      if (scenarioRuntime.t > 32 || agl > 420) {
        releaseLaunch(physics);
        return;
      }
      physics.suppressGround = true;

      // Tug flies a smooth climb-out
      const tugPos = new THREE.Vector3(
        0,
        RUNWAY.y + 45 + scenarioRuntime.t * 11,
        RUNWAY.z + 20 - scenarioRuntime.t * 32
      );
      _fwd.copy(tugPos).sub(physics.position);
      const dist = Math.max(1, _fwd.length());
      _fwd.multiplyScalar(1 / dist);

      // Rope spring-damper tension (only when taut)
      const restLen = 52;
      const stretch = dist - restLen;
      const mass = 380;
      if (stretch > 0) {
        const vClose = -physics.velocity.dot(_fwd); // + if approaching tug along rope
        const k = 420; // N/m
        const c = 180;
        let tension = k * stretch + c * Math.max(0, -vClose);
        tension = THREE.MathUtils.clamp(tension, 0, mass * 9.81 * 1.6);
        // Weak link
        if (tension > mass * 9.81 * 1.55) {
          releaseLaunch(physics);
          return;
        }
        physics.velocity.addScaledVector(_fwd, (tension / mass) * dt);
      }
      // Slack rope: no force
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
export function releaseLaunch(physics) {
  if (!isLaunchAttached()) return false;
  scenarioRuntime.released = true;
  scenarioRuntime.phase = 'flight';
  if (physics) {
    physics.suppressGround = false;
    // Mild slack on release so you don't keep the full pull vector
    if (physics.velocity.y > 12) {
      physics.velocity.y *= 0.85;
    }
  }
  return true;
}
