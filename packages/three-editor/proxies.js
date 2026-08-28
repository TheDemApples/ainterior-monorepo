// packages/three-editor/proxies.js
// Build a THREE.Group from CatalogItem.proxy.parts (SPEC §4.1).
//
// Item-local part frame (SPEC §4.1): pos = [x, y, z] in **mm**, where
//   x = along item width, y = along item depth, z = elevation from the floor,
//   origin = footprint centre on the floor.
// Three.js mapping (SPEC §1):  three.x = x/1000, three.y = z/1000, three.z = -y/1000.
// We therefore author geometry in the plan frame (x = width, y = depth, extrude
// along +z = elevation) and rotate the geometry -90deg about X, which maps
// +z -> +y and +y -> -z: exactly the spec mapping, for free.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import { isHex } from './materials.js';

const MM = 1 / 1000;
const PLAN_TO_THREE = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

/** Rounded-rectangle Shape in the plan frame, centred on the origin. */
function roundedRectShape(w, d, r) {
  const hw = w / 2, hd = d / 2;
  const rr = Math.max(0, Math.min(r, Math.min(w, d) / 2 - 1e-6));
  const s = new THREE.Shape();
  if (rr <= 1e-6) {
    s.moveTo(-hw, -hd); s.lineTo(hw, -hd); s.lineTo(hw, hd); s.lineTo(-hw, hd);
    s.closePath();
    return s;
  }
  s.moveTo(-hw + rr, -hd);
  s.lineTo(hw - rr, -hd);
  s.quadraticCurveTo(hw, -hd, hw, -hd + rr);
  s.lineTo(hw, hd - rr);
  s.quadraticCurveTo(hw, hd, hw - rr, hd);
  s.lineTo(-hw + rr, hd);
  s.quadraticCurveTo(-hw, hd, -hw, hd - rr);
  s.lineTo(-hw, -hd + rr);
  s.quadraticCurveTo(-hw, -hd, -hw + rr, -hd);
  s.closePath();
  return s;
}

/**
 * Box, optionally with rounded corners.
 * SPEC-ASSUMPTION: `radius` rounds the *footprint* corners (the plan-view
 * corners) and is extruded straight through the height. This is the reading
 * that makes upholstered furniture read correctly; the spec only says
 * "optional corner rounding in mm".
 */
function boxGeom(w, d, h, radiusMm) {
  if (!radiusMm || radiusMm <= 0.5) {
    // width -> three.x, height -> three.y, depth -> three.z
    return new THREE.BoxGeometry(w * MM, h * MM, d * MM);
  }
  const shape = roundedRectShape(w * MM, d * MM, radiusMm * MM);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: h * MM, bevelEnabled: false, curveSegments: 6, steps: 1,
  });
  // Extrusion runs 0..h along local +z; centre it, then map plan -> three.
  g.translate(0, 0, -h * MM / 2);
  g.applyMatrix4(PLAN_TO_THREE);
  g.computeVertexNormals();
  return g;
}

/** Cylinder: size = [diameter_x, diameter_y, height]; y-diameter gives ellipses. */
function cylGeom(sx, sy, h, seg = 24) {
  const r = (sx * MM) / 2;
  const g = new THREE.CylinderGeometry(r, r, Math.max(h * MM, 1e-4), seg, 1, false);
  if (sy && Math.abs(sy - sx) > 0.5) g.scale(1, 1, sy / sx); // three.z == plan depth
  return g;
}

function sphereGeom(sx, sy, sz) {
  const r = (sx * MM) / 2;
  const g = new THREE.SphereGeometry(r, 20, 14);
  g.scale(1, sz ? sz / sx : 1, sy ? sy / sx : 1);
  return g;
}

/**
 * Plane. `axis` (optional, default 'z') is the plane's normal in the *item-local*
 * frame: 'z' = horizontal (rug, table top), 'y' = faces the item's depth axis
 * (TV screen, artwork), 'x' = faces the item's width axis.
 */
function planeGeom(sx, sy, axis) {
  const a = axis || 'z';
  let g;
  if (a === 'z') {
    g = new THREE.PlaneGeometry(sx * MM, sy * MM);
    g.rotateX(-Math.PI / 2);
  } else if (a === 'y') {
    g = new THREE.PlaneGeometry(sx * MM, sy * MM); // sy read as height
  } else {
    g = new THREE.PlaneGeometry(sx * MM, sy * MM);
    g.rotateY(Math.PI / 2);
  }
  return g;
}

/** Generic fallback proxy for an unknown archetype (SPEC §8.9 — no stubs). */
export function fallbackParts(dims) {
  const w = dims.w, d = dims.d, h = dims.h;
  const legH = Math.min(120, h * 0.18);
  if (h > 400 && w > 250 && d > 250) {
    return [
      { shape: 'box', pos: [0, 0, legH + (h - legH) / 2], size: [w, d, h - legH], color: 'body', radius: Math.min(28, Math.min(w, d) / 8) },
      { shape: 'box', pos: [0, 0, legH / 2], size: [w * 0.82, d * 0.82, legH], color: 'dark' },
    ];
  }
  return [{ shape: 'box', pos: [0, 0, h / 2], size: [w, d, h], color: 'body', radius: Math.min(20, Math.min(w, d) / 8) }];
}

/**
 * @param {object} item CatalogItem (SPEC §4.1)
 * @param {object} opts { materials, colorwayHex }
 * @returns {THREE.Group} group whose origin is the footprint centre on the floor,
 *          in metres, unrotated (the editor applies rot_deg via group.rotation.y).
 */
export function buildProxy(item, opts = {}) {
  const mats = opts.materials;
  const bodyHex = opts.colorwayHex || (item.colorways && item.colorways[0] && item.colorways[0].hex) || null;
  const group = new THREE.Group();
  group.name = 'proxy:' + item.id;

  const dims = item.dims_mm || { w: 600, d: 600, h: 600 };
  let parts = item.proxy && Array.isArray(item.proxy.parts) && item.proxy.parts.length
    ? item.proxy.parts
    : fallbackParts(dims);

  for (const p of parts) {
    const size = p.size || [100, 100, 100];
    const sx = Math.max(1, size[0] || 1);
    const sy = Math.max(1, size[1] || 1);
    const sz = Math.max(0.5, size[2] || 1);
    let geom;
    switch (p.shape) {
      case 'cyl': geom = cylGeom(sx, sy, sz); break;
      case 'sphere': geom = sphereGeom(sx, sy, sz); break;
      case 'plane': geom = planeGeom(sx, p.axis === 'z' ? sy : (p.axis ? sz : sy), p.axis); break;
      case 'box':
      default: geom = boxGeom(sx, sy, sz, p.radius); break;
    }
    const roleKey = p.color || 'body';
    const mat = mats
      ? mats.get(isHex(roleKey) ? roleKey : roleKey, bodyHex)
      : new THREE.MeshStandardMaterial({ color: 0xcccccc });
    const mesh = new THREE.Mesh(geom, mat);
    const pos = p.pos || [0, 0, 0];
    // plan -> three (SPEC §1)
    mesh.position.set((pos[0] || 0) * MM, (pos[2] || 0) * MM, -(pos[1] || 0) * MM);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.role = roleKey;
    group.add(mesh);
  }
  return group;
}

/** Free every geometry inside a proxy group (materials are shared/cached). */
export function disposeProxy(group) {
  group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
}

export default buildProxy;
