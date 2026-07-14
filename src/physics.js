/**
 * Realistic-leaning sailplane model (Condor-light):
 * - 3D wind air-mass, density altitude
 * - AoA polar (calibrated L/D / min-sink region)
 * - Moment-based pitch/roll/yaw + adverse yaw
 * - Ground effect, gear bounce, wing-strike impulse
 */

import * as THREE from 'three';
import { isOnRunway } from './runway.js';
import { airDensity, RHO0 } from './atmosphere.js';

const G = 9.81;

// —— Mass / geometry (typical single-seat club ship) ——
const MASS = 380; // kg empty-ish + pilot
const WING_AREA = 15.5; // m²
const SPAN = 18.0; // m (full)
const AR = (SPAN * SPAN) / WING_AREA;
const OSWALD = 0.82;
const K_IND = 1 / (Math.PI * AR * OSWALD);
const HALF_SPAN = SPAN * 0.5;
const CHORD = WING_AREA / SPAN;

// Inertia (kg·m²) — rough estimates
const Ixx = 2200;
const Iyy = 3200;
const Izz = 4800;

// —— Polar (Discus-ish heuristic) ——
// Best L/D ~40 at ~28 m/s IAS SL; min sink ~0.6 m/s near 22 m/s
const WING_INCIDENCE = 0.035;
const CL_ALPHA = 5.2; // /rad
const CL0 = 0.12;
const CL_MAX = 1.35;
const CD0 = 0.010; // clean
const STALL_AOA = 0.26; // ~15°
const MAX_AOA = 0.55;
const TRIM_AOA = 0.07;

// Lateral/directional (sign conventions match body axes below):
//   omega.x > 0 → roll right wing down; ctrl.roll > 0 → bank right
//   omega.y < 0 → yaw nose right;      ctrl.yaw  > 0 → yaw right
//   β = atan2(vRight, vFwd); after right rudder β tends < 0 until path catches up
const CY_BETA = -1.35; // side force — builds track offset in a slip
const CY_DR = 0.2; // rudder side force
// Dihedral / roll–yaw coupling (outer wing rises with yaw)
// Strong enough to feel; aileron still holds a deliberate cross-control slip
const CL_BETA = 0.95; // β → roll (dihedral); −CL_BETA·β with β<0 → +p
const CL_R = 0.38; // yaw-rate → roll (Cl_r): yaw right (ωy<0) → +p
const CL_DR = 0.28; // direct rudder → roll (proverse)
const CN_BETA = 0.38; // weathercock — limits extreme β while still allowing slips
const CN_R_DAMP = 0.55; // yaw rate damping factor
const CN_DA = 0.48; // adverse yaw from aileron
const CN_P = 0.14; // roll-rate → yaw (adverse from p)

// Control surface max deflection (rad)
const DE_MAX = 0.35;
const DA_MAX = 0.3;
const DR_MAX = 0.35;

const VNE = 72; // m/s TAS soft limit

// Contact
const NOSE_LEN = 2.6;
const WING_Y = -0.15;
const NOSE_Y = -0.25;
const GEAR_Y = -0.95; // main wheel below CG

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _airVel = new THREE.Vector3();
const _liftDir = new THREE.Vector3();
const _force = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _omega = new THREE.Vector3();
const _moment = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _tip = new THREE.Vector3();
const _nose = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

export class GliderPhysics {
  constructor() {
    this.position = new THREE.Vector3(0, 380, 40);
    this.velocity = new THREE.Vector3(0, -0.8, -30);
    this.quaternion = new THREE.Quaternion();
    this.quaternion.setFromEuler(new THREE.Euler(-0.03, 0, 0, 'YXZ'));
    /** Body angular rate (rad/s) about body X=right, Y=up, Z=aft */
    this.omega = new THREE.Vector3();
    this.airspeed = 30; // IAS-ish (EAS)
    this.tas = 30;
    this.aoa = TRIM_AOA;
    this.sideslip = 0;
    this.vario = 0;
    this.thermalLift = 0; // vertical wind (HUD)
    this.wind = new THREE.Vector3();
    this.rho = RHO0;
    this.stalled = false;
    this.grounded = false;
    this.rolling = false;
    this.wingStrike = false;
    this.wingStrikeSide = 0;
    this._strikeT = 0;
    this.suppressGround = false;
    this.alive = true;
    this.flightTime = 0;
    this.maxAlt = 380;
    this.distance = 0;
    this.rollDistance = 0;
    this.landingQuality = 'crash';
    this.onRunway = false;
    /** Specific energy height: h + v²/(2g) */
    this.energyHeight = 380;
    this.ld = 0; // instantaneous L/D estimate
    this._lastPos = this.position.clone();
    this._varioSmooth = 0;
    this._gearCompress = 0; // 0..1 spring
    // Surface positions (lagged)
    this._de = 0;
    this._da = 0;
    this._dr = 0;
    // Filtered turbulence state (Ornstein–Uhlenbeck) — living air, not white noise
    this._turbU = 0; // body-frame gust along right
    this._turbV = 0; // along up
    this._turbW = 0; // along forward (airspeed bump)
    this._turbP = 0; // roll moment noise
    this._turbQ = 0; // pitch
    this._turbR = 0; // yaw
  }

  reset(spawn) {
    this.position.copy(spawn.position);
    this.velocity.copy(spawn.velocity);
    this.quaternion.copy(spawn.quaternion);
    this.omega.set(0, 0, 0);
    this._de = this._da = this._dr = 0;
    this._turbU = this._turbV = this._turbW = 0;
    this._turbP = this._turbQ = this._turbR = 0;
    this.grounded = false;
    this.rolling = false;
    this.wingStrike = false;
    this.wingStrikeSide = 0;
    this._strikeT = 0;
    this.suppressGround = false;
    this.alive = true;
    this.stalled = false;
    this.flightTime = 0;
    this.maxAlt = spawn.position.y;
    this.distance = 0;
    this.rollDistance = 0;
    this._lastPos.copy(spawn.position);
    this._varioSmooth = 0;
    this.thermalLift = 0;
    this.wind.set(0, 0, 0);
    this.landingQuality = 'crash';
    this.onRunway = false;
    this._gearCompress = 0;
    this.energyHeight = spawn.position.y + spawn.velocity.lengthSq() / (2 * G);
  }

  /**
   * @param {number} dt
   * @param {object} ctrl
   * @param {(x:number,z:number)=>number} getTerrainY
   * @param {(x:number,y:number,z:number,out?:THREE.Vector3)=>THREE.Vector3} getWind
   */
  update(dt, ctrl, getTerrainY, getWind) {
    if (!this.alive) return;
    if (dt <= 0 || dt > 0.08) dt = 0.016;

    if (this.wingStrike && !this.suppressGround) {
      this._updateWingStrike(dt, getTerrainY);
      return;
    }
    if (this.rolling && !this.suppressGround) {
      this._updateRolling(dt, ctrl, getTerrainY);
      return;
    }
    if (this.rolling && this.suppressGround) {
      this.rolling = false;
      this.grounded = false;
    }

    // —— Wind + density ——
    getWind(this.position.x, this.position.y, this.position.z, _wind);
    this.rho = airDensity(this.position.y);
    const sigma = this.rho / RHO0;

    _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.quaternion);

    // Turbulence: multi-scale filtered gusts → needs continuous stick work
    const terrainYPre = getTerrainY(this.position.x, this.position.z);
    const aglPre = Math.max(0, this.position.y - terrainYPre);
    this._updateTurbulence(dt, aglPre, this.position);
    // Apply body-frame gusts into world wind so aero (α, β) feels them
    _wind.addScaledVector(_right, this._turbU);
    _wind.addScaledVector(_up, this._turbV);
    _wind.addScaledVector(_fwd, this._turbW);
    this.wind.copy(_wind);
    this.thermalLift = _wind.y;

    _airVel.copy(this.velocity).sub(_wind);
    this.tas = _airVel.length();
    this.airspeed = this.tas * Math.sqrt(Math.max(0.2, sigma)); // EAS approx
    const speed = Math.max(this.tas, 0.8);
    const qDyn = 0.5 * this.rho * speed * speed;

    // Aero angles
    const vFwd = _airVel.dot(_fwd);
    const vUp = _airVel.dot(_up);
    const vRight = _airVel.dot(_right);
    this.aoa = THREE.MathUtils.clamp(
      Math.atan2(-vUp, Math.max(0.5, Math.abs(vFwd)) * Math.sign(vFwd || 1)) + WING_INCIDENCE,
      -MAX_AOA,
      MAX_AOA
    );
    this.sideslip = Math.atan2(vRight, Math.max(2, Math.abs(vFwd)));

    // —— Control surfaces (lagged) ——
    const lag = 1 - Math.exp(-10 * dt);
    // pitch +1 stick = nose up = trailing-edge up elevator = negative de in aircraft convention
    const deCmd = -ctrl.pitch * DE_MAX;
    const daCmd = -ctrl.roll * DA_MAX; // +roll stick right → right aileron up
    const drCmd = -ctrl.yaw * DR_MAX;
    this._de += (deCmd - this._de) * lag;
    this._da += (daCmd - this._da) * lag;
    this._dr += (drCmd - this._dr) * lag;

    // Body rates (ω): x=roll, y=yaw, z=pitch in our: right, up, aft
    // Map: p = roll about +fwd? Body: +X right, +Y up, +Z aft (opposite flight)
    // Angular vel stored as (p_roll about X, r_yaw about Y, q_pitch about Z-wait)
    // Use: omega.x = roll rate about body +X (right wing down positive? RH: +p lowers right wing)
    // omega.y = yaw about +Y (nose left positive)
    // omega.z = pitch about +Z aft — RH nose left... better pitch about -right for nose up
    // Store omega in body axes: x=roll (about fwd via transform later), use euler rates from body:
    // p = omega · forward, q = omega · right, r = omega · up  — classic
    // We'll integrate omega in body frame with axes: x=right, y=up, z=back
    // Then: roll rate p_body about +fwd = -omega · z? Keep simple: omega.x roll about +X(right),
    // omega.y yaw +Y, omega.z pitch about +X-cross... Use aircraft: p,q,r about fwd,right,down
    // Simplified: omega.x = roll, omega.y = yaw, omega.z = pitch (about right for pitch)

    // —— Polar ——
    let cl;
    if (this.aoa < STALL_AOA && this.aoa > -STALL_AOA * 0.75) {
      cl = CL0 + CL_ALPHA * this.aoa;
    } else if (this.aoa >= STALL_AOA) {
      const peak = CL0 + CL_ALPHA * STALL_AOA * 0.92;
      const over = this.aoa - STALL_AOA;
      cl = peak * Math.exp(-over * 5.5) - over * 0.35;
    } else {
      const peak = -(CL0 * 0.3 + CL_ALPHA * STALL_AOA * 0.55);
      cl = peak + (this.aoa + STALL_AOA * 0.75) * 1.4;
    }
    cl = THREE.MathUtils.clamp(cl, -0.95, CL_MAX);

    this.stalled = this.aoa > STALL_AOA * 0.9;
    if (this.stalled) {
      const over = Math.max(0, this.aoa - STALL_AOA);
      cl *= 0.4;
    }

    // Ground effect: reduce induced drag + slight Cl near runway
    const terrainY0 = getTerrainY(this.position.x, this.position.z);
    const agl = this.position.y - terrainY0;
    let kInd = K_IND;
    if (agl > 0 && agl < SPAN * 0.85) {
      const ge = 1 - Math.exp((-2.8 * agl) / SPAN); // 0 near ground → 1 high
      kInd = K_IND * (0.32 + 0.68 * ge);
      cl *= 1 + 0.1 * (1 - ge);
    }

    let cd =
      CD0 +
      kInd * cl * cl +
      0.45 * Math.max(0, Math.abs(this.aoa) - 0.03) ** 2;

    if (this.stalled) {
      const over = Math.max(0, this.aoa - STALL_AOA);
      cd += 0.22 + over * 1.6;
    }

    // Airbrakes: big drag, Cl drop, nose-down moment in Cm
    const brakes = Math.min(1, Math.max(0, ctrl.brakes || 0));
    if (brakes > 0) {
      cd += 0.12 * brakes + 0.08 * brakes * brakes;
      cl *= 1 - 0.18 * brakes;
    }
    if (ctrl.gear > 0.5) cd += 0.016;

    const lift = qDyn * WING_AREA * cl;
    const drag = qDyn * WING_AREA * Math.max(cd, 0.001);
    this.ld = drag > 1e-3 ? Math.abs(lift) / drag : 0;

    // Lift ⟂ air velocity in plane of symmetry-ish
    _liftDir.crossVectors(_airVel, _right);
    if (_liftDir.lengthSq() < 1e-8) _liftDir.copy(_up);
    else _liftDir.normalize();
    if (_liftDir.dot(_up) < 0) _liftDir.negate();

    // Side force from β + rudder (needed for a held slip / track offset)
    const sideForce =
      qDyn * WING_AREA * (CY_BETA * this.sideslip + CY_DR * this._dr);
    // Extra parasitic drag in sideslip (realistic slip energy bleed)
    const betaAbs = Math.abs(this.sideslip);
    const slipDrag = qDyn * WING_AREA * (0.12 * betaAbs + 0.55 * betaAbs * betaAbs);

    _force.set(0, -MASS * G, 0);
    _force.addScaledVector(_liftDir, lift);
    _force.addScaledVector(_airVel, -(drag + slipDrag) / speed);
    _force.addScaledVector(_right, sideForce);

    this.velocity.addScaledVector(_force, dt / MASS);

    // Soft Vne (TAS)
    const spdW = this.velocity.length();
    if (spdW > VNE) this.velocity.multiplyScalar(VNE / spdW);

    // —— Rotational dynamics ——
    // Lateral: rudder yaws, outer wing rises (Cl_r + Cl_dr + dihedral Cl_β).
    // Cross-control slip is intentional — only light auto-coordination.
    const dyn = THREE.MathUtils.clamp(qDyn / 500, 0.25, 2.2);
    const bank = Math.atan2(_right.y, _up.y); // <0 when right wing down
    const beta = this.sideslip;
    const yawIn = ctrl.yaw || 0; // +1 = right rudder
    const rollIn = ctrl.roll || 0; // +1 = bank right
    const pitchIn = ctrl.pitch || 0;

    // —— Roll (p → omega.x): aileron + dihedral + yaw/roll coupling ——
    // Right rudder (yawIn>0) → outer (left) wing up → right wing down → +omega.x
    const pAileron = rollIn * 1.85 * dyn;
    // Dihedral: after right yaw, β<0 → −CL_BETA·β > 0 → +p (right wing down)
    const pDihedral = -CL_BETA * beta * dyn;
    // Yaw-rate coupling: yawing right (ωy<0) raises left wing → +p
    const pYawRate = -CL_R * this.omega.y * dyn;
    // Direct proverse roll from rudder
    const pRudder = CL_DR * yawIn * dyn;
    // Wings-level stability — reduced so bank wanders and needs correction
    const crossCtrl =
      Math.abs(yawIn) > 0.12 &&
      Math.abs(rollIn) > 0.12 &&
      Math.sign(yawIn) !== Math.sign(rollIn);
    const levelGain = crossCtrl ? 0.28 : 1.15; // was ~1.9 — less “on rails”
    // bank<0 (right wing down) → pLevel<0 raises right wing → levels
    const pLevel = bank * levelGain * dyn;

    // —— Yaw (r → omega.y): rudder + weathercock + adverse yaw ——
    // omega.y < 0 yaws nose right; right rudder uses negative ωy
    const rRudder = -yawIn * 1.1 * dyn;
    // Weathercock: β<0 → +ωy (nose back toward path) — slightly softer
    const rWeather = -CN_BETA * 1.85 * beta * dyn;
    // Adverse yaw from aileron + roll rate
    const rAdverse = CN_DA * rollIn * dyn + CN_P * this.omega.x * dyn;
    // Almost no auto-coordination during slip
    const rCoord = crossCtrl ? 0 : bank * 0.08 * dyn;

    // —— Pitch (weaker static stability → mild phugoid / pitch wander) ——
    const qCmd = pitchIn * 1.05 * dyn;
    let qAero = -(this.aoa - TRIM_AOA) * 2.35 * dyn;
    if (this.stalled) qAero -= Math.max(0, this.aoa - STALL_AOA) * 6;
    if (brakes > 0) qAero -= 0.55 * brakes * dyn;

    // Turbulence moments (Dutch-roll / light chop feel)
    const pTarget =
      pAileron + pDihedral + pYawRate + pRudder + pLevel + this._turbP * dyn;
    const rTarget =
      rRudder + rWeather + rAdverse + rCoord + this._turbR * dyn;
    const qTarget = qCmd + qAero + this._turbQ * dyn;

    // First-order track + lighter damping so small errors grow slowly
    const lagP = 1 - Math.exp(-5.4 * dt);
    const lagY = 1 - Math.exp(-5.0 * dt);
    const lagQ = 1 - Math.exp(-4.8 * dt);
    this.omega.x += (pTarget - this.omega.x) * lagP;
    this.omega.y += (rTarget - this.omega.y) * lagY;
    this.omega.z += (qTarget - this.omega.z) * lagQ;
    // Reduced rate damping → needs continuous small inputs
    this.omega.x *= Math.exp(-0.22 * dt);
    this.omega.y *= Math.exp(-(0.2 + CN_R_DAMP * 0.1) * dt);
    this.omega.z *= Math.exp(-0.24 * dt);
    this.omega.x = THREE.MathUtils.clamp(this.omega.x, -1.6, 1.6);
    this.omega.y = THREE.MathUtils.clamp(this.omega.y, -1.35, 1.35);
    this.omega.z = THREE.MathUtils.clamp(this.omega.z, -1.3, 1.3);

    // Apply rates about body axes
    _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.quaternion);
    _dq.setFromAxisAngle(_right, this.omega.z * dt);
    this.quaternion.premultiply(_dq);
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    _dq.setFromAxisAngle(_up, this.omega.y * dt);
    this.quaternion.premultiply(_dq);
    _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    _dq.setFromAxisAngle(_fwd, this.omega.x * dt);
    this.quaternion.premultiply(_dq);
    this.quaternion.normalize();

    // Integrate position
    this.position.addScaledVector(this.velocity, dt);

    // Recompute air data after step
    getWind(this.position.x, this.position.y, this.position.z, _wind);
    this.wind.copy(_wind);
    this.thermalLift = _wind.y;
    _airVel.copy(this.velocity).sub(_wind);
    this.tas = _airVel.length();
    this.rho = airDensity(this.position.y);
    this.airspeed = this.tas * Math.sqrt(Math.max(0.2, this.rho / RHO0));

    this._varioSmooth += (this.velocity.y - this._varioSmooth) * Math.min(1, 6 * dt);
    this.vario = this._varioSmooth;

    this.energyHeight =
      this.position.y + (this.velocity.lengthSq()) / (2 * G);

    this.flightTime += dt;
    this.maxAlt = Math.max(this.maxAlt, this.position.y);
    this.distance += this.position.distanceTo(this._lastPos);
    this._lastPos.copy(this.position);

    if (this.suppressGround) {
      const terrainY = getTerrainY(this.position.x, this.position.z);
      const minY = terrainY + 0.95;
      if (this.position.y < minY) {
        this.position.y = minY;
        if (this.velocity.y < 0) this.velocity.y *= 0.2;
      }
    } else {
      this._resolveGroundContacts(getTerrainY, dt);
    }
  }

  _contactPoints() {
    _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.quaternion);
    const left = this.position.clone().addScaledVector(_right, -HALF_SPAN).addScaledVector(_up, WING_Y);
    const right = this.position.clone().addScaledVector(_right, HALF_SPAN).addScaledVector(_up, WING_Y);
    const nose = this.position.clone().addScaledVector(_fwd, NOSE_LEN).addScaledVector(_up, NOSE_Y);
    return { left, right, nose, fwd: _fwd, up: _up, rightAxis: _right };
  }

  _penetration(point, getTerrainY) {
    return getTerrainY(point.x, point.z) + 0.12 - point.y;
  }

  _startWingStrike(side, getTerrainY) {
    this.wingStrike = true;
    this.wingStrikeSide = side < 0 ? -1 : 1;
    this._strikeT = 0;
    this.rolling = false;
    this.grounded = false;
    this.landingQuality = 'crash';
    // Impulse at tip: kill some linear, add angular tumble
    this.velocity.multiplyScalar(0.65);
    this.velocity.y = Math.min(this.velocity.y, -0.8);
    this.omega.x += -side * 2.5; // roll into dig
    this.omega.z += -1.2; // pitch nose down
    this.omega.y += side * 1.5;
  }

  _crash(getTerrainY) {
    this.wingStrike = false;
    this.rolling = false;
    this.grounded = true;
    this.alive = false;
    this.landingQuality = 'crash';
    this.velocity.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    const ty = getTerrainY(this.position.x, this.position.z);
    this.position.y = Math.max(this.position.y, ty + 0.6);
  }

  _resolveGroundContacts(getTerrainY, dt) {
    const pts = this._contactPoints();
    const leftPen = this._penetration(pts.left, getTerrainY);
    const rightPen = this._penetration(pts.right, getTerrainY);
    const nosePen = this._penetration(pts.nose, getTerrainY);
    const terrainY = getTerrainY(this.position.x, this.position.z);
    const bellyAgl = this.position.y - terrainY;
    const bank = this.rollAngle();
    const absBank = Math.abs(bank);

    if (nosePen > 0.2 && bellyAgl > 0.5) {
      this._crash(getTerrainY);
      return;
    }

    const tipMargin = 0.08;
    if (leftPen > tipMargin || rightPen > tipMargin) {
      const wingFirst =
        absBank > 0.28 ||
        leftPen > bellyAgl + 0.35 ||
        rightPen > bellyAgl + 0.35 ||
        (leftPen > 0.15 && rightPen < 0.05) ||
        (rightPen > 0.15 && leftPen < 0.05);
      if (wingFirst) {
        this._startWingStrike(leftPen >= rightPen ? -1 : 1, getTerrainY);
        return;
      }
    }

    // Gear spring-damper when close
    if (bellyAgl < 2.2) {
      const gearTarget = terrainY + 1.0;
      const compress = gearTarget - this.position.y;
      if (compress > 0) {
        // Spring-damper bounce
        const k = 8500; // N/m effective
        const c = 2400;
        const fy = k * compress - c * this.velocity.y;
        this.velocity.y += (fy / MASS) * dt;
        if (this.position.y < gearTarget) {
          this.position.y += compress * 0.35;
        }
        this._gearCompress = Math.min(1, compress / 0.4);

        // Touchdown decision when settling
        if (this.velocity.y > -1.2 && this.velocity.y < 2 && compress > 0.05 && bellyAgl < 1.35) {
          this._touchdown(terrainY, getTerrainY);
        }
      } else {
        this._gearCompress = 0;
      }
    }

    if (bellyAgl < 0.85 && !this.rolling && !this.wingStrike) {
      this._touchdown(terrainY, getTerrainY);
    }
  }

  _updateWingStrike(dt, getTerrainY) {
    this._strikeT += dt;
    const side = this.wingStrikeSide;

    // Free tumble with aero drag + dig constraint
    this.omega.x += -side * 1.8 * dt;
    this.omega.z += -1.4 * dt;
    this.omega.y += side * 1.1 * dt;
    this.omega.multiplyScalar(Math.exp(-0.4 * dt));

    _dq.setFromEuler(
      new THREE.Euler(this.omega.z * dt, this.omega.y * dt, -this.omega.x * dt, 'YXZ')
    );
    this.quaternion.multiply(_dq);
    this.quaternion.normalize();

    _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.quaternion);

    _tip
      .copy(this.position)
      .addScaledVector(_right, side * HALF_SPAN)
      .addScaledVector(_up, WING_Y);
    const tipGround = getTerrainY(_tip.x, _tip.z) + 0.1;
    this.position.y += tipGround - _tip.y;

    this.velocity.multiplyScalar(Math.exp(-1.4 * dt));
    this.velocity.y = Math.min(this.velocity.y, -0.5);
    this.velocity.y -= G * 0.35 * dt;
    this.position.addScaledVector(this.velocity, dt);

    _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.quaternion);
    _tip
      .copy(this.position)
      .addScaledVector(_right, side * HALF_SPAN)
      .addScaledVector(_up, WING_Y);
    this.position.y += getTerrainY(_tip.x, _tip.z) + 0.1 - _tip.y;

    _nose
      .copy(this.position)
      .addScaledVector(_fwd, NOSE_LEN)
      .addScaledVector(_up, NOSE_Y);
    const nosePen = this._penetration(_nose, getTerrainY);

    this.airspeed = this.velocity.length();
    this.tas = this.airspeed;
    this.vario = this.velocity.y;
    this._varioSmooth = this.vario;
    this.flightTime += dt;
    this.distance += this.position.distanceTo(this._lastPos);
    this._lastPos.copy(this.position);
    this.energyHeight = this.position.y + this.velocity.lengthSq() / (2 * G);

    if (nosePen > 0.28 || this._strikeT > 5.5 || Math.abs(this.rollAngle()) > 2.45) {
      this._crash(getTerrainY);
    }
  }

  _touchdown(terrainY, getTerrainY) {
    const impactSpeed = this.velocity.length();
    const sink = Math.max(0, -this.velocity.y);
    const bank = Math.abs(this.rollAngle());
    const onRw = isOnRunway(this.position.x, this.position.z, 4);
    this.onRunway = onRw;

    if (bank > 0.5) {
      this._startWingStrike(this.rollAngle() >= 0 ? 1 : -1, getTerrainY);
      return;
    }

    const crash = sink > 7.5 || impactSpeed > 44 || (sink > 5.5 && impactSpeed > 34);
    this.position.y = terrainY + 1.0;
    this.velocity.y = 0;
    this.omega.set(0, 0, 0);

    if (!crash) {
      this.rolling = true;
      this.grounded = true;
      const horiz = this.velocity.clone();
      horiz.y = 0;
      if (horiz.length() < 8) {
        _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
        _fwd.y = 0;
        if (_fwd.lengthSq() > 1e-6) {
          _fwd.normalize();
          this.velocity.copy(_fwd.multiplyScalar(Math.max(horiz.length(), 12)));
        }
      }
      if (onRw && sink < 3.5 && bank < 0.4) this.landingQuality = 'runway';
      else if (sink < 3 && bank < 0.45) this.landingQuality = 'good';
      else this.landingQuality = 'rough';
      this.rollDistance = 0;
      const e = new THREE.Euler().setFromQuaternion(this.quaternion, 'YXZ');
      e.z *= 0.25;
      e.x = Math.min(0.04, Math.max(-0.1, e.x));
      this.quaternion.setFromEuler(e);
    } else {
      this._crash(getTerrainY);
    }
  }

  _updateRolling(dt, ctrl, getTerrainY) {
    const terrainY = getTerrainY(this.position.x, this.position.z);
    this.position.y = terrainY + 0.95;
    this.onRunway = isOnRunway(this.position.x, this.position.z, 3);

    _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    else _fwd.normalize();

    const steer = -(ctrl?.yaw || 0) * 0.55;
    const brake = ctrl?.brakes > 0 ? 1 : 0;
    // Rudder authority fades with speed (realistic tailwheel-ish)
    const spd0 = this.velocity.length();
    const rudderAuth = THREE.MathUtils.clamp(spd0 / 18, 0.25, 1);

    const yawRate = steer * 0.85 * rudderAuth;
    _dq.setFromEuler(new THREE.Euler(0, yawRate * dt, 0, 'YXZ'));
    this.quaternion.multiply(_dq);
    this.quaternion.normalize();

    const e = new THREE.Euler().setFromQuaternion(this.quaternion, 'YXZ');
    e.z *= Math.exp(-4 * dt);
    e.x += (-0.02 - e.x) * Math.min(1, 3 * dt);
    this.quaternion.setFromEuler(e);

    _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    _fwd.y = 0;
    _fwd.normalize();

    const velH = this.velocity.clone();
    velH.y = 0;
    let spd = velH.length();
    if (spd > 0.25) {
      const along = _fwd.clone().multiplyScalar(velH.dot(_fwd));
      const side = velH.clone().sub(along);
      velH.copy(along).addScaledVector(side, Math.exp(-4 * dt));
      spd = velH.length();
    }

    const mu = this.onRunway ? 0.22 : 0.55;
    const brakeExtra = brake * 3.8;
    const decel = mu * G * 0.65 + brakeExtra + spd * 0.12 + spd * spd * 0.008;
    spd = Math.max(0, spd - decel * dt);
    this.velocity.set(_fwd.x * spd, 0, _fwd.z * spd);

    const before = this.position.clone();
    this.position.addScaledVector(this.velocity, dt);
    this.position.y = getTerrainY(this.position.x, this.position.z) + 0.95;
    this.rollDistance += this.position.distanceTo(before);

    this.airspeed = spd;
    this.tas = spd;
    this.vario = 0;
    this._varioSmooth = 0;
    this.flightTime += dt;
    this.distance += this.position.distanceTo(this._lastPos);
    this._lastPos.copy(this.position);
    this.energyHeight = this.position.y;

    if (spd < 0.55) {
      this.rolling = false;
      this.alive = false;
      this.grounded = true;
      this.velocity.set(0, 0, 0);
      if (this.onRunway && this.landingQuality !== 'rough') {
        this.landingQuality = 'runway';
      }
    }
  }

  /**
   * Multi-scale atmospheric turbulence (filtered noise).
   * Slow meander + medium bumps + light high-freq chop → constant small corrections.
   * Stronger near ground / ridge band; calmer high and smooth.
   */
  _updateTurbulence(dt, agl, pos) {
    // Intensity: light cruise chop; a bit more near ground (toned down)
    const low = Math.exp(-agl / 110);
    const mid = Math.exp(-((agl - 180) ** 2) / (260 * 260));
    const intensity = 0.22 + 0.38 * low + 0.14 * mid;
    // Spatial “texture” so different air masses feel different
    const spat =
      0.85 +
      0.2 *
        Math.sin(pos.x * 0.011 + pos.z * 0.009) *
        Math.cos(pos.x * 0.004 - pos.z * 0.007);

    const n = () => Math.random() * 2 - 1;
    // Ornstein–Uhlenbeck step: mean-reverting filtered noise
    const ou = (x, tau, sigma) => {
      const a = Math.exp(-dt / Math.max(0.05, tau));
      return x * a + sigma * Math.sqrt(Math.max(0, 1 - a * a)) * n();
    };

    // Translational gusts (m/s) — body frame before mapping to world
    const sLin = intensity * spat;
    this._turbU = ou(this._turbU, 2.2, 0.55 * sLin); // lateral
    this._turbV = ou(this._turbV, 1.6, 0.4 * sLin); // vertical (vario bobble)
    this._turbW = ou(this._turbW, 2.8, 0.28 * sLin); // head/tail
    // Slow large-scale meander (second layer)
    this._turbU = ou(this._turbU, 7.0, 0.22 * sLin);
    this._turbV = ou(this._turbV, 5.5, 0.16 * sLin);

    // Angular “bumps” (rad/s targets) — mild wing rock only
    const sAng = intensity * spat;
    this._turbP = ou(this._turbP, 1.2, 0.22 * sAng);
    this._turbQ = ou(this._turbQ, 1.8, 0.12 * sAng);
    this._turbR = ou(this._turbR, 1.5, 0.16 * sAng);

    // Soft clamps
    this._turbU = THREE.MathUtils.clamp(this._turbU, -2.0, 2.0);
    this._turbV = THREE.MathUtils.clamp(this._turbV, -1.5, 1.5);
    this._turbW = THREE.MathUtils.clamp(this._turbW, -1.2, 1.2);
    this._turbP = THREE.MathUtils.clamp(this._turbP, -0.45, 0.45);
    this._turbQ = THREE.MathUtils.clamp(this._turbQ, -0.3, 0.3);
    this._turbR = THREE.MathUtils.clamp(this._turbR, -0.35, 0.35);
  }

  rollAngle() {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quaternion);
    return Math.atan2(right.y, up.y);
  }

  pitchAngle() {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion);
    return Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));
  }

  heading() {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion);
    let h = Math.atan2(forward.x, -forward.z) * (180 / Math.PI);
    if (h < 0) h += 360;
    return h;
  }
}
