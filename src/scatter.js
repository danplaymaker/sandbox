import { Matrix4, Quaternion, Vector3 } from 'three';

/** Deterministic PRNG (mulberry32) so a given seed always produces the same field. */
export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- small value-noise used for the density field (CPU side, only at load) --------
function hash2(x, y, seed) {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 0.37) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, seed, octaves = 4) {
  let f = 0, amp = 0.5, fr = 1;
  for (let i = 0; i < octaves; i++) { f += amp * vnoise(x * fr, y * fr, seed); amp *= 0.5; fr *= 2.03; }
  return f;
}

/**
 * Scatter `count` blades over the field using rejection sampling against a
 * noise density function (clumps + bare patches) and an optional silhouette mask.
 * Returns instance matrices + per-instance data baked into typed arrays.
 */
export function scatterBlades({
  count, fieldSize, bladeHeight, clustering, seed, mask = null,
}) {
  const rng = createRng(seed);
  const [w, d] = fieldSize;
  const matrices = new Float32Array(count * 16);
  const bladeData = new Float32Array(count * 4);

  const m = new Matrix4();
  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();
  const up = new Vector3(0, 1, 0);

  let placed = 0;
  let attempts = 0;
  const maxAttempts = count * 40;
  const clusterFreq = 0.55;

  while (placed < count && attempts < maxAttempts) {
    attempts++;
    const x = (rng() - 0.5) * w;
    const z = (rng() - 0.5) * d;

    // Density: noise-driven clumping. `clustering` blends uniform <-> clumped.
    const n = fbm(x * clusterFreq + 10, z * clusterFreq + 20, seed);
    const density = (1 - clustering) + clustering * Math.pow(Math.max(0, (n - 0.25) / 0.6), 1.5) * 1.6;
    if (rng() > density) continue;

    // Optional silhouette mask (0..1). Soft edge: sample as a probability.
    if (mask) {
      const mv = mask.sample(x / w + 0.5, z / d + 0.5);
      if (mv <= 0.02) continue;
      if (rng() > mv) continue;
    }

    // Per-instance variation. Height correlates with local density (thicker clumps grow taller).
    const hMix = Math.pow(rng(), 0.8) * 0.7 + n * 0.3;
    const height = bladeHeight[0] + (bladeHeight[1] - bladeHeight[0]) * hMix;
    const yaw = rng() * Math.PI * 2;
    const tilt = (rng() - 0.5) * 0.18; // slight random lean baked into the pose

    pos.set(x, 0, z);
    quat.setFromAxisAngle(up, yaw);
    if (tilt !== 0) {
      const t = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), tilt);
      quat.multiply(t);
    }
    scl.setScalar(height); // uniform scale: height also widens the blade (see shader inverse)
    m.compose(pos, quat, scl);
    m.toArray(matrices, placed * 16);

    const i4 = placed * 4;
    bladeData[i4 + 0] = rng();                       // phase
    bladeData[i4 + 1] = 0.3 + rng() * 0.7;           // stiffness
    bladeData[i4 + 2] = Math.min(1, Math.max(0, n * 0.5 + rng() * 0.5)); // colour seed (spatially coherent-ish)
    bladeData[i4 + 3] = hMix;                        // height fraction
    placed++;
  }

  // Rejection sampling may place fewer than requested (dense mask / low density): trim to fit.
  return { matrices: matrices.subarray(0, placed * 16), bladeData: bladeData.subarray(0, placed * 4), count: placed };
}

/**
 * Rasterise a text string or an image (SVG/PNG) into a coverage mask.
 * Returns { sample(u, v) -> 0..1 } with u along X, v along Z (0..1 across the field).
 */
export async function createMask(maskConfig, fieldSize) {
  const res = maskConfig.resolution || 512;
  const aspect = fieldSize[0] / fieldSize[1];
  const W = res, H = Math.max(8, Math.round(res / aspect));
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, W, H);
  const padding = maskConfig.padding ?? 0.06;

  if (maskConfig.text) {
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Fit the text to the field width. `font` is a CSS font shorthand; any px size in it is
    // replaced (e.g. '900 200px sans-serif' or 'bold "Arial Black"').
    const base = maskConfig.font || '900 sans-serif';
    const setFont = (size) => {
      ctx.font = /\d+(\.\d+)?px/.test(base) ? base.replace(/\d+(\.\d+)?px/, `${size}px`) : base.replace(/(\S+)$/, `${size}px $1`);
    };
    let size = H * 0.8;
    setFont(size);
    while (ctx.measureText(maskConfig.text).width > W * (1 - padding * 2) && size > 4) {
      size *= 0.92;
      setFont(size);
    }
    ctx.fillText(maskConfig.text, W / 2, H / 2);
  } else if (maskConfig.image) {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = maskConfig.image;
    });
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const s = Math.min((W * (1 - padding * 2)) / iw, (H * (1 - padding * 2)) / ih);
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  // Soft edge so the boundary looks natural instead of razor-cut.
  const data = ctx.getImageData(0, 0, W, H).data;
  const cov = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = data[i * 4 + 3] / 255;
    const lum = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / (3 * 255);
    cov[i] = maskConfig.image && maskConfig.useLuminance ? lum * a : a;
  }
  const blur = maskConfig.feather ?? 2;
  const out = blur > 0 ? boxBlur(cov, W, H, blur) : cov;
  const invert = !!maskConfig.invert;

  return {
    width: W, height: H,
    sample(u, v) {
      const x = Math.min(W - 1, Math.max(0, Math.floor(u * W)));
      const y = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
      const c = out[y * W + x];
      return invert ? 1 - c : c;
    },
  };
}

function boxBlur(src, W, H, r) {
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  const n = r * 2 + 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * W + Math.min(W - 1, Math.max(0, x + k))];
      tmp[y * W + x] = s / n;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(H - 1, Math.max(0, y + k)) * W + x];
      out[y * W + x] = s / n;
    }
  }
  return out;
}
