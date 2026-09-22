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
const _tiltQ = new Quaternion();
const _xAxis = new Vector3(1, 0, 0);

export function scatterBlades({
  count, fieldSize, bladeHeight, clustering, seed, mask = null, lean = [0, 5],
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

    // Optional silhouette mask: feathered, noise-jittered acceptance probability.
    if (mask) {
      const cov = mask.coverage(x / w + 0.5, z / d + 0.5, x, z);
      if (cov <= 0.001 || rng() > cov) continue;
    }

    // Per-instance variation. Height correlates with local density (thicker clumps grow taller).
    const hMix = Math.pow(rng(), 0.8) * 0.7 + n * 0.3;
    const height = bladeHeight[0] + (bladeHeight[1] - bladeHeight[0]) * hMix;
    const yaw = rng() * Math.PI * 2;
    // Static lean baked into the pose (degrees). Top-down views need real lean so blades show
    // their faces from above instead of reading as hairlines.
    const leanDeg = lean[0] + (lean[1] - lean[0]) * Math.pow(rng(), 0.7);
    const tilt = (leanDeg * Math.PI) / 180;

    pos.set(x, 0, z);
    quat.setFromAxisAngle(up, yaw);
    if (tilt !== 0) quat.multiply(_tiltQ.setFromAxisAngle(_xAxis, tilt));
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
