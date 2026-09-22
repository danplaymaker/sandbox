/**
 * Generates a procedural equirectangular HDRI (Radiance .hdr, RGBE + RLE) so the
 * project has a real HDR environment map without depending on external downloads.
 *
 * The sun direction written here MUST match `defaultConfig.sun` in src/config.js
 * (azimuth / elevation in degrees) so the shadow-casting directional light lines up
 * with the brightest spot of the environment map.
 *
 * Swap the output for any CC0 HDRI (e.g. polyhaven.com) by pointing
 * `options.assets.hdri` at it — see README.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/hdri/meadow-sky.hdr');

const W = 1024;
const H = 512;

// Sun placement (degrees). Elevation above horizon, azimuth around +Y measured from +X toward +Z.
export const SUN_AZIMUTH = 215;
export const SUN_ELEVATION = 28;

const toRad = (d) => (d * Math.PI) / 180;
const sunDir = [
  Math.cos(toRad(SUN_ELEVATION)) * Math.cos(toRad(SUN_AZIMUTH)),
  Math.sin(toRad(SUN_ELEVATION)),
  Math.cos(toRad(SUN_ELEVATION)) * Math.sin(toRad(SUN_AZIMUTH)),
];

// --- tiny value-noise for soft cloud variation ---------------------------------
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) {
  let f = 0, amp = 0.5, fr = 1;
  for (let i = 0; i < 5; i++) { f += amp * vnoise(x * fr, y * fr); amp *= 0.5; fr *= 2.1; }
  return f;
}
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// --- radiance model --------------------------------------------------------------
function radiance(dir) {
  const [x, y, z] = dir;
  const out = [0, 0, 0];
  const cosSun = x * sunDir[0] + y * sunDir[1] + z * sunDir[2];

  if (y >= 0) {
    // Sky: deep blue zenith -> warm hazy horizon.
    const t = Math.pow(1 - y, 2.2);
    const zenith = [0.18, 0.36, 0.85];
    const horizon = [0.95, 0.85, 0.78];
    for (let i = 0; i < 3; i++) out[i] = mix(zenith[i], horizon[i], t) * 1.6;

    // Soft cumulus variation (subtle, keeps lighting natural).
    const az = Math.atan2(z, x);
    const c = fbm(az * 2.5 + 10, y * 6 + 3);
    const cloud = smooth(0.52, 0.72, c) * (1 - y) * 0.6;
    for (let i = 0; i < 3; i++) out[i] = mix(out[i], 2.4, cloud * 0.55);

    // Sun glow + disc.
    const glow = Math.pow(clamp01(cosSun), 32) * 6 + Math.pow(clamp01(cosSun), 4) * 0.9;
    out[0] += glow * 1.0; out[1] += glow * 0.85; out[2] += glow * 0.6;
    const discCos = Math.cos(toRad(0.9));
    if (cosSun > discCos) {
      const edge = smooth(discCos, Math.cos(toRad(0.35)), cosSun);
      out[0] += 60 * edge; out[1] += 54 * edge; out[2] += 42 * edge;
    }
  } else {
    // Ground: neutral-ish meadow bounce so blades pick up green/brown from below.
    const t = Math.pow(-y, 0.6);
    const near = [0.62, 0.58, 0.44];
    const deep = [0.22, 0.24, 0.12];
    for (let i = 0; i < 3; i++) out[i] = mix(near[i], deep[i], t) * 0.9;
    // A touch of sun-side brightening on the ground.
    const sunSide = clamp01(x * sunDir[0] + z * sunDir[2]) * 0.25;
    for (let i = 0; i < 3; i++) out[i] *= 1 + sunSide;
  }
  return out;
}

// --- RGBE encode --------------------------------------------------------------------
function floatToRGBE(r, g, b, out, o) {
  const v = Math.max(r, g, b);
  if (v < 1e-32) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
  const e = Math.ceil(Math.log2(v));
  const scale = Math.pow(2, -e) * 256;
  out[o] = Math.min(255, Math.floor(r * scale));
  out[o + 1] = Math.min(255, Math.floor(g * scale));
  out[o + 2] = Math.min(255, Math.floor(b * scale));
  out[o + 3] = e + 128;
}

/** Radiance "new" RLE: per scanline, header 2,2,hi,lo then each of 4 planes run-length coded. */
function encodeScanlineRLE(rgbe, width, chunks) {
  chunks.push(Uint8Array.from([2, 2, (width >> 8) & 0xff, width & 0xff]));
  for (let ch = 0; ch < 4; ch++) {
    let i = 0;
    const buf = [];
    while (i < width) {
      // find run
      let run = 1;
      while (i + run < width && run < 127 && rgbe[(i + run) * 4 + ch] === rgbe[i * 4 + ch]) run++;
      if (run >= 4) {
        buf.push(128 + run, rgbe[i * 4 + ch]);
        i += run;
      } else {
        // literal: collect until a run of >=4 starts or 128 reached
        let start = i;
        let n = 0;
        while (i < width && n < 128) {
          let r = 1;
          while (i + r < width && r < 4 && rgbe[(i + r) * 4 + ch] === rgbe[i * 4 + ch]) r++;
          if (r >= 4) break;
          i++; n++;
        }
        buf.push(n);
        for (let k = start; k < start + n; k++) buf.push(rgbe[k * 4 + ch]);
      }
    }
    chunks.push(Uint8Array.from(buf));
  }
}

const header = `#?RADIANCE\n# Procedural meadow sky generated by scripts/gen-hdri.mjs\nFORMAT=32-bit_rle_rgbe\n\n-Y ${H} +X ${W}\n`;
const chunks = [new TextEncoder().encode(header)];
const line = new Uint8Array(W * 4);

for (let j = 0; j < H; j++) {
  // Row 0 is the top of the image (+Y = up). v = 1 - (j+0.5)/H maps to elevation.
  const v = 1 - (j + 0.5) / H;
  const phi = (v - 0.5) * Math.PI;          // elevation
  for (let i = 0; i < W; i++) {
    const u = (i + 0.5) / W;
    const theta = (u - 0.5) * Math.PI * 2;  // three.js equirectUv: u = atan(z, x)/2π + 0.5
    const dir = [Math.cos(phi) * Math.cos(theta), Math.sin(phi), Math.cos(phi) * Math.sin(theta)];
    const [r, g, b] = radiance(dir);
    floatToRGBE(r, g, b, line, i * 4);
  }
  encodeScanlineRLE(line, W, chunks);
}

const total = chunks.reduce((n, c) => n + c.length, 0);
const file = new Uint8Array(total);
let off = 0;
for (const c of chunks) { file.set(c, off); off += c.length; }
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, file);
console.log(`wrote ${OUT} (${(total / 1024).toFixed(0)} KB, ${W}x${H}, sun az=${SUN_AZIMUTH} el=${SUN_ELEVATION})`);
