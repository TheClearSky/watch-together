/**
 * Canvas-painted textures for the cinema scene. Nothing is loaded from a
 * file: every texture is drawn here, from a seeded random sequence, so the
 * scene looks the same on every visit.
 */

import * as THREE from 'three';

/** A small deterministic PRNG (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(width: number, height: number) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  const context = element.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');
  return { element, context };
}

function colorTexture(element: HTMLCanvasElement, anisotropy: number): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

function dataTexture(element: HTMLCanvasElement, anisotropy: number): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(element);
  texture.anisotropy = anisotropy;
  return texture;
}

/** Per-pixel grain over the whole canvas (±amount, grey). */
function grain(context: CanvasRenderingContext2D, width: number, height: number, amount: number, random: () => number) {
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (random() - 0.5) * 2 * amount;
    data[i] = Math.max(0, Math.min(255, data[i] + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
  }
  context.putImageData(image, 0, 0);
}

// ── brushed aluminium (reel flanges) ────────────────────────────────────

/**
 * A disc of spun aluminium seen face-on: UV (0.5, 0.5) is the centre.
 *  - map: warm silver, faint fingerprints and darker handling wear, a few
 *    fine scratches;
 *  - roughnessMap: concentric lathe rings (each radius its own roughness);
 *  - anisotropyMap: the brushing direction, tangent to the circles, so the
 *    highlight fans out radially like on a real spun disc.
 */
export function brushedDiscTextures(anisotropy: number) {
  const size = 1024;
  const half = size / 2;
  const random = seeded(71);

  const color = canvas(size, size);
  const c = color.context;
  const base = c.createRadialGradient(half, half, 0, half, half, half);
  base.addColorStop(0, '#c9c6c1');
  base.addColorStop(0.7, '#bdb8b0');
  base.addColorStop(1, '#a8a299');
  c.fillStyle = base;
  c.fillRect(0, 0, size, size);
  // Concentric tone variation (the lathe).
  for (let r = 4; r < half; r += 1 + random() * 3) {
    const shade = random() < 0.5 ? 255 : 0;
    c.strokeStyle = `rgba(${shade},${shade},${shade},${0.015 + random() * 0.04})`;
    c.lineWidth = 1 + random() * 1.5;
    c.beginPath();
    c.arc(half, half, r, 0, Math.PI * 2);
    c.stroke();
  }
  // Handling wear: soft dark blotches near the rim, where hands hold a reel.
  for (let i = 0; i < 26; i++) {
    const angle = random() * Math.PI * 2;
    const r = half * (0.55 + random() * 0.42);
    const x = half + Math.cos(angle) * r;
    const y = half + Math.sin(angle) * r;
    const radius = 20 + random() * 70;
    const blotch = c.createRadialGradient(x, y, 0, x, y, radius);
    blotch.addColorStop(0, `rgba(60,48,36,${0.05 + random() * 0.08})`);
    blotch.addColorStop(1, 'rgba(60,48,36,0)');
    c.fillStyle = blotch;
    c.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  // Fine scratches: short, mostly following the circles.
  for (let i = 0; i < 160; i++) {
    const angle = random() * Math.PI * 2;
    const r = half * (0.25 + random() * 0.72);
    const span = (0.02 + random() * 0.12) * (random() < 0.15 ? 3 : 1);
    c.strokeStyle = random() < 0.6 ? `rgba(255,250,240,${0.12 + random() * 0.2})` : `rgba(40,32,26,${0.08 + random() * 0.12})`;
    c.lineWidth = 0.6 + random() * 0.8;
    c.beginPath();
    const wobble = (random() - 0.5) * 0.08;
    c.arc(half, half, r, angle, angle + span);
    if (random() < 0.25) c.lineTo(half + Math.cos(angle + span + wobble) * r * 0.96, half + Math.sin(angle + span + wobble) * r * 0.96);
    c.stroke();
  }
  grain(c, size, size, 6, random);

  const rough = canvas(size, size);
  const r2 = rough.context;
  r2.fillStyle = 'rgb(82,82,82)';
  r2.fillRect(0, 0, size, size);
  for (let r = 2; r < half; r += 1 + random() * 2.5) {
    const g = 60 + random() * 60;
    r2.strokeStyle = `rgba(${g | 0},${g | 0},${g | 0},0.55)`;
    r2.lineWidth = 1 + random() * 2;
    r2.beginPath();
    r2.arc(half, half, r, 0, Math.PI * 2);
    r2.stroke();
  }
  // Wear is a little rougher.
  for (let i = 0; i < 18; i++) {
    const angle = random() * Math.PI * 2;
    const r = half * (0.6 + random() * 0.38);
    const x = half + Math.cos(angle) * r;
    const y = half + Math.sin(angle) * r;
    const radius = 30 + random() * 60;
    const blotch = r2.createRadialGradient(x, y, 0, x, y, radius);
    blotch.addColorStop(0, 'rgba(170,170,170,0.35)');
    blotch.addColorStop(1, 'rgba(170,170,170,0)');
    r2.fillStyle = blotch;
    r2.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  // Brushing direction, tangent to the circles: (−v, u) in UV space.
  // Canvas y runs down while v runs up (flipY), so −v = (py − c).
  const aniso = canvas(size, size);
  const image = aniso.context.createImageData(size, size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = px + 0.5 - half;
      const dy = py + 0.5 - half;
      const length = Math.hypot(dx, dy) || 1;
      const i = (py * size + px) * 4;
      image.data[i] = ((dy / length) * 0.5 + 0.5) * 255;
      image.data[i + 1] = ((dx / length) * 0.5 + 0.5) * 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = 255;
    }
  }
  aniso.context.putImageData(image, 0, 0);

  return {
    map: colorTexture(color.element, anisotropy),
    roughnessMap: dataTexture(rough.element, anisotropy),
    anisotropyMap: dataTexture(aniso.element, anisotropy),
  };
}

// ── wound film (the face of the film pack on the reel) ──────────────────

/** Concentric windings of film, dark amber to near black, UV centre (0.5, 0.5). */
export function windingTextures(anisotropy: number, innerFraction: number) {
  const size = 512;
  const half = size / 2;
  const random = seeded(23);
  const color = canvas(size, size);
  const c = color.context;
  c.fillStyle = '#1a0f09';
  c.fillRect(0, 0, size, size);
  for (let r = innerFraction * half; r < half; r += 0.7 + random() * 1.6) {
    const t = random();
    const tone = t < 0.15 ? [96, 58, 26] : t < 0.55 ? [52, 31, 16] : [28, 17, 10];
    c.strokeStyle = `rgba(${tone[0]},${tone[1]},${tone[2]},${0.55 + random() * 0.45})`;
    c.lineWidth = 0.8 + random() * 1.4;
    c.beginPath();
    c.arc(half, half, r, 0, Math.PI * 2);
    c.stroke();
  }
  // A couple of lighter leader bands (spliced sections).
  for (const fraction of [0.58, 0.83]) {
    c.strokeStyle = 'rgba(150,104,52,0.5)';
    c.lineWidth = 3;
    c.beginPath();
    c.arc(half, half, fraction * half, 0, Math.PI * 2);
    c.stroke();
  }
  const rough = canvas(size, size);
  const r2 = rough.context;
  r2.fillStyle = 'rgb(70,70,70)';
  r2.fillRect(0, 0, size, size);
  for (let r = innerFraction * half; r < half; r += 1 + random() * 3) {
    const g = 40 + random() * 70;
    r2.strokeStyle = `rgb(${g | 0},${g | 0},${g | 0})`;
    r2.lineWidth = 1;
    r2.beginPath();
    r2.arc(half, half, r, 0, Math.PI * 2);
    r2.stroke();
  }
  return { map: colorTexture(color.element, anisotropy), roughnessMap: dataTexture(rough.element, anisotropy) };
}

// ── the film strip ──────────────────────────────────────────────────────

/** Strip texture layout: u runs ALONG the film, v ACROSS it. */
export const FILM = {
  /** Canvas length in px (12 frames). */
  length: 1920,
  across: 256,
  framePitch: 160,
  /** Length of one texture repeat in units of the film's width. */
  get repeatInWidths() {
    return this.length / this.across;
  },
};

/** One frame of a short sequence: a sun setting over the sea behind two figures. */
function paintFrame(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, index: number, random: () => number) {
  c.save();
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  const sky = c.createLinearGradient(0, y, 0, y + h);
  sky.addColorStop(0, '#2a0d06');
  sky.addColorStop(0.45, '#a8471a');
  sky.addColorStop(0.62, '#f2b25c');
  sky.addColorStop(0.64, '#5a2410');
  sky.addColorStop(1, '#1a0805');
  c.fillStyle = sky;
  c.fillRect(x, y, w, h);
  // The sun sinks a little each frame.
  const horizon = y + h * 0.63;
  const sunY = horizon - h * 0.22 + (index / 11) * h * 0.24;
  const sunX = x + w * 0.62;
  const glow = c.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.5);
  glow.addColorStop(0, 'rgba(255,236,190,0.95)');
  glow.addColorStop(0.18, 'rgba(255,200,120,0.75)');
  glow.addColorStop(1, 'rgba(255,140,60,0)');
  c.fillStyle = glow;
  c.fillRect(x, y, w, horizon - y);
  c.fillStyle = '#fff1cf';
  c.beginPath();
  c.arc(sunX, sunY, h * 0.09, 0, Math.PI * 2);
  c.fill();
  // Sea with a glitter path under the sun.
  c.fillStyle = '#2b0f07';
  c.fillRect(x, horizon, w, h);
  for (let i = 0; i < 26; i++) {
    const yy = horizon + 2 + random() * (h * 0.33);
    const spread = 4 + (yy - horizon) * 0.5;
    c.fillStyle = `rgba(255,196,120,${0.25 + random() * 0.5})`;
    c.fillRect(sunX - spread * random(), yy, 2 + random() * spread, 1.2);
  }
  // Two figures on a headland, left.
  c.fillStyle = '#120503';
  c.beginPath();
  c.moveTo(x, horizon + h * 0.02);
  c.quadraticCurveTo(x + w * 0.22, horizon - h * 0.08, x + w * 0.42, horizon + h * 0.12);
  c.lineTo(x + w * 0.42, y + h);
  c.lineTo(x, y + h);
  c.fill();
  const figure = (fx: number, scale: number) => {
    const top = horizon - h * 0.2 * scale;
    c.beginPath();
    c.arc(fx, top, h * 0.032 * scale, 0, Math.PI * 2);
    c.fill();
    c.fillRect(fx - h * 0.028 * scale, top + h * 0.03 * scale, h * 0.056 * scale, h * 0.16 * scale);
  };
  figure(x + w * 0.2, 1);
  figure(x + w * 0.27, 0.9);
  c.restore();
}

/**
 * map: film base, frame lines and the (darker) pictures;
 * emissiveMap: the pictures alone, so the frames glow as if lit from behind;
 * alphaMap: white with black sprocket holes (alphaTest cuts them out).
 */
export function filmStripTextures(anisotropy: number) {
  const { length, across, framePitch } = FILM;
  const random = seeded(5);
  const color = canvas(length, across);
  const glow = canvas(length, across);
  const alpha = canvas(length, across);
  const c = color.context;
  const g = glow.context;
  const a = alpha.context;

  c.fillStyle = '#20140e';
  c.fillRect(0, 0, length, across);
  g.fillStyle = '#000';
  g.fillRect(0, 0, length, across);
  a.fillStyle = '#fff';
  a.fillRect(0, 0, length, across);

  // Perforations: 4 per frame, both edges, rounded rectangles.
  const perfPitch = framePitch / 4;
  const perfLong = perfPitch * 0.52;
  const perfAcross = 24;
  const perfInset = 12;
  const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  };
  for (let i = 0; i < length / perfPitch; i++) {
    const x = i * perfPitch + (perfPitch - perfLong) / 2;
    for (const y of [perfInset, across - perfInset - perfAcross]) {
      a.fillStyle = '#000';
      roundRect(a, x, y, perfLong, perfAcross, 5);
      // A thin bright lip around each hole on the colour map.
      c.fillStyle = 'rgba(120,84,52,0.55)';
      roundRect(c, x - 1.5, y - 1.5, perfLong + 3, perfAcross + 3, 6);
    }
  }

  // Frames.
  const imageTop = perfInset * 2 + perfAcross + 4;
  const imageHeight = across - imageTop * 2;
  const imageLength = framePitch - 22;
  for (let f = 0; f < length / framePitch; f++) {
    const x = f * framePitch + 11;
    c.fillStyle = '#080403';
    c.fillRect(x - 3, imageTop - 3, imageLength + 6, imageHeight + 6);
    paintFrame(g, x, imageTop, imageLength, imageHeight, f, random);
    // The picture on the base is the same image, much darker.
    c.save();
    c.globalAlpha = 0.55;
    c.drawImage(glow.element, x, imageTop, imageLength, imageHeight, x, imageTop, imageLength, imageHeight);
    c.restore();
    // Edge print: frame numbers in the margin.
    c.fillStyle = 'rgba(214,160,92,0.75)';
    c.font = '600 11px Georgia, serif';
    c.fillText(`${(f + 17) % 100}`.padStart(2, '0') + ' ▸', x + 8, across - 3);
    c.fillText('SAFETY  FILM', x + 64, 10);
  }
  // Scratches and dust along the run (a projected print, not a new one).
  for (let i = 0; i < 70; i++) {
    const x = random() * length;
    c.strokeStyle = `rgba(230,190,140,${0.05 + random() * 0.12})`;
    c.lineWidth = 0.7;
    c.beginPath();
    c.moveTo(x, imageTop + random() * imageHeight * 0.4);
    c.lineTo(x + (random() - 0.5) * 30, imageTop + imageHeight * (0.6 + random() * 0.4));
    c.stroke();
  }
  // Pictures glow, the dark frame lines and perforation zones do not.
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = '#fff';
  g.fillRect(0, imageTop, length, imageHeight);
  grain(c, length, across, 5, random);

  const map = colorTexture(color.element, anisotropy);
  const emissiveMap = colorTexture(glow.element, anisotropy);
  const alphaMap = dataTexture(alpha.element, anisotropy);
  for (const texture of [map, emissiveMap, alphaMap]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  return { map, emissiveMap, alphaMap };
}

// ── popcorn bucket (striped paper) ──────────────────────────────────────

/** u wraps around the bucket, v runs up it. */
export function bucketTextures(anisotropy: number) {
  const width = 2048;
  const height = 1024;
  const random = seeded(9);
  const color = canvas(width, height);
  const c = color.context;
  const stripes = 14;
  const stripe = width / stripes;
  for (let i = 0; i < stripes; i++) {
    c.fillStyle = i % 2 === 0 ? '#a8121f' : '#f1e6d2';
    c.fillRect(i * stripe, 0, stripe + 1, height);
  }
  // Ink misregistration: the red bleeds a hair into the ivory.
  for (let i = 0; i < stripes; i += 2) {
    for (const edge of [i * stripe, (i + 1) * stripe]) {
      const bleed = c.createLinearGradient(edge - 4, 0, edge + 4, 0);
      bleed.addColorStop(0, 'rgba(168,18,31,0)');
      bleed.addColorStop(0.5, 'rgba(168,18,31,0.35)');
      bleed.addColorStop(1, 'rgba(168,18,31,0)');
      c.fillStyle = bleed;
      c.fillRect(edge - 4, 0, 8, height);
    }
  }
  // The band: velvet red with gold pinstripes and "POPCORN" in gold.
  const bandTop = height * 0.38;
  const bandHeight = height * 0.2;
  c.fillStyle = '#3a0508';
  c.fillRect(0, bandTop, width, bandHeight);
  c.fillStyle = '#e1c48c';
  for (const y of [bandTop + 10, bandTop + bandHeight - 16]) c.fillRect(0, y, width, 6);
  c.font = `italic 600 ${Math.round(bandHeight * 0.48)}px Georgia, 'Times New Roman', serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (let k = 0; k < 3; k++) {
    const x = (k + 0.5) * (width / 3);
    c.fillStyle = '#e9d3a8';
    c.fillText('Popcorn', x, bandTop + bandHeight / 2 + 4);
    // Little stars between the words.
    c.font = `${Math.round(bandHeight * 0.26)}px Georgia, serif`;
    c.fillText('✦', x + width / 6, bandTop + bandHeight / 2 + 2);
    c.font = `italic 600 ${Math.round(bandHeight * 0.48)}px Georgia, 'Times New Roman', serif`;
  }
  // Gold lines near the top and bottom edges.
  c.fillStyle = '#d9b979';
  c.fillRect(0, height * 0.035, width, 8);
  c.fillRect(0, height * 0.94, width, 8);
  // Grease spots from buttery popcorn near the top: slightly darker, warmer.
  for (let i = 0; i < 14; i++) {
    const x = random() * width;
    const y = height * (0.02 + random() * 0.3);
    const r = 12 + random() * 40;
    const spot = c.createRadialGradient(x, y, 0, x, y, r);
    spot.addColorStop(0, 'rgba(150,100,20,0.14)');
    spot.addColorStop(1, 'rgba(150,100,20,0)');
    c.fillStyle = spot;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }
  grain(c, width, height, 7, random);

  // Roughness + metalness: paper is matte; the gold ink is a metallic foil.
  const rough = canvas(width, height);
  const metal = canvas(width, height);
  const r2 = rough.context;
  const m2 = metal.context;
  r2.fillStyle = 'rgb(165,165,165)';
  r2.fillRect(0, 0, width, height);
  m2.fillStyle = '#000';
  m2.fillRect(0, 0, width, height);
  const foil = (ctx: CanvasRenderingContext2D, fill: string) => {
    ctx.fillStyle = fill;
    for (const y of [bandTop + 10, bandTop + bandHeight - 16]) ctx.fillRect(0, y, width, 6);
    ctx.fillRect(0, height * 0.035, width, 8);
    ctx.fillRect(0, height * 0.94, width, 8);
    ctx.font = `italic 600 ${Math.round(bandHeight * 0.48)}px Georgia, 'Times New Roman', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < 3; k++) ctx.fillText('Popcorn', (k + 0.5) * (width / 3), bandTop + bandHeight / 2 + 4);
  };
  foil(r2, 'rgb(80,80,80)');
  foil(m2, '#fff');
  grain(r2, width, height, 22, random);

  const map = colorTexture(color.element, anisotropy);
  const roughnessMap = dataTexture(rough.element, anisotropy);
  const metalnessMap = dataTexture(metal.element, anisotropy);
  for (const texture of [map, roughnessMap, metalnessMap]) texture.wrapS = THREE.RepeatWrapping;
  return { map, roughnessMap, metalnessMap };
}

// ── ticket stubs ────────────────────────────────────────────────────────

export function ticketTexture(anisotropy: number, variant: 'red' | 'ivory', serial: number): THREE.CanvasTexture {
  const width = 512;
  const height = 224;
  const random = seeded(serial);
  const { element, context: c } = canvas(width, height);
  const paper = variant === 'red' ? '#9e1420' : '#efe2c6';
  const ink = variant === 'red' ? '#efd9a6' : '#9e1420';
  c.fillStyle = paper;
  c.fillRect(0, 0, width, height);
  c.strokeStyle = ink;
  c.lineWidth = 3;
  c.strokeRect(14, 14, width - 28, height - 28);
  c.lineWidth = 1;
  c.strokeRect(22, 22, width - 44, height - 44);
  // Stub perforation.
  c.fillStyle = variant === 'red' ? 'rgba(40,4,6,0.6)' : 'rgba(80,60,40,0.4)';
  for (let y = 18; y < height - 14; y += 12) {
    c.beginPath();
    c.arc(width * 0.74, y, 2.2, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = ink;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = '700 54px Georgia, serif';
  c.fillText('ADMIT', width * 0.37, height * 0.38);
  c.fillText('ONE', width * 0.37, height * 0.66);
  c.font = '600 18px Georgia, serif';
  c.save();
  c.translate(width * 0.87, height / 2);
  c.rotate(-Math.PI / 2);
  c.fillText(`Nº ${String(serial * 7919).slice(0, 6)}`, 0, 0);
  c.restore();
  c.font = '14px Georgia, serif';
  c.fillText('★  ★  ★', width * 0.37, height * 0.86);
  grain(c, width, height, 9, random);
  return colorTexture(element, anisotropy);
}

// ── floor ───────────────────────────────────────────────────────────────

/** Large soft roughness variation so the glossy floor's highlight breaks up. */
export function floorRoughness(anisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const random = seeded(41);
  const { element, context: c } = canvas(size, size);
  c.fillStyle = 'rgb(110,110,110)';
  c.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const x = random() * size;
    const y = random() * size;
    const r = 30 + random() * 110;
    const g = random() < 0.5 ? 70 : 170;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      const blob = c.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      blob.addColorStop(0, `rgba(${g},${g},${g},0.22)`);
      blob.addColorStop(1, `rgba(${g},${g},${g},0)`);
      c.fillStyle = blob;
      c.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  grain(c, size, size, 10, random);
  const texture = dataTexture(element, anisotropy);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * White in the middle, black from `outer` outwards (fractions of the
 * texture's half-size), with a long smooth falloff: multiplies the floor's
 * colour, clearcoat and specular so the stage dissolves into the dark
 * instead of ending at the spotlight's rim.
 */
export function radialFade(inner: number, outer: number): THREE.CanvasTexture {
  const size = 512;
  const { element, context: c } = canvas(size, size);
  c.fillStyle = '#000';
  c.fillRect(0, 0, size, size);
  const gradient = c.createRadialGradient(size / 2, size / 2, inner * (size / 2), size / 2, size / 2, outer * (size / 2));
  for (let k = 0; k <= 8; k++) {
    const x = k / 8;
    const v = Math.round(255 * Math.pow(1 - x * x * (3 - 2 * x), 1.4));
    gradient.addColorStop(x, `rgb(${v},${v},${v})`);
  }
  c.fillStyle = gradient;
  c.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(element);
}
