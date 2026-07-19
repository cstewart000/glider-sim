/**
 * Tron mode — neon grid aesthetic, dual winglet light ribbons, theme helpers.
 */

import * as THREE from 'three';

const TRON_CYAN = 0x66f0ff;
const TRON_CYAN_SOFT = 0x99f6ff;
const TRON_CYAN_GLOW = 0xaaeeff;
const TRON_BODY = 0x060a10;
const TRON_SURFACE = 0x55eeff; // neon light-blue control surfaces
const TRON_FOG = 0x02060c;
const TRON_CLEAR = 0x00040a;

const CLASSIC_FOG = 0xe8eef2;
const CLASSIC_CLEAR = 0xeef2f5;

// Half-span / dihedral match glider.js (before root scale 1.05 applied in world via mesh)
const WING_HALF = 9.2;
const WING_DIHEDRAL = (7 * Math.PI) / 180;

/** @type {boolean} */
let tronOn = false;

/**
 * One translucent ribbon trail (triangle strip).
 */
class RibbonTrail {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   */
  constructor(scene, opts = {}) {
    this.maxPoints = opts.maxPoints ?? 140;
    this.minDist = opts.minDist ?? 0.5;
    this.halfWidth = opts.halfWidth ?? 0.12;
    this.scene = scene;
    this.count = 0;
    this.head = 0;
    // Ring buffer of sample points
    this.samples = new Float32Array(this.maxPoints * 3);
    // Ribbon: 2 verts per sample → maxPoints * 2 vertices, (maxPoints-1)*6 indices
    const maxV = this.maxPoints * 2;
    this.positions = new Float32Array(maxV * 3);
    this.colors = new Float32Array(maxV * 4);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    this.geo.setDrawRange(0, 0);

    // Translucent additive “glass neon” — reads as glowing / reflective light
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this._last = new THREE.Vector3(1e9, 1e9, 1e9);
    this._side = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
  }

  setActive(on) {
    this.mesh.visible = !!on;
    if (!on) this.clear();
  }

  clear() {
    this.count = 0;
    this.head = 0;
    this.geo.setDrawRange(0, 0);
    this._last.set(1e9, 1e9, 1e9);
  }

  /**
   * @param {THREE.Vector3} pos
   * @param {THREE.Vector3} sideDir unit vector across ribbon width
   * @param {boolean} active
   * @param {number} speed
   */
  update(pos, sideDir, active, speed = 20) {
    if (!active) {
      this.setActive(false);
      return;
    }
    this.mesh.visible = true;

    const minD = Math.max(0.3, this.minDist * (16 / Math.max(8, speed)));
    if (this._last.distanceToSquared(pos) < minD * minD && this.count > 3) {
      // Still rebuild ribbon orientation as glider banks
      this._rebuild(sideDir);
      return;
    }
    this._last.copy(pos);

    const i = this.head % this.maxPoints;
    this.samples[i * 3] = pos.x;
    this.samples[i * 3 + 1] = pos.y;
    this.samples[i * 3 + 2] = pos.z;
    this.head++;
    this.count = Math.min(this.count + 1, this.maxPoints);
    this._rebuild(sideDir);
  }

  _rebuild(sideDir) {
    if (this.count < 2) {
      this.geo.setDrawRange(0, 0);
      return;
    }
    const n = this.count;
    const start = this.head - n;
    const hw = this.halfWidth;
    const side = this._side.copy(sideDir);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    else side.normalize();

    let vi = 0;
    for (let k = 0; k < n; k++) {
      const src = (start + k + this.maxPoints * 4) % this.maxPoints;
      const x = this.samples[src * 3];
      const y = this.samples[src * 3 + 1];
      const z = this.samples[src * 3 + 2];
      // Fade: newest bright, oldest transparent
      const age = 1 - k / (n - 1);
      const a = Math.pow(age, 1.15) * 0.55; // translucent light blue
      const r = 0.55 + age * 0.35;
      const g = 0.9 + age * 0.08;
      const b = 1.0;

      // Two edges of ribbon
      this.positions[vi * 3] = x + side.x * hw;
      this.positions[vi * 3 + 1] = y + side.y * hw;
      this.positions[vi * 3 + 2] = z + side.z * hw;
      this.colors[vi * 4] = r;
      this.colors[vi * 4 + 1] = g;
      this.colors[vi * 4 + 2] = b;
      this.colors[vi * 4 + 3] = a;
      vi++;
      this.positions[vi * 3] = x - side.x * hw;
      this.positions[vi * 3 + 1] = y - side.y * hw;
      this.positions[vi * 3 + 2] = z - side.z * hw;
      this.colors[vi * 4] = r;
      this.colors[vi * 4 + 1] = g;
      this.colors[vi * 4 + 2] = b;
      this.colors[vi * 4 + 3] = a * 0.85;
      vi++;
    }

    // Indices for triangle strip as triangles
    const idx = [];
    for (let k = 0; k < n - 1; k++) {
      const a = k * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    this.geo.setIndex(idx);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, idx.length);
    this.geo.computeBoundingSphere();
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}

/**
 * Dual winglet light ribbons (left + right).
 */
export class LightTrail {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.left = new RibbonTrail(scene, { halfWidth: 0.14, maxPoints: 160 });
    this.right = new RibbonTrail(scene, { halfWidth: 0.14, maxPoints: 160 });
    // Soft core lines on top of ribbons for “hot” neon edge
    this._leftCore = this._makeCoreLine(scene);
    this._rightCore = this._makeCoreLine(scene);
    this._coreL = new Float32Array(160 * 3);
    this._coreR = new Float32Array(160 * 3);
    this._coreCount = 0;
    this._coreHead = 0;
    this._last = new THREE.Vector3(1e9, 1e9, 1e9);

    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._leftTip = new THREE.Vector3();
    this._rightTip = new THREE.Vector3();
    this._sideL = new THREE.Vector3();
    this._sideR = new THREE.Vector3();
  }

  _makeCoreLine(scene) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(160 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: TRON_CYAN_GLOW,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 9;
    line.visible = false;
    scene.add(line);
    line.userData.buf = pos;
    return line;
  }

  setActive(on) {
    this.left.setActive(on);
    this.right.setActive(on);
    this._leftCore.visible = !!on;
    this._rightCore.visible = !!on;
    if (!on) this.clear();
  }

  clear() {
    this.left.clear();
    this.right.clear();
    this._coreCount = 0;
    this._coreHead = 0;
    this._leftCore.geometry.setDrawRange(0, 0);
    this._rightCore.geometry.setDrawRange(0, 0);
    this._last.set(1e9, 1e9, 1e9);
  }

  /**
   * Sample winglet world positions from glider pose.
   * @param {THREE.Object3D} glider
   * @param {THREE.Vector3} pos render position
   * @param {THREE.Quaternion} quat
   * @param {boolean} active
   * @param {number} speed
   */
  updateFromGlider(glider, pos, quat, active, speed = 20) {
    if (!active) {
      this.setActive(false);
      return;
    }

    const scale = glider?.scale?.x ?? 1.05;
    const half = WING_HALF * scale;
    const d = WING_DIHEDRAL;

    this._right.set(1, 0, 0).applyQuaternion(quat);
    this._up.set(0, 1, 0).applyQuaternion(quat);
    this._fwd.set(0, 0, -1).applyQuaternion(quat);

    // Winglet tip ≈ tip of main wing + slight up (matches buildCurvedWinglet)
    // Local before dihedral: (±half, tipY, tipZ); rotate about Z by ±dihedral
    const tipY = 0.55;
    const tipZ = 0.12; // slightly aft of LE
    for (const sign of [-1, 1]) {
      const x0 = sign * half;
      const y0 = tipY;
      const c = Math.cos(sign * d);
      const s = Math.sin(sign * d);
      const lx = x0 * c - y0 * s;
      const ly = x0 * s + y0 * c;
      const out = sign < 0 ? this._leftTip : this._rightTip;
      out
        .copy(pos)
        .addScaledVector(this._right, lx)
        .addScaledVector(this._up, ly)
        .addScaledVector(this._fwd, -tipZ);
    }

    // Ribbon width across the wing chord-ish (up × along-trail)
    this._sideL.copy(this._up);
    this._sideR.copy(this._up);

    this.left.update(this._leftTip, this._sideL, true, speed);
    this.right.update(this._rightTip, this._sideR, true, speed);

    // Hot neon cores
    this._pushCore(this._leftTip, this._rightTip, speed);
  }

  _pushCore(left, right, speed) {
    const minD = Math.max(0.3, 0.45 * (16 / Math.max(8, speed)));
    const mid = this._last;
    // Use left tip for spacing
    if (mid.distanceToSquared(left) < minD * minD && this._coreCount > 2) {
      return;
    }
    mid.copy(left);

    const i = this._coreHead % 160;
    this._coreL[i * 3] = left.x;
    this._coreL[i * 3 + 1] = left.y;
    this._coreL[i * 3 + 2] = left.z;
    this._coreR[i * 3] = right.x;
    this._coreR[i * 3 + 1] = right.y;
    this._coreR[i * 3 + 2] = right.z;
    this._coreHead++;
    this._coreCount = Math.min(this._coreCount + 1, 160);
    this._flushCore(this._leftCore, this._coreL);
    this._flushCore(this._rightCore, this._coreR);
  }

  _flushCore(line, ring) {
    const n = this._coreCount;
    const ordered = line.userData.buf;
    const start = this._coreHead - n;
    for (let k = 0; k < n; k++) {
      const src = (start + k + 160 * 4) % 160;
      ordered[k * 3] = ring[src * 3];
      ordered[k * 3 + 1] = ring[src * 3 + 1];
      ordered[k * 3 + 2] = ring[src * 3 + 2];
    }
    line.geometry.attributes.position.needsUpdate = true;
    line.geometry.setDrawRange(0, n);
    line.visible = n > 1;
  }

  /** @deprecated use updateFromGlider */
  update(pos, active, speed = 20) {
    if (!active) this.setActive(false);
  }

  dispose() {
    this.left.dispose();
    this.right.dispose();
    this.scene.remove(this._leftCore);
    this.scene.remove(this._rightCore);
    this._leftCore.geometry.dispose();
    this._rightCore.geometry.dispose();
    this._leftCore.material.dispose();
    this._rightCore.material.dispose();
  }
}

/**
 * Snapshot material colors once so we can restore classic look.
 * @param {THREE.Object3D} root
 */
function snapshotMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isLineSegments && !o.isLine && !o.isPoints) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (!m || m.userData._tronSnap) continue;
      m.userData._tronSnap = {
        color: m.color ? m.color.clone() : null,
        opacity: m.opacity,
        transparent: m.transparent,
      };
    }
  });
}

/**
 * Recolor glider for Tron / classic.
 * Control surfaces → neon light blue (translucent).
 * @param {THREE.Object3D} glider
 * @param {boolean} on
 */
export function applyTronGlider(glider, on) {
  if (!glider) return;
  snapshotMaterials(glider);
  glider.traverse((o) => {
    if (!o.isMesh && !o.isLineSegments && !o.isLine) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (!m?.userData?._tronSnap) continue;
      const snap = m.userData._tronSnap;
      if (on) {
        const isLine = o.isLineSegments || o.isLine || m.type === 'LineBasicMaterial';
        const name = (o.name || '').toLowerCase();
        const parentName = (o.parent?.name || '').toLowerCase();
        const isControl =
          name.includes('aileron') ||
          name.includes('elevator') ||
          name.includes('rudder') ||
          name.includes('brake') ||
          parentName.includes('aileron') ||
          parentName.includes('elevator') ||
          parentName.includes('rudder') ||
          parentName.includes('brake') ||
          m.userData?.isAccent ||
          // Translucent red control surfaces from createGlider
          (m.transparent &&
            snap.color &&
            snap.color.r > 0.7 &&
            snap.color.g < 0.75 &&
            snap.color.b < 0.75);
        if (isLine) {
          m.color.setHex(TRON_CYAN);
          m.transparent = true;
          m.opacity = 0.95;
        } else if (isControl) {
          // Neon light-blue translucent surfaces
          m.color.setHex(TRON_SURFACE);
          m.transparent = true;
          m.opacity = 0.72;
          m.depthWrite = false;
        } else if (m.transparent && (snap.opacity ?? 1) < 0.55) {
          m.color.setHex(TRON_CYAN_SOFT);
          m.opacity = 0.3;
        } else {
          m.color.setHex(TRON_BODY);
          m.opacity = 1;
          m.transparent = false;
          m.depthWrite = true;
        }
      } else if (snap.color) {
        m.color.copy(snap.color);
        m.opacity = snap.opacity;
        m.transparent = snap.transparent;
        m.depthWrite = true;
      }
    }
  });
}

/**
 * Scene fog / clear / sky tint for Tron.
 * @param {{ scene: THREE.Scene, renderer: THREE.WebGLRenderer, sunGroup?: THREE.Object3D }} ctx
 * @param {boolean} on
 */
export function applyTronScene(ctx, on) {
  const { scene, renderer, sunGroup } = ctx;
  if (scene.fog) {
    if (on) {
      scene.fog.color.setHex(TRON_FOG);
      scene.fog.near = 80;
      scene.fog.far = 900;
    } else {
      scene.fog.color.setHex(CLASSIC_FOG);
      scene.fog.near = 420;
      scene.fog.far = 1950;
    }
  }
  renderer.setClearColor(on ? TRON_CLEAR : CLASSIC_CLEAR);
  if (sunGroup) sunGroup.visible = !on;

  scene.traverse((o) => {
    if (
      o.isMesh &&
      o.geometry?.type === 'SphereGeometry' &&
      o.material?.side === THREE.BackSide
    ) {
      if (!o.userData._tronSkyMat) {
        o.userData._tronSkyMat = o.material;
      }
      if (on) {
        if (!o.userData._tronSkyDark) {
          o.userData._tronSkyDark = new THREE.MeshBasicMaterial({
            color: 0x020810,
            side: THREE.BackSide,
            fog: false,
            depthWrite: false,
          });
        }
        o.material = o.userData._tronSkyDark;
      } else if (o.userData._tronSkyMat) {
        o.material = o.userData._tronSkyMat;
      }
    }
  });
}

export function isTronMode() {
  return tronOn;
}

/**
 * @param {boolean} on
 * @param {object} ctx
 */
export function setTronMode(on, ctx) {
  tronOn = !!on;
  applyTronGlider(ctx.glider, tronOn);
  applyTronScene(ctx, tronOn);
  if (ctx.trail) ctx.trail.setActive(tronOn);
  if (ctx.audio?.setTronMode) ctx.audio.setTronMode(tronOn);
  document.documentElement.classList.toggle('tron-mode', tronOn);
  return tronOn;
}

export function toggleTronMode(ctx) {
  return setTronMode(!tronOn, ctx);
}

export { TRON_CYAN, TRON_BODY, TRON_SURFACE as TRON_ACCENT, TRON_SURFACE };
