/**
 * Thermal columns — cores, shells, lean with wind, height profile.
 * Subtle monochrome outlines (concept art restraint).
 */

import * as THREE from 'three';

// Ambient lean direction (matches atmosphere airfield light wind-ish)
const LEAN_X = 1.2;
const LEAN_Z = -0.4;

export class ThermalSystem {
  constructor(scene, heightAt) {
    this.heightAt = heightAt;
    this.thermals = [];
    this.group = new THREE.Group();
    this.group.name = 'thermals';
    scene.add(this.group);

    const spots = [
      { x: -80, z: -120, r: 35, strength: 5.5 },
      { x: 110, z: -200, r: 40, strength: 6.5 },
      { x: -40, z: -320, r: 45, strength: 7.0 },
      { x: 200, z: -280, r: 30, strength: 5.0 },
      { x: -180, z: -180, r: 38, strength: 6.0 },
      { x: 60, z: -450, r: 50, strength: 7.5 },
      { x: -120, z: -500, r: 35, strength: 5.5 },
      { x: 280, z: -150, r: 32, strength: 4.5 },
      { x: 20, z: -80, r: 28, strength: 4.0 },
      { x: -220, z: -350, r: 42, strength: 6.2 },
    ];

    const edgeMat = new THREE.LineBasicMaterial({
      color: 0xe8d48a,
      transparent: true,
      opacity: 0.18,
    });

    for (const s of spots) {
      const groundY = heightAt(s.x, s.z);
      const top = groundY + 220 + Math.random() * 60;
      const t = {
        x: s.x,
        z: s.z,
        r: s.r,
        strength: s.strength,
        groundY,
        top,
        phase: Math.random() * Math.PI * 2,
        // lean rate: meters of horizontal drift per meter of height
        lean: 0.08 + Math.random() * 0.06,
      };
      this.thermals.push(t);

      const h = top - groundY;
      const geo = new THREE.CylinderGeometry(s.r * 0.35, s.r * 0.9, h, 8, 1, true);
      const edges = new THREE.EdgesGeometry(geo, 1);
      const mesh = new THREE.LineSegments(edges, edgeMat);
      mesh.position.set(s.x, groundY + h * 0.5, s.z);
      // Slight tilt visual (cosmetic)
      mesh.rotation.z = -t.lean * 0.4;
      mesh.rotation.x = t.lean * 0.25;
      this.group.add(mesh);
      t.mesh = mesh;
    }

    const pCount = 48;
    const pGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(pCount * 3);
    const pData = [];
    for (let i = 0; i < pCount; i++) {
      const th = this.thermals[i % this.thermals.length];
      const ang = Math.random() * Math.PI * 2;
      const rr = Math.random() * th.r * 0.7;
      positions[i * 3] = th.x + Math.cos(ang) * rr;
      positions[i * 3 + 1] = th.groundY + Math.random() * (th.top - th.groundY);
      positions[i * 3 + 2] = th.z + Math.sin(ang) * rr;
      pData.push({ thermal: th, speed: 1.5 + Math.random() * 2.5 });
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.particles = new THREE.Points(
      pGeo,
      new THREE.PointsMaterial({
        color: 0xf0e0a0,
        size: 1.2,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        sizeAttenuation: true,
      })
    );
    this.particles.frustumCulled = true;
    this.group.add(this.particles);
    this._pData = pData;
    this._acc = 0;
  }

  /** Center of thermal at altitude y (leans with ambient). */
  _centerAt(t, y) {
    const h = Math.max(0, y - t.groundY);
    const leanScale = t.lean * h;
    const len = Math.hypot(LEAN_X, LEAN_Z) || 1;
    return {
      x: t.x + (LEAN_X / len) * leanScale,
      z: t.z + (LEAN_Z / len) * leanScale,
    };
  }

  /**
   * Vertical lift only (legacy).
   */
  sample(x, y, z) {
    return this.sampleWind(x, y, z).y;
  }

  /**
   * 3D thermal wind: core + shell, dies aloft, slight inflow at base.
   * @returns {{ x: number, y: number, z: number }}
   */
  sampleWind(x, y, z) {
    let u = 0;
    let v = 0;
    let w = 0;
    const now = performance.now() * 0.001;

    for (const t of this.thermals) {
      const hNorm = (y - t.groundY) / Math.max(1, t.top - t.groundY);
      if (hNorm < -0.05 || hNorm > 1.15) continue;

      const c = this._centerAt(t, y);
      const dx = x - c.x;
      const dz = z - c.z;
      const dist = Math.hypot(dx, dz);
      const rCore = t.r * 0.45;
      const rShell = t.r * 1.15;
      if (dist > rShell * 1.4) continue;

      // Vertical profile: strong mid, dies near top, weak near ground
      const vert =
        hNorm < 0
          ? 0
          : hNorm > 1
            ? 0
            : Math.sin(Math.min(1, hNorm) * Math.PI) * (1 - 0.35 * hNorm);

      // Core (strong) + shell (weaker, broader)
      const core = Math.exp(-(dist * dist) / (rCore * rCore * 0.55));
      const shell = Math.exp(-(dist * dist) / (rShell * rShell * 0.45)) * 0.35;
      const horiz = core + shell;

      const pulse = 0.88 + 0.12 * Math.sin(now * 0.9 + t.phase);
      const lift = t.strength * horiz * vert * pulse;
      v += lift;

      // Weak inflow toward core near base (convergence)
      if (hNorm < 0.35 && dist > 1) {
        const inflow = lift * 0.12 * (1 - hNorm / 0.35);
        u += (-dx / dist) * inflow;
        w += (-dz / dist) * inflow;
      }
      // Slight outflow near top
      if (hNorm > 0.75 && dist > 1) {
        const out = lift * 0.08 * ((hNorm - 0.75) / 0.25);
        u += (dx / dist) * out;
        w += (dz / dist) * out;
      }
    }

    return { x: u, y: v, z: w };
  }

  update(dt) {
    this._acc = (this._acc || 0) + dt;
    if (this._acc < 0.05) return;
    const step = this._acc;
    this._acc = 0;

    const pos = this.particles.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < this._pData.length; i++) {
      const d = this._pData[i];
      const th = d.thermal;
      arr[i * 3 + 1] += d.speed * step;
      // Drift with lean as they rise
      const h = arr[i * 3 + 1] - th.groundY;
      const leanScale = th.lean * d.speed * step;
      const len = Math.hypot(LEAN_X, LEAN_Z) || 1;
      arr[i * 3] += (LEAN_X / len) * leanScale;
      arr[i * 3 + 2] += (LEAN_Z / len) * leanScale;
      if (arr[i * 3 + 1] > th.top) {
        const ang = Math.random() * Math.PI * 2;
        const rr = Math.random() * th.r * 0.7;
        arr[i * 3] = th.x + Math.cos(ang) * rr;
        arr[i * 3 + 1] = th.groundY + 5;
        arr[i * 3 + 2] = th.z + Math.sin(ang) * rr;
      }
    }
    pos.needsUpdate = true;
  }
}
