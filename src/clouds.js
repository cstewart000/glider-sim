/**
 * Soft translucent clouds — shared low-poly spheres, modest count.
 */

import * as THREE from 'three';

// One shared low-segment sphere for all puffs
const SHARED_GEO = new THREE.SphereGeometry(1, 6, 5);

const MATS = [
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.FrontSide,
    fog: true,
  }),
  new THREE.MeshBasicMaterial({
    color: 0xf0f3f8,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    side: THREE.FrontSide,
    fog: true,
  }),
  new THREE.MeshBasicMaterial({
    color: 0xe4e8f0,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    side: THREE.FrontSide,
    fog: true,
  }),
];

function makeCloudMesh(rng) {
  const group = new THREE.Group();
  group.renderOrder = -2;

  const puffs = 3 + Math.floor(rng() * 3); // 3–5 (was 5–9)
  for (let i = 0; i < puffs; i++) {
    const mesh = new THREE.Mesh(SHARED_GEO, MATS[Math.floor(rng() * MATS.length)]);
    mesh.scale.set(12 + rng() * 20, 5 + rng() * 9, 10 + rng() * 16);
    mesh.position.set((rng() - 0.5) * 28, (rng() - 0.5) * 7, (rng() - 0.5) * 22);
    mesh.renderOrder = -2;
    mesh.frustumCulled = true;
    group.add(mesh);
  }
  group.scale.setScalar(0.8 + rng() * 1.3);
  return group;
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class CloudSystem {
  constructor(scene, opts = {}) {
    this.group = new THREE.Group();
    this.group.name = 'clouds';
    scene.add(this.group);

    this.count = opts.count ?? 28;
    this.radius = opts.radius ?? 850;
    this.minAlt = opts.minAlt ?? 80;
    this.maxAlt = opts.maxAlt ?? 520;
    this.wind = opts.wind ?? new THREE.Vector3(2.5, 0, 0.8);
    this.clouds = [];

    const rng = mulberry32(42);
    for (let i = 0; i < this.count; i++) {
      const mesh = makeCloudMesh(rng);
      const layer = i % 3;
      mesh.scale.multiplyScalar(layer === 0 ? 0.9 : layer === 1 ? 1.15 : 1.55);
      mesh.userData.layer = layer;
      mesh.userData.parallax = layer === 0 ? 1 : layer === 1 ? 0.55 : 0.25;
      this.group.add(mesh);
      this.clouds.push(mesh);
    }

    this._seeded = false;
    this._center = new THREE.Vector3();
  }

  seedAround(center) {
    this._center.copy(center);
    for (const c of this.clouds) this._respawn(c, center, true);
    this._seeded = true;
  }

  _respawn(cloud, center, initial = false) {
    const layer = cloud.userData.layer ?? 1;
    const rMin = layer === 0 ? 50 : layer === 1 ? 100 : 180;
    const rMax = layer === 0 ? 180 : layer === 1 ? 380 : this.radius;
    const theta = Math.random() * Math.PI * 2;
    const phi = (0.28 + Math.random() * 0.5) * Math.PI;
    const r = rMin + Math.random() * (rMax - rMin);

    let x = center.x + r * Math.sin(phi) * Math.cos(theta);
    let z = center.z + r * Math.sin(phi) * Math.sin(theta);
    let y = center.y + r * Math.cos(phi) * 0.4 + (Math.random() - 0.4) * 40;
    y = THREE.MathUtils.clamp(y, this.minAlt, this.maxAlt + center.y * 0.12);

    if (!initial && this._fwd) {
      const ahead = 0.55 + Math.random() * 0.4;
      x = center.x + this._fwd.x * r * ahead + (Math.random() - 0.5) * r * 0.7;
      z = center.z + this._fwd.z * r * ahead + (Math.random() - 0.5) * r * 0.7;
      y = THREE.MathUtils.clamp(center.y + (Math.random() - 0.35) * 90, this.minAlt, center.y + 140);
    }

    cloud.position.set(x, y, z);
    cloud.rotation.y = Math.random() * Math.PI * 2;
    cloud.userData.phase = Math.random() * Math.PI * 2;
  }

  update(dt, pilotPos, forward) {
    if (!this._seeded) this.seedAround(pilotPos);
    if (forward) this._fwd = forward;

    const r2 = this.radius * this.radius;
    const wind = this.wind;

    for (const cloud of this.clouds) {
      const par = cloud.userData.parallax ?? 1;
      cloud.position.x += wind.x * par * dt;
      cloud.position.z += wind.z * par * dt;
      cloud.userData.phase = (cloud.userData.phase || 0) + dt * 0.35;
      cloud.position.y += Math.sin(cloud.userData.phase) * 0.12 * dt;

      const dx = cloud.position.x - pilotPos.x;
      const dy = cloud.position.y - pilotPos.y;
      const dz = cloud.position.z - pilotPos.z;
      if (dx * dx + dy * dy + dz * dz > r2) this._respawn(cloud, pilotPos, false);
    }
  }
}
