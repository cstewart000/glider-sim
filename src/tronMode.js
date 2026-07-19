/**
 * Tron mode — neon outlines, dual winglet ribbons (top/bottom edge depth).
 */

import * as THREE from 'three';

const TRON_CYAN = 0x66f0ff;
const TRON_CYAN_SOFT = 0x88f4ff;
const TRON_CYAN_GLOW = 0xaaeeff;
const TRON_BODY = 0x060a10;
const TRON_SURFACE_FILL = 0x0a1218; // dark fill under neon outlines
const TRON_FOG = 0x02060c;
const TRON_CLEAR = 0x00040a;

const CLASSIC_FOG = 0xe8eef2;
const CLASSIC_CLEAR = 0xeef2f5;

/** @type {boolean} */
let tronOn = false;

/**
 * Vertical ribbon: top & bottom edges (depth), trails behind sample point.
 * Cross-section is vertical (up-down), not flat on the wing plane.
 */
class RibbonTrail {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   */
  constructor(scene, opts = {}) {
    this.maxPoints = opts.maxPoints ?? 150;
    this.minDist = opts.minDist ?? 0.45;
    /** Half-height of ribbon (top/bottom from center line) */
    this.halfHeight = opts.halfHeight ?? 0.16;
    this.scene = scene;
    this.count = 0;
    this.head = 0;
    this.samples = new Float32Array(this.maxPoints * 3);
    // Also store path tangent approx for stable orientation
    const maxV = this.maxPoints * 2;
    this.positions = new Float32Array(maxV * 3);
    this.colors = new Float32Array(maxV * 4);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    this.geo.setDrawRange(0, 0);

    // Translucent neon blue glass (additive)
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

    // Explicit top + bottom edge lines (reads as ribbon with depth)
    this.edgeGeoTop = new THREE.BufferGeometry();
    this.edgeGeoBot = new THREE.BufferGeometry();
    this.edgePosTop = new Float32Array(this.maxPoints * 3);
    this.edgePosBot = new Float32Array(this.maxPoints * 3);
    this.edgeGeoTop.setAttribute(
      'position',
      new THREE.BufferAttribute(this.edgePosTop, 3)
    );
    this.edgeGeoBot.setAttribute(
      'position',
      new THREE.BufferAttribute(this.edgePosBot, 3)
    );
    this.edgeMat = new THREE.LineBasicMaterial({
      color: TRON_CYAN_GLOW,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.edgeTop = new THREE.Line(this.edgeGeoTop, this.edgeMat);
    this.edgeBot = new THREE.Line(this.edgeGeoBot, this.edgeMat.clone());
    this.edgeBot.material.opacity = 0.65;
    this.edgeTop.frustumCulled = false;
    this.edgeBot.frustumCulled = false;
    this.edgeTop.renderOrder = 9;
    this.edgeBot.renderOrder = 9;
    this.edgeTop.visible = false;
    this.edgeBot.visible = false;
    scene.add(this.edgeTop);
    scene.add(this.edgeBot);

    this._last = new THREE.Vector3(1e9, 1e9, 1e9);
    this._up = new THREE.Vector3(0, 1, 0);
  }

  setActive(on) {
    this.mesh.visible = !!on;
    this.edgeTop.visible = !!on;
    this.edgeBot.visible = !!on;
    if (!on) this.clear();
  }

  clear() {
    this.count = 0;
    this.head = 0;
    this.geo.setDrawRange(0, 0);
    this.edgeGeoTop.setDrawRange(0, 0);
    this.edgeGeoBot.setDrawRange(0, 0);
    this._last.set(1e9, 1e9, 1e9);
  }

  /**
   * @param {THREE.Vector3} pos sample at winglet tip
   * @param {THREE.Vector3} upDir world up for ribbon depth (top/bottom)
   * @param {boolean} active
   * @param {number} speed
   */
  update(pos, upDir, active, speed = 20) {
    if (!active) {
      this.setActive(false);
      return;
    }
    this.mesh.visible = true;
    this.edgeTop.visible = true;
    this.edgeBot.visible = true;

    const minD = Math.max(0.28, this.minDist * (15 / Math.max(8, speed)));
    if (this._last.distanceToSquared(pos) >= minD * minD || this.count < 3) {
      this._last.copy(pos);
      const i = this.head % this.maxPoints;
      this.samples[i * 3] = pos.x;
      this.samples[i * 3 + 1] = pos.y;
      this.samples[i * 3 + 2] = pos.z;
      this.head++;
      this.count = Math.min(this.count + 1, this.maxPoints);
    }
    this._rebuild(upDir);
  }

  _rebuild(upDir) {
    if (this.count < 2) {
      this.geo.setDrawRange(0, 0);
      this.edgeGeoTop.setDrawRange(0, 0);
      this.edgeGeoBot.setDrawRange(0, 0);
      return;
    }
    const n = this.count;
    const start = this.head - n;
    const hh = this.halfHeight;
    const up = this._up.copy(upDir);
    if (up.lengthSq() < 1e-8) up.set(0, 1, 0);
    else up.normalize();

    let vi = 0;
    for (let k = 0; k < n; k++) {
      const src = (start + k + this.maxPoints * 8) % this.maxPoints;
      const x = this.samples[src * 3];
      const y = this.samples[src * 3 + 1];
      const z = this.samples[src * 3 + 2];
      // Newest = brightest; oldest fades out
      const age = k / Math.max(1, n - 1); // 0 old → 1 new
      const a = Math.pow(age, 0.85) * 0.42; // translucent neon blue fill
      const r = 0.4 + age * 0.35;
      const g = 0.85 + age * 0.12;
      const b = 1.0;

      // Top edge
      this.positions[vi * 3] = x + up.x * hh;
      this.positions[vi * 3 + 1] = y + up.y * hh;
      this.positions[vi * 3 + 2] = z + up.z * hh;
      this.colors[vi * 4] = r;
      this.colors[vi * 4 + 1] = g;
      this.colors[vi * 4 + 2] = b;
      this.colors[vi * 4 + 3] = a;
      this.edgePosTop[k * 3] = this.positions[vi * 3];
      this.edgePosTop[k * 3 + 1] = this.positions[vi * 3 + 1];
      this.edgePosTop[k * 3 + 2] = this.positions[vi * 3 + 2];
      vi++;
      // Bottom edge
      this.positions[vi * 3] = x - up.x * hh;
      this.positions[vi * 3 + 1] = y - up.y * hh;
      this.positions[vi * 3 + 2] = z - up.z * hh;
      this.colors[vi * 4] = r * 0.9;
      this.colors[vi * 4 + 1] = g * 0.95;
      this.colors[vi * 4 + 2] = b;
      this.colors[vi * 4 + 3] = a * 0.9;
      this.edgePosBot[k * 3] = this.positions[vi * 3];
      this.edgePosBot[k * 3 + 1] = this.positions[vi * 3 + 1];
      this.edgePosBot[k * 3 + 2] = this.positions[vi * 3 + 2];
      vi++;
    }

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

    this.edgeGeoTop.attributes.position.needsUpdate = true;
    this.edgeGeoBot.attributes.position.needsUpdate = true;
    this.edgeGeoTop.setDrawRange(0, n);
    this.edgeGeoBot.setDrawRange(0, n);
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.scene.remove(this.edgeTop);
    this.scene.remove(this.edgeBot);
    this.geo.dispose();
    this.edgeGeoTop.dispose();
    this.edgeGeoBot.dispose();
    this.mat.dispose();
    this.edgeMat.dispose();
    this.edgeBot.material.dispose();
  }
}

/**
 * Dual winglet trails — samples real trailAnchor nodes on the glider.
 */
export class LightTrail {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.left = new RibbonTrail(scene, { halfHeight: 0.18, maxPoints: 160 });
    this.right = new RibbonTrail(scene, { halfHeight: 0.18, maxPoints: 160 });
    this._up = new THREE.Vector3();
    this._leftTip = new THREE.Vector3();
    this._rightTip = new THREE.Vector3();
    this._anchors = null; // [left, right] Object3D
  }

  setActive(on) {
    this.left.setActive(on);
    this.right.setActive(on);
    if (!on) this.clear();
  }

  clear() {
    this.left.clear();
    this.right.clear();
  }

  /**
   * @param {THREE.Object3D} glider
   * @param {THREE.Vector3} pos unused (anchors are world-space)
   * @param {THREE.Quaternion} quat
   * @param {boolean} active
   * @param {number} speed
   */
  updateFromGlider(glider, pos, quat, active, speed = 20) {
    if (!active || !glider) {
      this.setActive(false);
      return;
    }

    // Cache winglet trail anchors once (from glider.js trailAnchor nodes)
    if (!this._anchors || this._anchors[0]?.parent == null) {
      const found = [];
      glider.traverse((o) => {
        if (o.name === 'trailAnchor') found.push(o);
      });
      if (found.length >= 2) {
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
        const wa = new THREE.Vector3();
        const wb = new THREE.Vector3();
        found[0].getWorldPosition(wa);
        found[1].getWorldPosition(wb);
        const da = wa.clone().sub(pos).dot(right);
        const db = wb.clone().sub(pos).dot(right);
        this._anchors = da < db ? [found[0], found[1]] : [found[1], found[0]];
      } else {
        this._anchors = null;
      }
    }

    this._up.set(0, 1, 0).applyQuaternion(quat);

    if (this._anchors && this._anchors.length >= 2) {
      this._anchors[0].getWorldPosition(this._leftTip);
      this._anchors[1].getWorldPosition(this._rightTip);
    } else {
      // Fallback approximate tips (aft of wing)
      const half = 9.2 * (glider.scale?.x ?? 1.05);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
      const up = this._up;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
      this._leftTip
        .copy(pos)
        .addScaledVector(right, -half)
        .addScaledVector(up, 0.9)
        .addScaledVector(fwd, 0.35); // slightly aft of tip
      this._rightTip
        .copy(pos)
        .addScaledVector(right, half)
        .addScaledVector(up, 0.9)
        .addScaledVector(fwd, 0.35);
    }

    this.left.update(this._leftTip, this._up, true, speed);
    this.right.update(this._rightTip, this._up, true, speed);
  }

  update() {
    /* legacy no-op */
  }

  dispose() {
    this.left.dispose();
    this.right.dispose();
  }
}

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
 * Control surfaces: dark fill + neon outlines only.
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
          (m.transparent &&
            snap.color &&
            snap.color.r > 0.7 &&
            snap.color.g < 0.75 &&
            snap.color.b < 0.75);

        if (isLine) {
          // Neon outline — including control-surface edges
          m.color.setHex(TRON_CYAN);
          m.transparent = true;
          m.opacity = 0.98;
        } else if (isControl) {
          // Fill: nearly black (outlines carry the neon)
          m.color.setHex(TRON_SURFACE_FILL);
          m.transparent = true;
          m.opacity = 0.35;
          m.depthWrite = true;
        } else if (m.transparent && (snap.opacity ?? 1) < 0.55) {
          m.color.setHex(TRON_CYAN_SOFT);
          m.opacity = 0.25;
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

export function setTronMode(on, ctx) {
  tronOn = !!on;
  // Force re-find trail anchors when toggling
  if (ctx.trail) ctx.trail._anchors = null;
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

export { TRON_CYAN, TRON_BODY, TRON_SURFACE_FILL as TRON_ACCENT };
