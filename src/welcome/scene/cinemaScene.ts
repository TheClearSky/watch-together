/**
 * The Welcome page's backdrop: a film reel unspooling its strip beside an
 * overflowing popcorn bucket, under a theatre spotlight. Everything is
 * built procedurally (props.ts, textures.ts) — no model or image files.
 *
 * NO SEAM. The scene is rendered against pure black, tone-mapped and
 * converted to sRGB, and faded to black towards every edge. It then meets
 * the page by SCREEN blending, which leaves the page untouched wherever the
 * scene is black:
 *
 *     out = 1 − (1 − page) · (1 − scene · edgeMask)
 *
 *  - blend 'baked' (default): the last pass does that blend itself against
 *    `background` — the canvas is opaque, and every empty or edge pixel IS
 *    the page colour, byte for byte;
 *  - blend 'transparent': the canvas is transparent and outputs the scene
 *    premultiplied, with alpha = its brightest channel. Ordinary "over"
 *    compositing then gives  page·(1 − max(scene)) + scene  — visually the
 *    same screen blend, and EXACTLY the page wherever the scene is black —
 *    against whatever is really behind the canvas (a gradient, embers), so
 *    the seam vanishes on any backdrop, not just a flat colour. (CSS
 *    mix-blend-mode: screen was tried first: Chrome composited the WebGL
 *    canvas as black — the scene vanished.)
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeBucket, makeFilmStrip, makePopcorn, makeReel, makeTicket, REEL } from './props';
import { floorRoughness, radialFade, seeded } from './textures';

export type CinemaScene = {
  /** CSS pixel size of the canvas. */
  resize(width: number, height: number): void;
  /** Kept for compatibility: the camera no longer follows the cursor. */
  setPointer(x: number, y: number): void;

  pause(): void;
  resume(): void;
  dispose(): void;
};

export type EdgeFade = {
  /** Fraction of the canvas width/height over which each edge fades out. */
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type CinemaSceneOptions = {
  /** prefers-reduced-motion: one still frame, no animation loop. */
  reducedMotion: boolean;
  /** The page colour behind the canvas, as CSS hex (#rrggbb). */
  background: string;
  /** How the render meets the page (see the file header). Default 'baked'. */
  blend?: 'baked' | 'transparent';
  /** Edge fade widths; the default fades the right edge (towards the page's
   *  content) the most. */
  edgeFade?: Partial<EdgeFade>;
  /** Upper bound for the device pixel ratio (default 1.75). */
  maxPixelRatio?: number;
};

const DEFAULT_FADE: EdgeFade = { left: 0.12, right: 0.3, top: 0.14, bottom: 0.16 };

// ── shaders ─────────────────────────────────────────────────────────────

const NOISE = /* glsl */ `
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
                   mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
                   mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
`;

/** A light shaft: an open cone, brightest where the eye looks through the
 *  most of it (the middle), with slowly drifting haze. Additive. */
const shaftVertex = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vLocal = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const shaftFragment = /* glsl */ `
  uniform float uTime;
  uniform float uLength;
  uniform float uStrength;
  uniform vec3 uColor;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vWorld;
  ${NOISE}
  void main() {
    float along = clamp(-vLocal.y / uLength, 0.0, 1.0);
    vec3 view = normalize(cameraPosition - vWorld);
    float through = pow(abs(dot(normalize(vNormal), view)), 1.8);
    vec3 drift = vec3(0.0, uTime * 0.05, uTime * 0.03);
    float haze = noise3(vWorld * 1.7 + drift) * 0.6 + noise3(vWorld * 4.3 - drift * 1.7) * 0.4;
    haze = 0.45 + 0.75 * haze;
    float ends = smoothstep(0.0, 0.18, along) * (1.0 - smoothstep(0.62, 1.0, along));
    // Fade out well above the floor: the cone must not draw its footprint.
    ends *= smoothstep(0.05, 1.4, vWorld.y);
    gl_FragColor = vec4(uColor * uStrength * through * haze * ends, 1.0);
  }
`;

/*
 * Floating motes (2026-10-03: "i dont like the flashes and flickering,
 * instead have bigger particles that slowly disappear and reappear moving in
 * a flowy way"). Big, soft, dim bokeh discs — never sub-pixel, so they cannot
 * shimmer — each living a long slow cycle: fade in over a few seconds, drift
 * along a smooth flow field, fade out, and come back somewhere else. Kept
 * dim enough that bloom never catches them (no pulsing).
 */
const dustVertex = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aSeed;
  attribute vec3 aDrift;
  varying float vGlow;
  varying float vTint;
  void main() {
    float period = 10.0 + 8.0 * fract(aSeed * 7.13);
    float cycle = uTime / period + aSeed * 3.7;
    float life = fract(cycle);
    float generation = floor(cycle);
    // A new home each time it comes back (pseudo-random per generation).
    vec3 home = position + vec3(
      sin(generation * 12.9898 + aSeed * 78.233) * 0.55,
      sin(generation * 4.1414 + aSeed * 31.4) * 0.35,
      cos(generation * 7.3333 + aSeed * 19.1) * 0.45);
    // Flowing drift: layered slow sines that depend on position — a soft
    // current rather than a wobble — plus a gentle rise over the life.
    float t = uTime * 0.12;
    vec3 p = home;
    p.x += sin(t * aDrift.x + home.y * 1.7 + aSeed * 6.0) * 0.32 + sin(t * 0.43 + home.z * 2.1) * 0.12;
    p.z += cos(t * aDrift.z + home.x * 1.3 + aSeed * 4.0) * 0.28;
    p.y += life * (0.35 + 0.35 * aDrift.y) + sin(t * 0.7 + home.x * 1.9 + aSeed * 9.0) * 0.08;
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    float fade = smoothstep(0.0, 0.3, life) * (1.0 - smoothstep(0.62, 1.0, life));
    vGlow = fade * (0.35 + 0.65 * fract(aSeed * 5.3));
    vTint = fract(aSeed * 11.7);
    gl_PointSize = (16.0 + fract(aSeed * 3.1) * 26.0) * uPixelRatio * (4.0 / -view.z);
    gl_Position = projectionMatrix * view;
  }
`;

const dustFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vGlow;
  varying float vTint;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    // Soft bokeh: a gaussian core with a faint rim, nothing hard-edged.
    float core = exp(-d * d * 4.5);
    float rim = smoothstep(1.0, 0.82, d) * smoothstep(0.55, 0.85, d) * 0.18;
    float disc = (core + rim) * (1.0 - smoothstep(0.9, 1.0, d));
    vec3 ember = vec3(0.86, 0.28, 0.24);
    vec3 color = mix(uColor, ember, step(0.82, vTint) * 0.7);
    gl_FragColor = vec4(color * disc * vGlow * 0.22, 1.0);
  }
`;

/** Last pass: screen the (sRGB) render onto the page colour, edge-faded. */
const SeamShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uPage: { value: new THREE.Vector3() },
    uBaked: { value: 1 },
    uFade: { value: new THREE.Vector4() },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uPage;
    uniform float uBaked;
    uniform vec4 uFade; // left, right, top, bottom
    uniform float uTime;
    varying vec2 vUv;
    float ease(float x) { return x * x * x * (x * (x * 6.0 - 15.0) + 10.0); }
    void main() {
      vec3 scene = texture2D(tDiffuse, vUv).rgb;
      float mask = ease(clamp(vUv.x / uFade.x, 0.0, 1.0))
                 * ease(clamp((1.0 - vUv.x) / uFade.y, 0.0, 1.0))
                 * ease(clamp((1.0 - vUv.y) / uFade.z, 0.0, 1.0))
                 * ease(clamp(vUv.y / uFade.w, 0.0, 1.0));
      // A soft oval vignette on top, so no straight fade line reads.
      vec2 q = (vUv - 0.5) * vec2(1.25, 1.0);
      mask *= 1.0 - 0.45 * smoothstep(0.32, 0.72, length(q));
      scene *= mask;
      vec3 outColor = mix(scene, 1.0 - (1.0 - uPage) * (1.0 - scene), uBaked);
      float alpha = 1.0;
      // (No film grain: re-randomised every frame it read as flicker.)
      outColor = clamp(outColor, 0.0, 1.0);
      // Transparent mode: premultiplied colour, alpha = brightest channel.
      if (uBaked < 0.5) alpha = max(outColor.r, max(outColor.g, outColor.b));
      gl_FragColor = vec4(outColor, alpha);
    }
  `,
};

// ── environment ─────────────────────────────────────────────────────────

/** A dark theatre for the metals to reflect: a warm softbox overhead, red
 *  velvet glows to the sides, a gold strip, a cool panel behind. */
function makeEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const room = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const sphere = new THREE.SphereGeometry(20, 32, 16);
  const dark = new THREE.MeshBasicMaterial({ color: 0x030101, side: THREE.BackSide });
  room.add(new THREE.Mesh(sphere, dark));
  disposables.push(sphere, dark);
  const panel = (w: number, h: number, color: THREE.Color, position: THREE.Vector3) => {
    const geometry = new THREE.PlaneGeometry(w, h);
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.lookAt(0, 0, 0);
    room.add(mesh);
    disposables.push(geometry, material);
  };
  panel(4, 3, new THREE.Color(7, 5.6, 4), new THREE.Vector3(2, 12, 4));
  panel(7, 9, new THREE.Color(0.3, 0.012, 0.02), new THREE.Vector3(-11, 2, 3));
  panel(7, 9, new THREE.Color(0.22, 0.01, 0.016), new THREE.Vector3(11, 2, -2));
  panel(10, 1.2, new THREE.Color(2.2, 1.6, 0.8), new THREE.Vector3(6, 3, 9));
  panel(24, 24, new THREE.Color(0.02, 0.01, 0.008), new THREE.Vector3(0, -12, 0));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(room, 0.035).texture;
  pmrem.dispose();
  for (const item of disposables) item.dispose();
  return texture;
}

function parseHex(hex: string): THREE.Vector3 {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const value = match ? parseInt(match[1], 16) : 0x0a0606;
  return new THREE.Vector3(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

// ── the scene ───────────────────────────────────────────────────────────

export function createCinemaScene(canvas: HTMLCanvasElement, options: CinemaSceneOptions): CinemaScene {
  const transparent = options.blend === 'transparent';
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // SMAA in the composer instead
    alpha: transparent,
    premultipliedAlpha: true,
    stencil: false,
    // A backdrop: never wake a laptop's discrete GPU for it.
    powerPreference: 'low-power',
  });
  const maxPixelRatio = Math.min(window.devicePixelRatio || 1, options.maxPixelRatio ?? 1.75);
  let pixelRatio = maxPixelRatio;
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x000000, transparent ? 0 : 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // The casters barely move (a slow reel, three drifting kernels, a gentle
  // ripple): the shadow map is redrawn every third frame, not every frame.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  // Count every pass of a frame, not just the last one (read in DEV by
  // the verification page).
  renderer.info.autoReset = false;
  // Read by the verification page (DEV only): per-frame render stats.
  if (import.meta.env.DEV) (canvas as HTMLCanvasElement & { __cinemaInfo?: THREE.WebGLInfo }).__cinemaInfo = renderer.info;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.075);
  const environment = makeEnvironment(renderer);
  scene.environment = environment;
  scene.environmentIntensity = 0.7;
  const textures: THREE.Texture[] = [];
  const time = { value: 0 };

  // Glossy black stage floor; only the spotlight's pool shows.
  const floorRough = floorRoughness(anisotropy);
  floorRough.repeat.set(3, 3);
  textures.push(floorRough);
  // The stage dissolves radially: its colour fades to nothing between
  // ~0.8 and ~3.4 units from the props.
  const floorFadeColor = radialFade(0.1, 0.42);
  floorFadeColor.colorSpace = THREE.SRGBColorSpace;
  textures.push(floorFadeColor);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(8, 96),
    new THREE.MeshStandardMaterial({
      color: 0x2c1915,
      map: floorFadeColor,
      roughness: 0.6,
      roughnessMap: floorRough,
      envMapIntensity: 0.12,
    }),
  );
  // Its REFLECTIONS fade with the colour too: seen from behind (the
  // fly-around) the spotlight's sheen otherwise ends in a hard line at the
  // floor's rim.
  (floor.material as THREE.MeshStandardMaterial).onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      float wtFade = texture2D(map, vMapUv).r;
      reflectedLight.directSpecular *= wtFade;
      reflectedLight.indirectSpecular *= wtFade;`,
    );
  };
  floor.position.set(0.1, 0, 0.5);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // The hero group.
  const hero = new THREE.Group();
  scene.add(hero);

  const bucketPosition = new THREE.Vector3(0.45, 0, 0.35);
  const bucket = makeBucket(anisotropy);
  bucket.group.position.copy(bucketPosition);
  bucket.group.rotation.y = -0.35;
  hero.add(bucket.group);
  textures.push(...bucket.textures);

  const reel = makeReel(anisotropy);
  reel.group.position.set(-0.6, 1.22, -0.5);
  reel.group.rotation.set(0.04, 0.58, -0.06);
  hero.add(reel.group);
  textures.push(...reel.textures);
  hero.updateMatrixWorld(true);

  // The strip peels off the bottom of the wound film (angle EXIT on the
  // reel), swings out towards the camera with its frames facing us, and
  // comes to rest flat on the floor in front of the bucket.
  const EXIT = THREE.MathUtils.degToRad(-80);
  const SPIN = -0.16; // rad/s, clockwise seen from the reel's +z face: unwinds
  const exitLocal = new THREE.Vector3(Math.cos(EXIT) * REEL.pack, Math.sin(EXIT) * REEL.pack, 0);
  const exitTangentLocal = new THREE.Vector3(Math.sin(EXIT), -Math.cos(EXIT), 0);
  const reelQuaternion = reel.group.getWorldQuaternion(new THREE.Quaternion());
  const p0 = reel.group.localToWorld(exitLocal.clone());
  const t0 = exitTangentLocal.clone().applyQuaternion(reelQuaternion);
  const axle = new THREE.Vector3(0, 0, 1).applyQuaternion(reelQuaternion);
  const up = new THREE.Vector3(0, 1, 0);
  const layBack = new THREE.Vector3(0, 0, -1);
  const strip = makeFilmStrip(
    {
      points: [
        p0,
        p0.clone().addScaledVector(t0, 0.25),
        new THREE.Vector3(-1.05, 0.5, 0.0),
        new THREE.Vector3(-1.28, 0.6, 0.5),
        new THREE.Vector3(-1.02, 0.7, 1.0),
        new THREE.Vector3(-0.48, 0.68, 1.34),
        new THREE.Vector3(0.08, 0.5, 1.5),
        new THREE.Vector3(0.5, 0.2, 1.56),
        new THREE.Vector3(0.92, 0.012, 1.46),
        new THREE.Vector3(1.34, 0.012, 1.2),
      ],
      // Width direction: along the reel's axle as it leaves, twisting
      // upright for a U-turn so the frames face us across the front, then
      // laying back flat on the floor.
      across: [axle, axle, axle.clone().lerp(up, 0.6), up, up, up, up, new THREE.Vector3(0, 0.55, -0.83), layBack, layBack],
    },
    REEL.gap - 0.02,
    anisotropy,
  );
  hero.add(strip.mesh);
  textures.push(...strip.textures);

  const popcorn = makePopcorn(bucketPosition, strip.floorPoints);
  hero.add(popcorn.group);

  const tickets = [
    { variant: 'red' as const, serial: 7, curl: 0.05, position: new THREE.Vector3(1.0, 0.006, 0.62), turn: 0.9 },
    { variant: 'ivory' as const, serial: 12, curl: 0.035, position: new THREE.Vector3(1.12, 0.012, 0.78), turn: 0.45 },
  ];
  for (const ticket of tickets) {
    const made = makeTicket(anisotropy, ticket.variant, ticket.serial, ticket.curl);
    made.mesh.position.copy(ticket.position);
    made.mesh.rotation.y = ticket.turn;
    hero.add(made.mesh);
    textures.push(...made.textures);
  }

  // ── lights ──
  const keyPosition = new THREE.Vector3(1.1, 5.4, 2.0);
  const keyTarget = new THREE.Vector3(0.0, 0.45, 0.35);
  const key = new THREE.SpotLight(0xffdcae, 90, 0, 0.3, 0.85, 2);
  key.position.copy(keyPosition);
  key.target.position.copy(keyTarget);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 2.5;
  key.shadow.camera.far = 9;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.015;
  key.shadow.radius = 5;
  scene.add(key, key.target);
  // Cool back light for silhouettes — from low behind, aimed UP past the
  // reel, so its beam never lands on the glossy floor in front (where it
  // would mirror as a blue glare).
  const back = new THREE.SpotLight(0xc4ccff, 16, 0, 0.32, 0.8, 2);
  back.position.set(-0.9, 0.5, -4.2);
  back.target.position.set(-0.3, 2.0, 0.2);
  scene.add(back, back.target);
  // Warm gold rims from behind right and low left.
  const rimRight = new THREE.SpotLight(0xffc27a, 30, 0, 0.4, 0.9, 2);
  rimRight.position.set(3.0, 2.4, -2.2);
  rimRight.target.position.set(0.2, 1.0, 0.2);
  scene.add(rimRight, rimRight.target);
  // A soft kicker from the camera's upper left: draws the radial streak
  // across the spun aluminium and a glint along the film.
  const kicker = new THREE.SpotLight(0xfff0dc, 26, 0, 0.32, 1, 2);
  kicker.position.set(-1.6, 2.8, 4.2);
  kicker.target.position.set(-0.55, 1.1, -0.4);
  scene.add(kicker, kicker.target);
  // A gentle warm fill from the camera's right for the bucket's print.
  const fill = new THREE.SpotLight(0xffe4c4, 9, 0, 0.3, 1, 2);
  fill.position.set(2.4, 1.6, 4.4);
  fill.target.position.set(0.45, 0.6, 0.35);
  scene.add(fill, fill.target);

  // ── light shafts and dust ──
  const shafts: THREE.Mesh[] = [];
  const shaft = (apex: THREE.Vector3, target: THREE.Vector3, radius: number, color: THREE.Color, strength: number) => {
    const length = apex.distanceTo(target) * 1.08;
    const geometry = new THREE.CylinderGeometry(0.04, radius, length, 72, 1, true);
    geometry.translate(0, -length / 2, 0);
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: time, uLength: { value: length }, uStrength: { value: strength }, uColor: { value: color } },
      vertexShader: shaftVertex,
      fragmentShader: shaftFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(apex);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), target.clone().sub(apex).normalize());
    mesh.renderOrder = 10;
    scene.add(mesh);
    shafts.push(mesh);
    return { mesh, length };
  };
  shaft(keyPosition, new THREE.Vector3(0.0, 0, 0.4), 1.75, new THREE.Color(1.0, 0.8, 0.56), 0.04);
  shaft(keyPosition, new THREE.Vector3(0.0, 0, 0.4), 1.1, new THREE.Color(1.0, 0.86, 0.66), 0.024);
  // A faint projector beam crossing high behind the reel.
  shaft(new THREE.Vector3(-4.2, 3.6, -3.4), new THREE.Vector3(2.6, 1.4, 0.4), 1.0, new THREE.Color(0.95, 0.82, 0.62), 0.014);

  const DUST = 90;
  const dustRandom = seeded(77);
  const dustPositions = new Float32Array(DUST * 3);
  const dustSeeds = new Float32Array(DUST);
  const dustDrift = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    // A loose cloud around the reel and bucket, mostly in the light.
    const a = dustRandom() * Math.PI * 2;
    const r = 0.3 + Math.sqrt(dustRandom()) * 2.1;
    dustPositions.set([Math.cos(a) * r * 1.2, 0.15 + dustRandom() * 2.4, 0.4 + Math.sin(a) * r * 0.8], i * 3);
    dustSeeds[i] = dustRandom();
    dustDrift.set([0.6 + dustRandom() * 0.8, dustRandom(), 0.5 + dustRandom() * 0.8], i * 3);
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute('aSeed', new THREE.BufferAttribute(dustSeeds, 1));
  dustGeometry.setAttribute('aDrift', new THREE.BufferAttribute(dustDrift, 3));
  const dustMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: time, uPixelRatio: { value: pixelRatio }, uColor: { value: new THREE.Color(1.0, 0.85, 0.6) } },
    vertexShader: dustVertex,
    fragmentShader: dustFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.frustumCulled = false;
  dust.renderOrder = 11;
  scene.add(dust);

  // ── camera and post ──
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 40);
  const lookAt = new THREE.Vector3(-0.06, 0.72, 0.4);
  const DISTANCE = 6.1;
  const BASE_AZIMUTH = 0.3; // from +z towards +x
  const BASE_ELEVATION = 0.15;
  const FRAME = 0.265;
  // Not a multisampled target: on ANGLE/D3D11 a HalfFloat MSAA target
  // came back empty (measured 2026-10-03). SMAA after the output pass.
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  // Guard: a single NaN/Inf pixel becomes a WHOLE blank frame once bloom
  // blurs it across the screen (the reel's anisotropy did exactly that).
  // Zero any non-finite pixel before bloom ever sees it.
  composer.addPass(
    new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          bool bad = any(isnan(c)) || any(greaterThan(abs(c.rgb), vec3(6.0e4)));
          gl_FragColor = bad ? vec4(0.0, 0.0, 0.0, c.a == c.a ? c.a : 1.0) : c;
        }
      `,
    }),
  );
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.55, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const smaa = new SMAAPass();
  composer.addPass(smaa);
  const seam = new ShaderPass(SeamShader);
  seam.uniforms.uPage.value = parseHex(options.background);
  seam.uniforms.uBaked.value = transparent ? 0 : 1;
  const fade = { ...DEFAULT_FADE, ...options.edgeFade };
  seam.uniforms.uFade.value.set(fade.left, fade.right, fade.top, fade.bottom);
  composer.addPass(seam);
  // DEV-only: switch passes off to bisect rendering problems (?scenePasses=-bloom,-smaa).
  if (import.meta.env.DEV) {
    const off = new URLSearchParams(location.search).get('scenePasses') ?? '';
    if (off.includes('-bloom')) bloom.enabled = false;
    if (off.includes('-smaa')) smaa.enabled = false;
    if (off.includes('-shadows')) renderer.shadowMap.enabled = false;
  }

  /*
   * The camera (2026-10-03: "have the camera take a quick fly around the
   * scene once in a while and usually do an idle slow zoom, and rotation
   * changes keeping the camera in the front of the scene" — no cursor
   * tracking). Idle: a slow breathing zoom and gentle angle changes inside a
   * front arc. Every 30–45 s: one eased orbit all the way round (it ends
   * exactly where it started, so the idle path continues seamlessly).
   */
  const STILL_AT = 7.5; // the reduced-motion frame (and the clock's start)
  const FLY_SECONDS = 7.5;
  const flyRandom = seeded(2026);
  const flights: number[] = [];
  let nextFlight = STILL_AT + 16;
  const flightAt = (t: number): number | null => {
    while (nextFlight <= t + FLY_SECONDS) {
      flights.push(nextFlight);
      nextFlight += 30 + flyRandom() * 15;
    }
    for (let index = flights.length - 1; index >= 0; index -= 1) {
      const u = (t - flights[index]) / FLY_SECONDS;
      if (u >= 0 && u < 1) return u;
    }
    return null;
  };
  const smoother = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
  // ── the visitor's hand (2026-10-03: "dont have the button, let user
  // rotate if they drag or pinch or scroll and drag on the canvas") ──
  // Drag turns, pinch / Ctrl-wheel zooms; a plain wheel and vertical swipes
  // still scroll the PAGE. Left alone for a few seconds, the camera glides
  // back onto its own path.
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(lookAt);
  controls.enableDamping = !options.reducedMotion;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.7;
  controls.minDistance = 3.4;
  controls.maxDistance = 9.5;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = Math.PI / 2 - 0.06; // never under the floor
  canvas.style.touchAction = 'pan-y'; // vertical swipes scroll the page
  canvas.style.cursor = 'grab';
  // A plain wheel scrolls the page; only Ctrl/⌘ + wheel (and trackpad pinch,
  // which arrives as ctrl+wheel) zooms the scene.
  const wheelGate = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) event.stopImmediatePropagation();
  };
  canvas.addEventListener('wheel', wheelGate, { capture: true });
  let handHeld = false; // pointer down / pinching
  let handUntil = -Infinity; // scene time until which the hand keeps the camera
  const HAND_HOLD_SECONDS = 4;
  const onHandStart = () => {
    handHeld = true;
    glide = null;
    controls.target.copy(autoTarget);
    canvas.style.cursor = 'grabbing';
    if (options.reducedMotion) start();
  };
  const onHandEnd = () => {
    handHeld = false;
    handUntil = clock + STILL_AT + HAND_HOLD_SECONDS;
    canvas.style.cursor = 'grab';
  };
  controls.addEventListener('start', onHandStart);
  if (options.reducedMotion) controls.addEventListener('change', () => renderNow());
  controls.addEventListener('end', onHandEnd);
  /** Gliding back to the automatic path: from where. */
  let glide: { from: THREE.Vector3; fromTarget: THREE.Vector3; start: number } | null = null;
  const GLIDE_SECONDS = 1.8;
  const autoPosition = new THREE.Vector3();
  const autoTarget = lookAt.clone();

  /*
   * The idle shot tour (2026-10-03: "when idle, rotate the scene around
   * slowly between a few cinematic points in the front of the scene, should
   * be distinct scenes"). Each shot is held with a slow push-in, then the
   * camera eases to the next — always from the front half.
   */
  type Shot = { azimuth: number; elevation: number; distance: number; target: THREE.Vector3 };
  const SHOTS: Shot[] = [
    // the whole still life, eye level
    { azimuth: BASE_AZIMUTH, elevation: BASE_ELEVATION, distance: DISTANCE, target: lookAt.clone() },
    // popcorn close-up, from the right, a touch above the rim
    { azimuth: 0.62, elevation: 0.24, distance: 3.4, target: bucketPosition.clone().add(new THREE.Vector3(0, 0.95, 0.05)) },
    // the reel from low on the left, looking up at the spokes
    { azimuth: -0.32, elevation: 0.04, distance: 3.9, target: reel.group.position.clone().add(new THREE.Vector3(0.15, -0.1, 0.3)) },
    // looking down along the film strip as it runs across the floor
    { azimuth: 0.12, elevation: 0.46, distance: 4.7, target: new THREE.Vector3(-0.15, 0.3, 0.8) },
    // low and wide from the right, past the tickets
    { azimuth: 0.85, elevation: 0.08, distance: 5.0, target: new THREE.Vector3(0.25, 0.55, 0.55) },
  ];
  const HOLD_SECONDS = 8;
  const MOVE_SECONDS = 6.5;
  const tourScratch = { azimuth: 0, elevation: 0, distance: 0, target: new THREE.Vector3() };
  const tourAt = (t: number): Shot => {
    const leg = HOLD_SECONDS + MOVE_SECONDS;
    const local = Math.max(0, t - STILL_AT); // the page opens on the wide shot, held
    const index = Math.floor(local / leg);
    const into = local - index * leg;
    const from = SHOTS[index % SHOTS.length];
    const to = SHOTS[(index + 1) % SHOTS.length];
    // Holding: a slow push-in (and a whisper of drift) on the current shot.
    const hold = Math.min(1, into / HOLD_SECONDS);
    const push = (s: Shot, k: number) => s.distance * (1 - 0.06 * k);
    if (into < HOLD_SECONDS) {
      tourScratch.azimuth = from.azimuth + 0.02 * Math.sin(hold * Math.PI);
      tourScratch.elevation = from.elevation;
      tourScratch.distance = push(from, hold);
      tourScratch.target.copy(from.target);
      return tourScratch;
    }
    // Moving: ease to the next shot.
    const k = smoother((into - HOLD_SECONDS) / MOVE_SECONDS);
    tourScratch.azimuth = THREE.MathUtils.lerp(from.azimuth, to.azimuth, k);
    tourScratch.elevation = THREE.MathUtils.lerp(from.elevation, to.elevation, k);
    tourScratch.distance = THREE.MathUtils.lerp(push(from, 1), to.distance, k);
    tourScratch.target.lerpVectors(from.target, to.target, k);
    return tourScratch;
  };

  const placeCamera = (t: number, still: boolean) => {
    if (handHeld || t < handUntil) {
      controls.update();
      return;
    }
    if (handUntil > -Infinity) {
      // The hand let go a while ago: glide home from wherever it left us.
      glide = { from: camera.position.clone(), fromTarget: controls.target.clone(), start: t };
      handUntil = -Infinity;
      if (options.reducedMotion) {
        glide = null;
        stop();
      }
    }
    // Idle: the shot tour (distinct framings in front of the scene).
    const shot = tourAt(t);
    let { azimuth, elevation, distance } = shot;
    const u = still ? null : flightAt(t);
    if (u !== null) {
      const eased = smoother(u);
      const arc = Math.sin(Math.PI * u);
      azimuth += Math.PI * 2 * eased;
      elevation += 0.2 * arc; // rise a little over the top of the props
      // Swing wide so nothing clips, even when the tour was in close.
      distance = THREE.MathUtils.lerp(distance, Math.max(distance, 5.6) * 1.12, arc);
    }
    autoTarget.copy(shot.target);
    autoPosition.set(
      autoTarget.x + Math.sin(azimuth) * Math.cos(elevation) * distance,
      autoTarget.y + Math.sin(elevation) * distance,
      autoTarget.z + Math.cos(azimuth) * Math.cos(elevation) * distance,
    );
    if (glide) {
      const k = smoother(Math.min(1, (t - glide.start) / GLIDE_SECONDS));
      camera.position.lerpVectors(glide.from, autoPosition, k);
      camera.lookAt(new THREE.Vector3().lerpVectors(glide.fromTarget, autoTarget, k));
      if (k >= 1) glide = null;
      return;
    }
    camera.position.copy(autoPosition);
    camera.lookAt(autoTarget);
  };

  // DEV-only flicker probe: right after a frame is drawn, read a row of the
  // final image; count frames that came out empty. (window.__cinemaProbe)
  // (readPixels stalls the GPU: only with ?sceneProbe in the URL.)
  const probing = import.meta.env.DEV && new URLSearchParams(location.search).has('sceneProbe');
  const probeState = { frames: 0, empty: 0, emptyAt: [] as number[] };
  const probeRow = new Uint8Array(4 * 64);
  const probe = () => {
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    if (!w || !h) return;
    const gl = renderer.getContext();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(Math.floor(w / 2) - 32, Math.floor(h * 0.55), 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, probeRow);
    let peak = 0;
    for (let i = 0; i < probeRow.length; i += 4) peak = Math.max(peak, probeRow[i], probeRow[i + 1], probeRow[i + 2]);
    probeState.frames += 1;
    if (peak < 4) {
      probeState.empty += 1;
      if (probeState.emptyAt.length < 50) probeState.emptyAt.push(Number(clock.toFixed(2)));
    }
    (window as unknown as { __cinemaProbe?: typeof probeState }).__cinemaProbe = probeState;
  };

  // ── animation ──
  let clock = 0;
  const pose = (t: number) => {
    time.value = t;
    seam.uniforms.uTime.value = t;
    reel.spinner.rotation.z = SPIN * t;
    strip.advance(-SPIN * REEL.pack * t);
    strip.update(t);
    popcorn.animate(t);
    placeCamera(t, t === STILL_AT && options.reducedMotion);
  };

  let width = 0;
  let height = 0;
  let previous = 0;
  let running = false;
  // At most ~60 fps: on 120/240 Hz screens the extra frames buy nothing
  // for a slow backdrop and cost battery.
  const MIN_FRAME_MS = 1000 / 62;
  const frame = (now: number) => {
    if (previous && now - previous < MIN_FRAME_MS) return;
    const dt = previous ? Math.min(0.05, (now - previous) / 1000) : 0;
    previous = now;
    clock += dt;
    // Reduced motion: the props hold still even while the visitor steers.
    pose(options.reducedMotion ? STILL_AT : clock + STILL_AT);
    if (options.reducedMotion && !handHeld && clock + STILL_AT >= handUntil) {
      stop();
      renderStill();
    }
    if (import.meta.env.DEV) (canvas as HTMLCanvasElement & { __cinemaClock?: number }).__cinemaClock = clock;
    // Shadows every frame: refreshing them every third frame made the
    // spinning reel's shadow step (a visible flicker).
    renderer.shadowMap.needsUpdate = true;
    renderer.info.reset();
    composer.render(dt);
    if (probing) probe();
    adapt(dt);
  };
  // A safety net for weak GPUs: if the backdrop cannot hold ~45 fps over
  // two seconds, render it at a lower pixel ratio (down to 1).
  let slowWindow = 0;
  let lastAdapt = -Infinity;
  let slowFrames = 0;
  const adapt = (dt: number) => {
    if (clock < 1.5 || pixelRatio <= 1) return;
    slowWindow += dt;
    slowFrames += 1;
    if (slowWindow < 2) return;
    const average = slowWindow / slowFrames;
    slowWindow = 0;
    slowFrames = 0;
    if (average > 1 / 45 && clock - lastAdapt > 8) {
      lastAdapt = clock;
      pixelRatio = Math.max(1, pixelRatio - 0.25);
      applySize();
      renderNow();
    }
  };
  const renderStill = () => {
    if (width === 0 || height === 0) return;
    pose(STILL_AT);
    renderer.info.reset();
    composer.render(0);
  };

  const applySize = () => {
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    dustMaterial.uniforms.uPixelRatio.value = pixelRatio;
  };
  /** Draw the current moment right now. A canvas resize CLEARS it; waiting
   *  for the next animation frame showed one dark frame (a visible blink). */
  const renderNow = () => {
    if (width === 0 || height === 0) return;
    pose(options.reducedMotion ? STILL_AT : clock + STILL_AT);
    renderer.info.reset();
    composer.render(0);
  };
  const resize = (w: number, h: number) => {
    if (w <= 0 || h <= 0) return;
    // Sub-pixel layout jitter is not a resize (each one would clear the canvas).
    if (Math.abs(w - width) < 1 && Math.abs(h - height) < 1) return;
    width = w;
    height = h;
    const aspect = w / h;
    camera.aspect = aspect;
    // Keep the whole group in frame at any shape: it needs a half-extent
    // of FRAME (as a tangent) both across and up.
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.max(FRAME, FRAME / aspect)));
    camera.updateProjectionMatrix();
    applySize();
    if (options.reducedMotion || !running) renderStill();
    else renderNow();
  };

  const start = () => {
    if ((options.reducedMotion && !handHeld) || running) return;
    running = true;
    previous = 0;
    renderer.setAnimationLoop(frame);
  };
  const stop = () => {
    running = false;
    renderer.setAnimationLoop(null);
  };
  start();

  return {
    resize,
    setPointer() {
      // No cursor tracking any more (the camera moves on its own).
    },
    pause: stop,
    resume: start,
    dispose() {
      stop();
      controls.removeEventListener('start', onHandStart);
      controls.removeEventListener('end', onHandEnd);
      canvas.removeEventListener('wheel', wheelGate, { capture: true });
      controls.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      scene.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) geometries.add(mesh.geometry);
        if (mesh.material) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m);
        if ((child as THREE.InstancedMesh).isInstancedMesh) (child as THREE.InstancedMesh).dispose();
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
      environment.dispose();
      key.shadow.map?.dispose();
      bloom.dispose();
      smaa.dispose();
      seam.dispose();
      composer.dispose();
      target.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

