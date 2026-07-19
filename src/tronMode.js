/**
 * Tron mode — neon grid aesthetic, light-cycle trail, theme helpers.
 */

import * as THREE from 'three';

const TRON_CYAN = 0x00e8ff;
const TRON_CYAN_SOFT = 0x40f0ff;
const TRON_BODY = 0x060a10;
const TRON_ACCENT = 0xff2a6a; // magenta accent (control surfaces)
const TRON_FOG = 0x02060c;
const TRON_CLEAR = 0x00040a;

const CLASSIC_FOG = 0xe8eef2;
const CLASSIC_CLEAR = 0xeef2f5;

/** @type {boolean} */
let tronOn = false;

/**
 * Ribbon light trail behind the glider (Tron light-cycle).
 */
export class LightTrail {
  /**
   * @param {THREE.Scene} scene
   * @param {{ maxPoints?: number, minDist?: number }} [opts]
   */
  constructor(scene, opts = {}) {
    this.maxPoints = opts.maxPoints ?? 180;
    this.minDist = opts.minDist ?? 0.55;
    this.scene = scene;
    this.count = 0;
    this.head = 0;
    this.positions = new Float32Array(this.maxPoints * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3)
    );
    this.geo.setDrawRange(0, 0);

    // Core bright line
    this.matCore = new THREE.LineBasicMaterial({
      color: TRON_CYAN,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      linewidth: 2,
    });
    this.lineCore = new THREE.Line(this.geo, this.matCore);
    this.lineCore.frustumCulled = false;
    this.lineCore.renderOrder = 5;
    this.lineCore.visible = false;

    // Soft glow twin (same geo, fainter / slightly different color)
    this.matGlow = new THREE.LineBasicMaterial({
      color: TRON_CYAN_SOFT,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    this.lineGlow = new THREE.Line(this.geo, this.matGlow);
    this.lineGlow.frustumCulled = false;
    this.lineGlow.renderOrder = 4;
    this.lineGlow.visible = false;
    this.lineGlow.scale.set(1, 1, 1);

    // Second trail offset (wingtip pair feel) — shares buffer, slight Y offset at draw
    this.group = new THREE.Group();
    this.group.name = 'tronTrail';
    this.group.add(this.lineGlow);
    this.group.add(this.lineCore);
    scene.add(this.group);

    this._last = new THREE.Vector3(1e9, 1e9, 1e9);
    this._tmp = new THREE.Vector3();
  }

  setActive(on) {
    this.lineCore.visible = !!on;
    this.lineGlow.visible = !!on;
    if (!on) this.clear();
  }

  clear() {
    this.count = 0;
    this.head = 0;
    this.geo.setDrawRange(0, 0);
    this._last.set(1e9, 1e9, 1e9);
  }

  /**
   * @param {THREE.Vector3} pos world position (e.g. glider CG slightly below)
   * @param {boolean} active
   * @param {number} [speed] m/s — denser trail when faster
   */
  update(pos, active, speed = 20) {
    if (!active) {
      this.setActive(false);
      return;
    }
    this.lineCore.visible = true;
    this.lineGlow.visible = true;

    const minD = Math.max(0.35, this.minDist * (18 / Math.max(8, speed)));
    if (this._last.distanceToSquared(pos) < minD * minD && this.count > 2) {
      return;
    }
    this._last.copy(pos);

    const i = this.head % this.maxPoints;
    this.positions[i * 3] = pos.x;
    this.positions[i * 3 + 1] = pos.y;
    this.positions[i * 3 + 2] = pos.z;
    this.head++;
    this.count = Math.min(this.count + 1, this.maxPoints);

    // Rebuild ordered polyline (oldest → newest) for continuous ribbon
    const ordered = new Float32Array(this.count * 3);
    const start = this.head - this.count;
    for (let k = 0; k < this.count; k++) {
      const src = (start + k) % this.maxPoints;
      ordered[k * 3] = this.positions[src * 3];
      ordered[k * 3 + 1] = this.positions[src * 3 + 1];
      ordered[k * 3 + 2] = this.positions[src * 3 + 2];
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(ordered, 3));
    this.geo.setDrawRange(0, this.count);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  dispose() {
    this.scene.remove(this.group);
    this.geo.dispose();
    this.matCore.dispose();
    this.matGlow.dispose();
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
 * Recolor glider (and optional scene props) for Tron / classic.
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
        const isControl =
          name.includes('aileron') ||
          name.includes('elevator') ||
          name.includes('rudder') ||
          name.includes('brake');
        if (isLine) {
          m.color.setHex(TRON_CYAN);
          m.transparent = true;
          m.opacity = 0.95;
        } else if (isControl || m.userData?.isAccent) {
          m.color.setHex(TRON_ACCENT);
          m.transparent = true;
          m.opacity = Math.min(0.9, (snap.opacity ?? 1) + 0.15);
        } else if (m.transparent && (snap.opacity ?? 1) < 0.55) {
          // Canopy / glass → cyan tint
          m.color.setHex(TRON_CYAN_SOFT);
          m.opacity = 0.28;
        } else {
          m.color.setHex(TRON_BODY);
          m.opacity = 1;
          m.transparent = false;
        }
      } else if (snap.color) {
        m.color.copy(snap.color);
        m.opacity = snap.opacity;
        m.transparent = snap.transparent;
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
 * @param {THREE.Scene} ctx.scene
 * @param {THREE.WebGLRenderer} ctx.renderer
 * @param {THREE.Object3D} ctx.glider
 * @param {THREE.Object3D} [ctx.sunGroup]
 * @param {{ setTronMode?: (b: boolean) => void }} [ctx.audio]
 * @param {LightTrail} [ctx.trail]
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

export { TRON_CYAN, TRON_BODY, TRON_ACCENT };
