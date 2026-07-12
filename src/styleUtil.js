/**
 * Concept-art look: white flat fill + black contour lines (EdgesGeometry).
 */

import * as THREE from 'three';

const FILL = 0xffffff;
const LINE = 0x2a2a2e;
const LINE_SOFT = 0x5a5a60;

export function fillMaterial(opts = {}) {
  return new THREE.MeshBasicMaterial({
    color: opts.color ?? FILL,
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    depthWrite: opts.depthWrite ?? true,
    fog: opts.fog !== false,
  });
}

export function lineMaterial(soft = false) {
  return new THREE.LineBasicMaterial({
    color: soft ? LINE_SOFT : LINE,
    transparent: true,
    opacity: soft ? 0.55 : 0.92,
    depthWrite: false,
  });
}

/** Add mesh with matching edge outline. Returns group containing both. */
export function outlinedMesh(geometry, options = {}) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, fillMaterial(options));
  mesh.userData.isFill = true;
  group.add(mesh);

  if (options.noEdges) return group;

  const threshold = options.edgeThreshold ?? 20;
  const edges = new THREE.EdgesGeometry(geometry, threshold);
  const lines = new THREE.LineSegments(edges, lineMaterial(options.softLines));
  lines.userData.isOutline = true;
  // Tiny inflate so lines sit on top of fill
  lines.renderOrder = 1;
  group.add(lines);
  group.userData.fill = mesh;
  group.userData.outline = lines;
  return group;
}

/** Apply same transform to a fill+outline pair already built as Mesh+Lines. */
export function addOutlineToMesh(mesh, threshold = 20, soft = false) {
  const parent = mesh.parent || mesh;
  const edges = new THREE.EdgesGeometry(mesh.geometry, threshold);
  const lines = new THREE.LineSegments(edges, lineMaterial(soft));
  lines.position.copy(mesh.position);
  lines.rotation.copy(mesh.rotation);
  lines.scale.copy(mesh.scale);
  lines.renderOrder = 1;
  if (mesh.parent) mesh.parent.add(lines);
  else mesh.add(lines);
  return lines;
}

export function setVertexGray(geometry, getGray) {
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const g = getGray(pos.getX(i), pos.getY(i), pos.getZ(i), i);
    colors[i * 3] = g;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = g;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
