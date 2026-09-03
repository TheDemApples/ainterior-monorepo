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
import { imagePlaceholder, contactShadowTex } from './textures.js';

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


// ---------------------------------------------------------------- §G3 ------
// Image slots. A part flagged `"image_slot": true` renders a user image
// aspect-fit (letterboxed, NEVER stretched) with a neutral placeholder unset.
//
// Aspect-fit is done in the *texture matrix*, not the geometry: we scale
// tex.repeat and centre with tex.offset so the image keeps its proportions and
// the leftover area shows the mat/backing colour.

/** Part world size (mm) -> the aspect ratio of the visible picture area. */
function slotAspect(p) {
  const s = p.size || [100, 100, 100];
  // 'plane' with axis 'y' (wall art) reads size as [width, height];
  // a box frame reads [width, depth, height] -> the face is width x height.
  if (p.shape === 'plane') return (s[0] || 1) / (s[1] || 1);
  return (s[0] || 1) / (s[2] || s[1] || 1);
}

/** Apply aspect-fit UV transform for an image of `imgAspect` into `slotAspect`. */
export function fitTexture(tex, imgAspect, slotAsp) {
  if (!tex) return tex;
  tex.center.set(0.5, 0.5);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  let rx = 1, ry = 1;
  if (imgAspect > slotAsp) {
    // image is wider than the slot -> full width, letterbox top/bottom
    ry = imgAspect / slotAsp;
  } else {
    rx = slotAsp / imgAspect;
  }
  tex.repeat.set(rx, ry);
  tex.offset.set((1 - rx) / 2, (1 - ry) / 2);
  tex.needsUpdate = true;
  return tex;
}

function makeSlotMaterial(slotAsp) {
  const ph = imagePlaceholder();
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#ffffff'),
    map: ph,
    roughness: 0.86,
    metalness: 0.0,
    envMapIntensity: 0.3,
    side: THREE.FrontSide,
  });
  m.userData.isImageSlot = true;
  m.userData.slotAspect = slotAsp;
  m.userData.placeholder = ph;
  return m;
}

function toTexture(src) {
  return new Promise((resolve, reject) => {
    if (!src) return reject(new Error('no image'));
    if (src.isTexture) return resolve(src);
    if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) {
      const t = new THREE.CanvasTexture(src);
      t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
      t.userData = { w: src.width, h: src.height };
      return resolve(t);
    }
    if (src.nodeName === 'CANVAS' || src.nodeName === 'IMG') {
      const t = new THREE.CanvasTexture(src);
      t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
      t.userData = { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height };
      return resolve(t);
    }
    if (typeof src === 'string') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const t = new THREE.Texture(img);
        t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
        t.userData = { w: img.naturalWidth, h: img.naturalHeight };
        resolve(t);
      };
      img.onerror = () => reject(new Error('image load failed: ' + src));
      img.src = src;
      return;
    }
    reject(new Error('unsupported image source'));
  });
}

/**
 * Set the user image on every image slot in a proxy group.
 * @returns {Promise<boolean>} false if the item has no image slot.
 */
export function setProxyImage(group, src) {
  const slots = group && group.userData && group.userData.imageSlots;
  if (!slots || !slots.length) return Promise.resolve(false);
  return toTexture(src).then((tex) => {
    const w = (tex.userData && tex.userData.w) || (tex.image && (tex.image.width || tex.image.naturalWidth)) || 1;
    const h = (tex.userData && tex.userData.h) || (tex.image && (tex.image.height || tex.image.naturalHeight)) || 1;
    const imgAspect = w / h;
    for (const s of slots) {
      const t = tex.clone();
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      fitTexture(t, imgAspect, s.aspect);
      if (s.material.map && s.material.map.userData && s.material.map.userData.userImage) {
        s.material.map.dispose();
      }
      t.userData = { ...(t.userData || {}), userImage: true };
      s.material.map = t;
      s.material.needsUpdate = true;
      s.imgAspect = imgAspect;
    }
    return true;
  });
}

/** Restore the neutral placeholder. */
export function clearProxyImage(group) {
  const slots = group && group.userData && group.userData.imageSlots;
  if (!slots || !slots.length) return false;
  for (const s of slots) {
    if (s.material.map && s.material.map.userData && s.material.map.userData.userImage) {
      s.material.map.dispose();
    }
    const ph = imagePlaceholder();
    ph.center.set(0.5, 0.5); ph.repeat.set(1, 1); ph.offset.set(0, 0);
    s.material.map = ph;
    s.material.needsUpdate = true;
    s.imgAspect = null;
  }
  return true;
}

/**
 * §G.5 contact shadow: a soft radial decal just above the floor under the
 * item's footprint, so nothing looks pasted on. One shared texture, one
 * shared material; only the geometry is per-item (and it's 2 triangles).
 */
let CONTACT_MAT = null;
export function contactShadow(w_mm, d_mm) {
  if (!CONTACT_MAT) {
    CONTACT_MAT = new THREE.MeshBasicMaterial({
      color: 0x000000,
      alphaMap: contactShadowTex(),
      transparent: true,
      opacity: 0.40,
      depthWrite: false,
      side: THREE.FrontSide,
    });
  }
  const g = new THREE.PlaneGeometry(w_mm * MM * 1.5, d_mm * MM * 1.5);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, CONTACT_MAT);
  m.position.y = 0.004;
  m.renderOrder = -1;
  m.raycast = () => {};          // never a pick target
  m.userData.noShadow = true;
  m.name = 'contact-shadow';
  return m;
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
  const imageSlots = [];
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
    // §G3 — an image_slot part gets its OWN material (it carries a per-instance
    // texture), everything else keeps using the shared cached material.
    let mat, slotRec = null;
    if (p.image_slot === true) {
      const asp = slotAspect(p);
      mat = makeSlotMaterial(asp);
      slotRec = { material: mat, aspect: asp, imgAspect: null };
    } else {
      mat = mats
        ? mats.get(isHex(roleKey) ? roleKey : roleKey, bodyHex)
        : new THREE.MeshStandardMaterial({ color: 0xcccccc });
    }
    const mesh = new THREE.Mesh(geom, mat);
    if (slotRec) { slotRec.mesh = mesh; imageSlots.push(slotRec); }
    const pos = p.pos || [0, 0, 0];
    // plan -> three (SPEC §1)
    mesh.position.set((pos[0] || 0) * MM, (pos[2] || 0) * MM, -(pos[1] || 0) * MM);
    // §G.2/§G.5 — thin planes (rugs, art) only receive; solids cast.
    const thin = (p.shape === 'plane');
    mesh.castShadow = !thin;
    mesh.receiveShadow = true;
    mesh.userData.role = roleKey;
    if (slotRec) mesh.userData.imageSlot = true;
    group.add(mesh);
  }

  group.userData.imageSlots = imageSlots;

  // §G.5 — soft contact shadow under floor-standing items. Skipped for
  // wall/ceiling-mounted things and for rugs (which ARE the floor).
  const pl = item.placement || {};
  const floorStanding = !pl.wall_mounted && !pl.ceiling_mounted;
  const isRug = (item.archetype === 'rug') || (dims.h != null && dims.h <= 40);
  if (floorStanding && !isRug && opts.contactShadow !== false) {
    try { group.add(contactShadow(dims.w || 600, dims.d || 600)); } catch (_) { /* noop */ }
  }
  return group;
}

/** Free every geometry inside a proxy group (materials are shared/cached). */
export function disposeProxy(group) {
  group.traverse((o) => {
    if (o.isMesh && o.geometry) o.geometry.dispose();
    // per-instance image-slot materials are owned by the proxy; shared role
    // materials and the shared contact-shadow material are NOT.
    if (o.isMesh && o.material && o.material.userData && o.material.userData.isImageSlot) {
      if (o.material.map && o.material.map.userData && o.material.map.userData.userImage) {
        o.material.map.dispose();
      }
      o.material.dispose();
    }
  });
  if (group.userData) group.userData.imageSlots = [];
}

export default buildProxy;
