/**
 * The props of the cinema scene — a film reel, its unspooling strip, a
 * striped popcorn bucket, popcorn and ticket stubs — all modelled here from
 * primitives, curves and lathes. Units: roughly decimetres, y up.
 */

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  brushedDiscTextures,
  bucketTextures,
  FILM,
  filmStripTextures,
  seeded,
  ticketTexture,
  windingTextures,
} from './textures';

const shadows = <T extends THREE.Object3D>(object: T, cast = true, receive = true): T => {
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = cast;
      child.receiveShadow = receive;
    }
  });
  return object;
};

// ── film reel ───────────────────────────────────────────────────────────

export const REEL = {
  radius: 0.9,
  /** Outer radius of the film wound on the hub. */
  pack: 0.66,
  hub: 0.17,
  /** Gap between the flanges = the film's width (plus a hair). */
  gap: 0.24,
  flange: 0.022,
};

/** A flange: a disc with six rounded windows, bevelled, UVs centred. */
function flangeGeometry(): THREE.ExtrudeGeometry {
  const { radius, hub } = REEL;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
  const windows = 6;
  const r0 = hub + 0.08;
  const r1 = radius - 0.1;
  for (let i = 0; i < windows; i++) {
    const center = (i / windows) * Math.PI * 2 + Math.PI / 2;
    const halfOuter = (Math.PI / windows) * 0.64;
    const halfInner = halfOuter * 0.5;
    // A sector window (outer arc, straight sides, inner arc), its corners
    // rounded by a few rounds of corner cutting.
    let points: THREE.Vector2[] = [];
    const arc = (r: number, from: number, to: number, n: number) => {
      for (let k = 0; k <= n; k++) {
        const a = from + ((to - from) * k) / n;
        points.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
      }
    };
    const side = (from: THREE.Vector2, to: THREE.Vector2) => {
      for (let k = 1; k < 4; k++) points.push(from.clone().lerp(to, k / 4));
    };
    const corner = (r: number, a: number) => new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
    arc(r1, center - halfOuter, center + halfOuter, 7);
    side(corner(r1, center + halfOuter), corner(r0, center + halfInner));
    arc(r0, center + halfInner, center - halfInner, 3);
    side(corner(r0, center - halfInner), corner(r1, center - halfOuter));
    for (let round = 0; round < 4; round++) {
      const next: THREE.Vector2[] = [];
      for (let k = 0; k < points.length; k++) {
        const a = points[k];
        const b = points[(k + 1) % points.length];
        next.push(a.clone().lerp(b, 0.25), a.clone().lerp(b, 0.75));
      }
      points = next;
    }
    shape.holes.push(new THREE.Path(points));
  }
  // The arbor hole.
  const arbor = new THREE.Path();
  arbor.absarc(0, 0, 0.05, 0, Math.PI * 2, true);
  shape.holes.push(arbor);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: REEL.flange,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.006,
    bevelSegments: 3,
    curveSegments: 72,
  });
  // Planar UVs centred on the axis for every vertex (the cap material reads
  // them; the rim material ignores them).
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, position.getX(i) / (2 * radius) + 0.5, position.getY(i) / (2 * radius) + 0.5);
  }
  geometry.translate(0, 0, -REEL.flange / 2);
  return geometry;
}

export function makeReel(anisotropy: number) {
  const group = new THREE.Group();
  const spinner = new THREE.Group();
  group.add(spinner);
  const disc = brushedDiscTextures(anisotropy);

  // Spun aluminium faces (brushed rings in the roughness map) + plainer edges.
  // NOT anisotropic: three's anisotropic shading produced NaN pixels on these
  // faces (a degenerate direction / tangent frame), and bloom spread each one
  // over the whole frame — the scene blinked out (measured 2026-10-03: 64
  // empty frames in 1 581 with it; 0 without).
  const face = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: disc.map,
    metalness: 1,
    roughness: 1,
    roughnessMap: disc.roughnessMap,
    clearcoat: 0.25,
    clearcoatRoughness: 0.18,
  });
  const edge = new THREE.MeshStandardMaterial({ color: 0xbab3a8, metalness: 1, roughness: 0.32 });
  const flange = flangeGeometry();
  for (const side of [-1, 1]) {
    const mesh = new THREE.Mesh(flange, [face, edge]);
    mesh.position.z = side * (REEL.gap / 2 + REEL.flange / 2);
    spinner.add(mesh);
    // A rolled lip round the rim.
    const lip = new THREE.Mesh(new THREE.TorusGeometry(REEL.radius - 0.004, 0.012, 10, 160), edge);
    lip.position.z = mesh.position.z;
    spinner.add(lip);
  }

  // Gold-anodised hub with screws.
  const anodised = new THREE.MeshPhysicalMaterial({
    color: 0xd4b06a,
    metalness: 1,
    roughness: 0.34,
    clearcoat: 0.6,
    clearcoatRoughness: 0.12,
  });
  const hubLength = REEL.gap + REEL.flange * 2 + 0.05;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(REEL.hub * 0.62, REEL.hub * 0.62, hubLength, 48), anodised);
  hub.rotation.x = Math.PI / 2;
  spinner.add(hub);
  const collarGeometry = new THREE.CylinderGeometry(REEL.hub * 0.7, REEL.hub * 0.75, 0.03, 48);
  const screwGeometry = new THREE.CylinderGeometry(0.016, 0.016, 0.012, 16);
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x1a1512, metalness: 0.9, roughness: 0.4 });
  for (const side of [-1, 1]) {
    const collar = new THREE.Mesh(collarGeometry, anodised);
    collar.rotation.x = Math.PI / 2;
    collar.position.z = side * (REEL.gap / 2 + REEL.flange + 0.015);
    spinner.add(collar);
    const bore = new THREE.Mesh(new THREE.CircleGeometry(0.045, 6), darkSteel);
    bore.position.z = side * (REEL.gap / 2 + REEL.flange + 0.031);
    if (side < 0) bore.rotation.y = Math.PI;
    spinner.add(bore);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      const screw = new THREE.Mesh(screwGeometry, darkSteel);
      screw.rotation.x = Math.PI / 2;
      screw.position.set(Math.cos(a) * 0.088, Math.sin(a) * 0.088, side * (REEL.gap / 2 + REEL.flange + 0.03));
      spinner.add(screw);
    }
  }

  // The wound film: a drum with ring-textured faces.
  const winding = windingTextures(anisotropy, REEL.hub / REEL.pack);
  const filmEdge = new THREE.MeshPhysicalMaterial({
    color: 0x2a1a10,
    roughness: 0.35,
    clearcoat: 0.8,
    clearcoatRoughness: 0.2,
  });
  const filmFace = new THREE.MeshPhysicalMaterial({
    map: winding.map,
    roughness: 1,
    roughnessMap: winding.roughnessMap,
    clearcoat: 0.7,
    clearcoatRoughness: 0.25,
  });
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(REEL.pack, REEL.pack, REEL.gap - 0.01, 128, 1, true), filmEdge);
  drum.rotation.x = Math.PI / 2;
  spinner.add(drum);
  for (const side of [-1, 1]) {
    const ring = new THREE.RingGeometry(REEL.hub * 0.6, REEL.pack, 128, 1);
    // RingGeometry UVs already map the ring's square extent to 0..1, centred.
    const mesh = new THREE.Mesh(ring, filmFace);
    mesh.position.z = side * ((REEL.gap - 0.01) / 2);
    if (side < 0) mesh.rotation.y = Math.PI;
    spinner.add(mesh);
  }
  // RingGeometry UVs span its own outer radius, so the texture's rings
  // (painted for innerFraction = hub/pack) line up with the drum.

  shadows(group);
  return { group, spinner, textures: [disc.map, disc.roughnessMap, disc.anisotropyMap, winding.map, winding.roughnessMap] };
}

// ── film strip ──────────────────────────────────────────────────────────

export type StripPath = {
  /** Control points of the centre line. */
  points: THREE.Vector3[];
  /** Width direction hints at each control point (orthogonalised). */
  across: THREE.Vector3[];
};

/**
 * A ribbon along a Catmull–Rom curve. The width direction is interpolated
 * from per-point hints and kept perpendicular to the tangent, so the strip
 * can leave the reel edge-on and land flat on the floor. `update(t)` lets
 * it ripple gently in the air (positions rewritten in place).
 */
export function makeFilmStrip(path: StripPath, width: number, anisotropy: number) {
  const curve = new THREE.CatmullRomCurve3(path.points, false, 'centripetal');
  const segments = 480;
  const textures = filmStripTextures(anisotropy);

  const centre: THREE.Vector3[] = [];
  const tangent: THREE.Vector3[] = [];
  const side: THREE.Vector3[] = [];
  const normal: THREE.Vector3[] = [];
  const hints = path.across.map((v) => v.clone().normalize());
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    // Sampled by curve PARAMETER, so control point k sits exactly at
    // u = k / (n − 1) and its hint applies there; UVs use arc length below.
    const p = curve.getPoint(u);
    const t = curve.getTangent(u).normalize();
    // Interpolate the hint by arc fraction across control points.
    const f = u * (hints.length - 1);
    const k = Math.min(hints.length - 2, Math.floor(f));
    const s = f - k;
    const e = s * s * (3 - 2 * s);
    const hint = hints[k].clone().lerp(hints[k + 1], e);
    const b = hint.sub(t.clone().multiplyScalar(hint.dot(t))).normalize();
    const n = new THREE.Vector3().crossVectors(t, b).normalize();
    centre.push(p);
    tangent.push(t);
    side.push(b);
    normal.push(n);
  }

  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const normals = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices: number[] = [];
  const repeat = width * FILM.repeatInWidths;
  let along = 0;
  for (let i = 0; i <= segments; i++) {
    if (i > 0) along += centre[i].distanceTo(centre[i - 1]);
    uvs.set([along / repeat, 0, along / repeat, 1], i * 4);
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  /** How much each sample may ripple: 0 at the reel and once on the floor. */
  const airborne = centre.map((p, i) => {
    const u = i / segments;
    return Math.sin(Math.PI * Math.min(1, u / 0.72)) ** 2 * Math.min(1, Math.max(0, (p.y - 0.03) / 0.25));
  });
  const scratch = new THREE.Vector3();
  const scratchSide = new THREE.Vector3();
  const update = (time: number) => {
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const ripple = airborne[i] * (0.022 * Math.sin(time * 0.55 - u * 7) + 0.01 * Math.sin(time * 0.9 + u * 13));
      const roll = airborne[i] * 0.12 * Math.sin(time * 0.4 - u * 5);
      // Ripple along the normal, and a slow roll of the width direction.
      scratchSide.copy(side[i]).multiplyScalar(Math.cos(roll)).addScaledVector(normal[i], Math.sin(roll));
      const n = scratch.crossVectors(tangent[i], scratchSide).normalize();
      const cx = centre[i].x + normal[i].x * ripple;
      const cy = centre[i].y + normal[i].y * ripple;
      const cz = centre[i].z + normal[i].z * ripple;
      const hw = width / 2;
      positions.set(
        [cx - scratchSide.x * hw, cy - scratchSide.y * hw, cz - scratchSide.z * hw, cx + scratchSide.x * hw, cy + scratchSide.y * hw, cz + scratchSide.z * hw],
        i * 6,
      );
      normals.set([n.x, n.y, n.z, n.x, n.y, n.z], i * 6);
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    geometry.computeBoundingSphere();
  };
  update(0);

  // MeshStandardMaterial on purpose: with MeshPhysicalMaterial (clearcoat
  // + sheen) this ribbon rendered black on ANGLE/D3D11 (2026-10-03).
  const material = new THREE.MeshStandardMaterial({
    map: textures.map,
    emissiveMap: textures.emissiveMap,
    emissive: 0xffe2c0,
    emissiveIntensity: 1.7,
    alphaMap: textures.alphaMap,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.28,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // The film runs: scroll the texture with the reel's surface speed.
  const advance = (distance: number) => {
    const offset = -distance / repeat;
    textures.map.offset.x = offset;
    textures.emissiveMap.offset.x = offset;
    textures.alphaMap.offset.x = offset;
  };
  // Where the strip lies near the floor (for keeping spilt popcorn off it).
  const floorPoints = centre.filter((p, i) => i % 6 === 0 && p.y < 0.3);
  return { mesh, update, advance, floorPoints, textures: [textures.map, textures.emissiveMap, textures.alphaMap] };
}

// ── popcorn bucket ──────────────────────────────────────────────────────

export const BUCKET = { height: 1.05, bottom: 0.3, top: 0.46 };

export function makeBucket(anisotropy: number) {
  const group = new THREE.Group();
  const textures = bucketTextures(anisotropy);
  const { height, bottom, top } = BUCKET;
  // A tapered paper tub with a slight belly, and 14 shallow flutes (each
  // stripe a panel, as a folded paper tub has).
  const profile: THREE.Vector2[] = [];
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const v = i / steps;
    const r = bottom + (top - bottom) * Math.pow(v, 0.92) + 0.012 * Math.sin(Math.PI * v);
    profile.push(new THREE.Vector2(r, v * height));
  }
  const geometry = new THREE.LatheGeometry(profile, 196);
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const angle = Math.atan2(z, x);
    const flute = 1 + 0.008 * Math.abs(Math.cos(angle * 7));
    position.setX(i, x * flute);
    position.setZ(i, z * flute);
    uv.setY(i, position.getY(i) / height);
  }
  geometry.computeVertexNormals();
  const paper = new THREE.MeshPhysicalMaterial({
    map: textures.map,
    roughness: 1,
    roughnessMap: textures.roughnessMap,
    metalness: 1,
    metalnessMap: textures.metalnessMap,
    bumpMap: textures.roughnessMap,
    bumpScale: 0.6,
    clearcoat: 0.25,
    clearcoatRoughness: 0.35,
    sheen: 0.35,
    sheenColor: new THREE.Color(0xffe2c0),
    sheenRoughness: 0.6,
    side: THREE.DoubleSide,
  });
  const tub = new THREE.Mesh(geometry, paper);
  group.add(tub);
  // Base disc.
  const base = new THREE.Mesh(new THREE.CircleGeometry(bottom, 64), new THREE.MeshStandardMaterial({ color: 0xe9dcc4, roughness: 0.8 }));
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0.004;
  group.add(base);
  // Rolled rim.
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(top + 0.012, 0.02, 16, 196),
    new THREE.MeshPhysicalMaterial({ color: 0xf2e7d3, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.4, sheen: 0.4, sheenColor: new THREE.Color(0xffffff) }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = height;
  group.add(rim);
  shadows(group);
  return { group, textures: [textures.map, textures.roughnessMap, textures.metalnessMap] };
}

// ── popcorn ─────────────────────────────────────────────────────────────

/**
 * One popped kernel: a smooth union of overlapping puffs (spheres that all
 * contain the centre, so the surface is star-shaped and a sphere can be
 * pushed out onto it), with small cauliflower bumps and fine crinkles.
 * Vertex colours: creamy white on the puffs, buttery yellow in the creases
 * between them, and on some kernels a brown hull fragment in a crease.
 */
function kernelGeometry(seed: number, withHull: boolean): { geometry: THREE.BufferGeometry; radius: number } {
  const random = seeded(seed);
  const source = new THREE.IcosahedronGeometry(1, 4);
  source.deleteAttribute('normal');
  source.deleteAttribute('uv');
  const geometry = mergeVertices(source);
  source.dispose();
  const direction = () => new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
  const puffs = [{ c: new THREE.Vector3(), r: 0.42 }];
  const count = 6 + Math.floor(random() * 4);
  for (let i = 0; i < count; i++) {
    const r = 0.3 + random() * 0.22;
    puffs.push({ c: direction().multiplyScalar(r * (0.55 + random() * 0.35)), r });
  }
  const bumps = Array.from({ length: 30 }, () => ({ dir: direction(), amp: 0.02 + random() * 0.03, sharp: 30 + random() * 40 }));
  const crinkle = Array.from({ length: 5 }, () => ({ dir: direction(), freq: 14 + random() * 10, phase: random() * Math.PI * 2 }));
  const hull = direction();
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const d = new THREE.Vector3();
  const cream = new THREE.Color(0.95, 0.9, 0.79);
  const butter = new THREE.Color(0.88, 0.66, 0.3);
  const hullColor = new THREE.Color(0.22, 0.09, 0.03);
  const K = 26; // smooth-union sharpness: higher = crisper creases
  let maxRadius = 0;
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    d.fromBufferAttribute(position, i).normalize();
    // Far intersection of the ray from the centre with each puff.
    let best = 0;
    let second = 0;
    let sum = 0;
    const hits: number[] = [];
    for (const puff of puffs) {
      const b = d.dot(puff.c);
      const t = b + Math.sqrt(Math.max(0, b * b - puff.c.lengthSq() + puff.r * puff.r));
      hits.push(t);
      if (t > best) {
        second = best;
        best = t;
      } else if (t > second) second = t;
    }
    for (const t of hits) sum += Math.exp(K * (t - best));
    let r = best + Math.log(sum) / K;
    for (const bump of bumps) r += bump.amp * Math.pow(Math.max(0, d.dot(bump.dir)), bump.sharp);
    let wrinkle = 0;
    for (const w of crinkle) wrinkle += Math.sin(d.dot(w.dir) * w.freq + w.phase);
    r += wrinkle * 0.006;
    position.setXYZ(i, d.x * r, d.y * r, d.z * r);
    maxRadius = Math.max(maxRadius, r);
    // A crease is where two puffs meet (their hits nearly equal).
    const crease = 1 - Math.min(1, (best - second) / 0.09);
    color.copy(cream).lerp(butter, crease * crease * 0.7);
    if (withHull && d.dot(hull) > 0.82 && crease > 0.3) color.lerp(hullColor, Math.min(1, (d.dot(hull) - 0.82) * 9));
    colors.set([color.r, color.g, color.b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return { geometry, radius: maxRadius };
}

type KernelPlacement = { position: THREE.Vector3; scale: number; rotation: THREE.Euler };

/** Popcorn heaped in the bucket, spilt on the floor, and a few in the air. */
export function makePopcorn(bucketPosition: THREE.Vector3, keepClear: THREE.Vector3[] = []) {
  const random = seeded(1234);
  const variants = [
    kernelGeometry(11, false),
    kernelGeometry(29, true),
    kernelGeometry(47, false),
    kernelGeometry(83, true),
  ];
  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.78,
    sheen: 0.6,
    sheenColor: new THREE.Color(0xfff0d0),
    sheenRoughness: 0.5,
  });

  const placements: KernelPlacement[][] = variants.map(() => []);
  const placed: { p: THREE.Vector3; r: number }[] = [];
  const tryPlace = (p: THREE.Vector3, scale: number, minGap: number, variant = Math.floor(random() * variants.length)) => {
    const r = variants[variant].radius * scale;
    for (const other of placed) if (other.p.distanceTo(p) < (other.r + r) * minGap) return false;
    placed.push({ p, r });
    placements[variant].push({
      position: p,
      scale,
      rotation: new THREE.Euler(random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2),
    });
    return true;
  };

  // The heap: a dome over the rim, in two layers so no gaps show.
  const rimY = bucketPosition.y + BUCKET.height;
  const R = BUCKET.top * 1.02;
  const dome = (rho: number) => rimY + 0.27 * Math.pow(Math.max(0, 1 - rho * rho), 0.65) - 0.01;
  for (const [layer, count, gap] of [
    [-0.07, 140, 0.62],
    [0, 520, 0.74],
  ] as const) {
    let added = 0;
    for (let attempt = 0; attempt < count * 30 && added < count; attempt++) {
      const rho = Math.sqrt(random()) * 1.06;
      const angle = random() * Math.PI * 2;
      const scale = 0.08 + random() * 0.035;
      const y = dome(Math.min(1, rho)) + layer - (rho > 1 ? (rho - 1) * 0.9 : 0);
      const p = new THREE.Vector3(bucketPosition.x + Math.cos(angle) * rho * R, y, bucketPosition.z + Math.sin(angle) * rho * R);
      if (tryPlace(p, scale, gap)) added++;
    }
  }
  // Spilt on the floor, mostly in front of and beside the bucket.
  for (let attempt = 0, added = 0; attempt < 600 && added < 22; attempt++) {
    const angle = 0.15 + random() * 2.2;
    const distance = BUCKET.bottom + 0.08 + Math.pow(random(), 1.6) * 0.75;
    const variant = Math.floor(random() * variants.length);
    const scale = 0.08 + random() * 0.03;
    const p = new THREE.Vector3(
      bucketPosition.x + Math.cos(angle) * distance,
      variants[variant].radius * scale * 0.62,
      bucketPosition.z + Math.sin(angle) * distance,
    );
    if (keepClear.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.2)) continue;
    if (tryPlace(p, scale, 0.95, variant)) added++;
  }

  const meshes = variants.map((variant, v) => {
    const list = placements[v];
    const mesh = new THREE.InstancedMesh(variant.geometry, material, Math.max(1, list.length));
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    list.forEach((k, i) => {
      quaternion.setFromEuler(k.rotation);
      matrix.compose(k.position, quaternion, new THREE.Vector3(k.scale, k.scale, k.scale));
      mesh.setMatrixAt(i, matrix);
    });
    mesh.count = list.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  });

  // Kernels caught mid-air, in slow motion, above the heap.
  const floating = new THREE.InstancedMesh(variants[0].geometry, material, 3);
  floating.castShadow = true;
  floating.frustumCulled = false;
  const flyers = [
    { base: new THREE.Vector3(-0.16, 0.42, 0.12), scale: 0.09, phase: 0.0, spin: new THREE.Vector3(0.21, 0.33, 0.12) },
    { base: new THREE.Vector3(0.22, 0.62, -0.05), scale: 0.082, phase: 2.1, spin: new THREE.Vector3(-0.17, 0.25, 0.3) },
    { base: new THREE.Vector3(0.02, 0.86, 0.1), scale: 0.075, phase: 4.0, spin: new THREE.Vector3(0.3, -0.2, 0.15) },
  ];
  const flyMatrix = new THREE.Matrix4();
  const flyQuat = new THREE.Quaternion();
  const flyEuler = new THREE.Euler();
  const flyPos = new THREE.Vector3();
  const flyScale = new THREE.Vector3();
  const animate = (time: number) => {
    flyers.forEach((f, i) => {
      flyPos.set(
        bucketPosition.x + f.base.x + Math.sin(time * 0.21 + f.phase) * 0.03,
        rimY + f.base.y + Math.sin(time * 0.33 + f.phase) * 0.05,
        bucketPosition.z + f.base.z + Math.cos(time * 0.17 + f.phase) * 0.03,
      );
      flyEuler.set(time * f.spin.x + f.phase, time * f.spin.y, time * f.spin.z + f.phase * 0.5);
      flyQuat.setFromEuler(flyEuler);
      flyScale.setScalar(f.scale);
      flyMatrix.compose(flyPos, flyQuat, flyScale);
      floating.setMatrixAt(i, flyMatrix);
    });
    floating.instanceMatrix.needsUpdate = true;
  };
  animate(0);

  const group = new THREE.Group();
  for (const mesh of meshes) group.add(mesh);
  group.add(floating);
  const count = meshes.reduce((sum, mesh) => sum + mesh.count, 0);
  return { group, animate, count };
}

// ── ticket stubs ────────────────────────────────────────────────────────

/** A ticket: a thin card with a slight curl, both faces printed. */
export function makeTicket(anisotropy: number, variant: 'red' | 'ivory', serial: number, curl: number) {
  const map = ticketTexture(anisotropy, variant, serial);
  const width = 0.5;
  const height = 0.22;
  const geometry = new THREE.PlaneGeometry(width, height, 24, 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const u = x / width + 0.5;
    position.setZ(i, curl * Math.pow(Math.max(0, u - 0.55) / 0.45, 2));
  }
  geometry.computeVertexNormals();
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshPhysicalMaterial({
    map,
    roughness: 0.62,
    sheen: 0.4,
    sheenColor: new THREE.Color(0xffe8c8),
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, textures: [map] };
}
