/**
 * Default configuration. Every key can be overridden via `mount(container, options)`.
 * Nested objects are deep-merged, so you only need to pass what you change.
 */
export const defaultConfig = {
  // ---- scale / density ---------------------------------------------------------
  instanceCount: 60000,     // grass blades (see README "Performance" for how this was chosen)
  fieldSize: [13, 8],       // world units (metres) [width X, depth Z]
  bladeHeight: [0.28, 0.75],// min/max blade height (world units); scale also widens the blade
  bladeWidth: 0.045,        // base width at scale 1
  clustering: 0.55,         // 0 = uniform scatter, 1 = strongly clumped (noise-driven density)
  seed: 1337,

  // ---- rendering ---------------------------------------------------------------
  dprCap: 1.5,              // max devicePixelRatio
  shadows: 'medium',        // 'off' | 'low' (1024) | 'medium' (2048) | 'high' (4096)
  toneMappingExposure: 1.0,
  background: null,         // null = transparent canvas; or a CSS colour string; or 'hdri'
  post: {
    enabled: true,
    antialias: 'smaa',      // 'smaa' | 'fxaa' | 'none' — edge AA when post is on (canvas MSAA is unavailable with a composer)
    msaa: 0,                // MSAA samples on the composer target. Keep 0: three.js invalidates a multisampled
                            // buffer after each resolve, so bloom's additive blend onto it reads undefined memory
                            // on real GPUs (blank canvas). Software GL hides this.
    bloom: true,
    bloomStrength: 0.18,
    bloomRadius: 0.4,
    bloomThreshold: 0.9,
    ao: true,               // GTAO between blade clusters (costly; auto-disabled on low-power)
    aoIntensity: 0.9,
    dof: false,             // shallow depth of field
    dofFocus: 5.2,          // distance from camera in world units
    dofAperture: 0.00025,
    dofMaxBlur: 0.008,
  },

  // ---- camera ------------------------------------------------------------------
  camera: {
    fov: 31,
    position: [0, 2.5, 6.3],   // standing-height view; the far edge of the field stays above the top of the frame
    target: [0, 0.19, 2.68],
    near: 0.1,
    far: 60,
  },

  // ---- lighting ----------------------------------------------------------------
  // Sun direction must match the HDRI's brightest spot (see scripts/gen-hdri.mjs).
  sun: { azimuth: 215, elevation: 28, intensity: 2.6, color: '#fff2dc' },
  envIntensity: 1.0,

  // ---- wind --------------------------------------------------------------------
  wind: {
    direction: [1, 0.35],   // XZ, normalised internally
    speed: 0.55,            // noise scroll speed
    strength: 0.22,         // tip displacement (world units) at full gust
    scale: 0.32,            // noise frequency: lower = broader gust fronts
  },

  // ---- cursor ------------------------------------------------------------------
  cursor: {
    radius: 1.15,           // world units
    strength: 0.55,         // push distance at the centre
    smoothing: 0.18,        // 0..1 lerp factor per frame (lower = lazier follow)
  },

  // ---- flowers -----------------------------------------------------------------
  flowers: {
    enabled: true,
    max: 16,                // pool size; also MAX_FLOWERS in the shader (hard cap 16)
    spawnInterval: 260,     // ms between spawns while the pointer keeps moving
    dwellMs: 90,            // ms of hover before the first flower appears
    spacing: 0.55,          // min world distance between a new flower and live ones
    bloomMs: 900,
    holdMs: 1400,           // how long a flower stays open after the cursor leaves it
    wiltMs: 1300,
    holdRadius: 1.3,        // a flower stays open while the cursor is within this distance
    radius: 0.9,            // grass yield radius around a blooming flower
    strength: 0.5,          // grass push distance around a blooming flower
    height: [0.5, 0.8],
    petalColors: ['#ffd4e5', '#fff5c2', '#e8d9ff', '#ffe9d1'],
    centerColor: '#ffbf3c',
    stemColor: '#4c8f34',
  },

  // ---- colours -----------------------------------------------------------------
  colors: {
    root: '#1c3b12',
    tip: '#9dc95a',
    dry: '#c9b86a',
    variance: 0.6,
    rootAO: 0.55,
    sss: '#d8f28a',
    sssStrength: 1.1,
    sssPower: 6.0,
    groundA: '#2a2416',
    groundB: '#4a4128',
  },

  // ---- assets ------------------------------------------------------------------
  assets: {
    // Resolved relative to the bundle URL when null. See README "Asset hosting".
    hdri: null,
  },

  // ---- optional silhouette mask (stretch goal) -----------------------------------
  // { text: 'HELLO', font: '900 200px sans-serif' } or { image: 'https://.../logo.svg' }
  mask: null,

  // ---- device fallbacks --------------------------------------------------------
  autoDetect: true,         // detect low-power / mobile devices and apply `lowPower`
  lowPower: {
    instanceCount: 16000,
    dprCap: 1,
    shadows: 'low',
    post: { enabled: false },
  },

  // ---- misc --------------------------------------------------------------------
  pauseWhenHidden: true,    // stop the RAF loop when the tab is hidden / container off-screen
  debug: false,             // show an FPS / instance-count overlay
};

/** Deep-merge `src` into a copy of `base` (plain objects only; arrays are replaced). */
export function mergeConfig(base, src) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!src) return out;
  for (const key of Object.keys(src)) {
    const b = base ? base[key] : undefined;
    const s = src[key];
    if (s && typeof s === 'object' && !Array.isArray(s) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[key] = mergeConfig(b, s);
    } else if (s !== undefined) {
      out[key] = s;
    }
  }
  return out;
}

/** Heuristic low-power detection. Errs on the side of the fallback for touch-first devices. */
export function isLowPowerDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Opera Mini/i.test(ua);
  const uaDataMobile = navigator.userAgentData?.mobile === true;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const lowCores = (navigator.hardwareConcurrency || 8) <= 4;
  const lowMem = (navigator.deviceMemory || 8) <= 4;
  const saveData = navigator.connection?.saveData === true;
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return uaMobile || uaDataMobile || (coarse && (lowCores || lowMem)) || saveData || reducedMotion;
}

export const SHADOW_MAP_SIZES = { off: 0, low: 1024, medium: 2048, high: 4096 };
