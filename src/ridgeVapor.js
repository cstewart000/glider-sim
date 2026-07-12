/**
 * Ridge water-vapour — small translucent white circular particles
 * blowing onshore and rising on the windward face.
 */

import * as THREE from 'three';
import {
  terrainHeight,
  ridgeFaceInfo,
  getTerrainProfile,
  SEA_LEVEL,
} from './terrain.js';

const COUNT = 640;
/** When FPS is low, integrate every Nth particle per frame (all still drawn). */
const LOW_FPS_STRIDE = 2;

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Soft circular alpha disc for PointsMaterial (true round particles). */
function makeCircleTexture() {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Onshore wind field: sea → ridge (−Z), rises on windward face, follows ground.
 */
function windAt(x, y, z) {
  const { crestZ, ridgeH, run } = ridgeFaceInfo(x);
  const ground = terrainHeight(x, z);
  const agl = Math.max(0, y - ground);
  const faceDist = z - crestZ;

  let vz = -11 - Math.min(6, ridgeH * 0.04);
  let vx = Math.sin(x * 0.01 + z * 0.008) * 2.2;
  let vy = 0.15;

  if (faceDist > -run * 0.2 && faceDist < run * 1.2) {
    const t = faceDist > 0 ? 1 - faceDist / Math.max(run, 1) : 0.85;
    const faceFactor = Math.exp(-((faceDist - run * 0.35) ** 2) / ((run * 0.5) ** 2));
    vy = 2.5 + faceFactor * (9 + ridgeH * 0.06) * Math.max(0.2, t);
    vz *= 0.45 + 0.55 * clamp01(faceDist / Math.max(run, 1));
  }
  if (faceDist < 0) {
    const lee = Math.exp(-(faceDist * faceDist) / ((run * 0.35) ** 2));
    vy = -1.2 * lee + 0.4;
    vz = -4 - lee * 3;
  }

  const streamAgl =
    6 +
    clamp01(1 - Math.max(0, faceDist) / Math.max(run, 1)) * (18 + ridgeH * 0.35) +
    Math.sin(x * 0.05 + z * 0.03) * 3;
  const targetY = ground + streamAgl;
  vy += (targetY - y) * 0.35;

  if (agl < 2 && vy < 0) vy = 0.5;
  if (agl > ridgeH + 80) {
    vy *= 0.2;
    vz *= 0.5;
  }

  return { vx, vy, vz };
}

export class RidgeVaporSystem {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'ridgeVapor';
    this.group.visible = false;
    scene.add(this.group);

    this._rng = mulberry32(77);
    this._particles = [];
    this._follow = new THREE.Vector3(0, 100, 80);
    this._time = 0;
    this._circleTex = makeCircleTexture();

    const pos = new Float32Array(COUNT * 3);
    this._pGeo = new THREE.BufferGeometry();
    this._pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    // One colour: translucent white circles (soft disc texture)
    this._points = new THREE.Points(
      this._pGeo,
      new THREE.PointsMaterial({
        color: 0xffffff,
        map: this._circleTex,
        alphaMap: this._circleTex,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        size: 2.2,
        sizeAttenuation: true,
        fog: true,
        blending: THREE.NormalBlending,
      })
    );
    this._points.frustumCulled = false;
    this._points.renderOrder = -1;
    this.group.add(this._points);

    for (let i = 0; i < COUNT; i++) {
      this._particles.push(this._makeParticle());
    }
  }

  setVisible(v) {
    this.group.visible = !!v;
  }

  /**
   * @param {THREE.Vector3} center
   */
  seedAround(center) {
    this._follow.copy(center);
    for (const p of this._particles) this._respawn(p, true);
    this._writeBuffers();
  }

  _makeParticle() {
    return {
      x: 0,
      y: 40,
      z: 0,
      life: 0,
      maxLife: 1,
      phase: Math.random() * Math.PI * 2,
    };
  }

  _respawn(p, wide = false) {
    const rng = this._rng;
    const cx = this._follow.x;
    const span = wide ? 900 : 520;
    p.x = cx + (rng() - 0.5) * span;
    const info = ridgeFaceInfo(p.x);
    const u = rng();
    if (u < 0.55) {
      p.z = info.crestZ + info.run * (0.7 + rng() * 0.9) + rng() * 40;
    } else if (u < 0.9) {
      p.z = info.crestZ + info.run * rng() * 0.95;
    } else {
      p.z = info.crestZ - rng() * info.run * 0.25;
    }
    const ground = terrainHeight(p.x, p.z);
    const faceDist = p.z - info.crestZ;
    const streamAgl =
      4 +
      clamp01(1 - Math.max(0, faceDist) / Math.max(info.run, 1)) * (12 + info.ridgeH * 0.4) +
      rng() * 10;
    p.y = Math.max(SEA_LEVEL + 2, ground + streamAgl);
    p.life = rng() * 0.3;
    p.maxLife = 4.5 + rng() * 6;
    p.phase = rng() * Math.PI * 2;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} followPos
   * @param {boolean} [lowFps] stagger particle integrate to protect frame time
   */
  update(dt, followPos, lowFps = false) {
    if (!this.group.visible || getTerrainProfile() !== 'coastal') return;
    if (followPos) this._follow.copy(followPos);
    this._time += dt;
    // Slightly larger substep when staggered so motion stays continuous
    const t = Math.min(0.06, lowFps ? dt * LOW_FPS_STRIDE : dt);
    this._partCursor = (this._partCursor || 0) % LOW_FPS_STRIDE;

    for (let i = 0; i < COUNT; i++) {
      if (lowFps && i % LOW_FPS_STRIDE !== this._partCursor) continue;
      this._stepParticle(this._particles[i], t);
    }
    if (lowFps) this._partCursor++;
    this._writeBuffers();
  }

  _stepParticle(p, dt) {
    p.life += dt;
    if (p.life > p.maxLife) {
      this._respawn(p);
      return;
    }

    const w = windAt(p.x, p.y, p.z);
    const n = Math.sin(this._time * 2.1 + p.phase + p.x * 0.03);
    p.x += (w.vx + n * 1.4) * dt;
    p.y += w.vy * dt;
    p.z += w.vz * dt;

    const ground = terrainHeight(p.x, p.z);
    if (p.y < ground + 1.5) {
      p.y = ground + 1.5 + Math.random() * 2;
    }

    const dx = p.x - this._follow.x;
    const dz = p.z - this._follow.z;
    if (dx * dx + dz * dz > 1100 * 1100 || p.z < this._follow.z - 500) {
      this._respawn(p);
    }
  }

  _writeBuffers() {
    const pArr = this._pGeo.attributes.position.array;
    for (let i = 0; i < COUNT; i++) {
      const p = this._particles[i];
      const o = i * 3;
      // Hide particles at life edges by parking below terrain briefly
      const u = p.life / p.maxLife;
      const fade = u < 0.08 || u > 0.92;
      pArr[o] = p.x;
      pArr[o + 1] = fade ? p.y - 500 : p.y;
      pArr[o + 2] = p.z;
    }
    this._pGeo.attributes.position.needsUpdate = true;
    this._pGeo.computeBoundingSphere();
  }
}
