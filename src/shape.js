import { DataTexture, RedFormat, UnsignedByteType, LinearFilter, ClampToEdgeWrapping } from 'three';
import { fbm } from './scatter.js';

/**
 * Shape mask: rasterises an SVG (URL or inline markup), a raster image, or text into an
 * offscreen canvas, trims to the content's bounding box (+ margin), blurs the coverage for a
 * feathered edge, and exposes:
 *   - `coverage(u, v, x, z)`  placement probability 0..1 with a noise-jittered threshold
 *   - `inside(u, v, x, z)`    boolean at 0.5 probability (used for flower spawns)
 *   - `texture`               DataTexture of the blurred coverage for the ground shader
 *   - `aspect`, `fieldSize`   world-space size of the trimmed bounding box + margin
 *
 * u runs along +X (0 = left), v runs along +Z (0 = far / top of the image).
 */
export async function createShapeMask(cfg) {
  const resolution = cfg.resolution || 1024;
  const source = await loadShapeImage(cfg, resolution);
  const { image, width: W, height: H } = source;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, W, H);
  if (source.text) {
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = source.font;
    ctx.fillText(source.text, W / 2, H / 2);
  } else {
    ctx.drawImage(image, 0, 0, W, H);
  }

  const px = ctx.getImageData(0, 0, W, H).data;
  const raw = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = px[i * 4 + 3] / 255;
    const lum = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    let v = cfg.useLuminance ? lum * a : a;
    if (cfg.invert) v = 1 - v;
    raw[i] = v;
  }

  // ---- trim to content bounding box + margin ------------------------------------------
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (raw[y * W + x] > 0.02) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error('shape mask is empty (no opaque pixels found)');
  const longEdge = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const marginPx = Math.round((cfg.margin ?? 0.06) * longEdge);
  x0 = Math.max(0, x0 - marginPx); y0 = Math.max(0, y0 - marginPx);
  x1 = Math.min(W - 1, x1 + marginPx); y1 = Math.min(H - 1, y1 + marginPx);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const cropped = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cropped[y * w + x] = raw[(y + y0) * W + (x + x0)];

  // ---- feather: blur so the threshold sits on a soft gradient band ----------------------
  const long = Math.max(w, h);
  const featherPx = Math.max(1, Math.round((cfg.feather ?? 0.035) * long));
  const soft = boxBlur(boxBlur(cropped, w, h, featherPx), w, h, Math.max(1, featherPx >> 1));

  // ---- world size ----------------------------------------------------------------------
  const size = cfg.size ?? 12;
  const aspect = w / h;
  const fieldSize = aspect >= 1 ? [size, size / aspect] : [size * aspect, size];

  const tex = new DataTexture(Uint8Array.from(soft, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255)), w, h, RedFormat, UnsignedByteType);
  tex.minFilter = LinearFilter; tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;

  const threshold = cfg.threshold ?? 0.5;
  const band = cfg.feather ?? 0.035;             // half-width of the soft band in mask units (0..1 coverage)
  const edgeNoise = cfg.edgeNoise ?? 0.35;
  const noiseFreq = cfg.edgeNoiseScale ?? 2.2;   // per world unit
  const seed = cfg.seed ?? 7;

  const sample = (u, v) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
    return soft[y * w + x];
  };
  const coverage = (u, v, x, z) => {
    const n = (fbm(x * noiseFreq + 31, z * noiseFreq + 17, seed, 3) - 0.5) * edgeNoise;
    const t = (sample(u, v) + n - (threshold - band)) / (2 * band);
    const s = Math.min(1, Math.max(0, t));
    return s * s * (3 - 2 * s);
  };

  return {
    width: w, height: h, aspect, fieldSize, texture: tex,
    threshold, band, edgeNoise, noiseFreq,
    sample, coverage,
    inside: (u, v, x, z) => coverage(u, v, x, z) >= 0.5,
    dispose() { tex.dispose(); },
  };
}

/** Resolves the shape source into a drawable image (or text spec) sized to `resolution` on its long edge. */
async function loadShapeImage(cfg, resolution) {
  if (cfg.text) {
    const font = cfg.font || '900 sans-serif';
    // Measure to get an aspect for the canvas, then re-fit.
    const c = document.createElement('canvas').getContext('2d');
    const setFont = (size) => { c.font = /\d+(\.\d+)?px/.test(font) ? font.replace(/\d+(\.\d+)?px/, `${size}px`) : font.replace(/(\S+)$/, `${size}px $1`); };
    setFont(100);
    const m = c.measureText(cfg.text);
    const textW = m.width, textH = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) || 75;
    const pad = 1.15;
    const scale = resolution / (Math.max(textW, textH) * pad);
    const W = Math.round(textW * pad * scale), H = Math.round(textH * pad * scale);
    setFont(100 * scale);
    return { text: cfg.text, font: c.font, width: W, height: H };
  }

  let url = cfg.image || cfg.svg;
  if (!url) throw new Error('shapeSource needs one of: svg (URL or inline markup), image (URL), text');
  let objectUrl = null;
  if (cfg.svg) {
    // Inline markup or fetched text: force explicit pixel dimensions so the browser rasterises
    // at our resolution regardless of the file's width/height/viewBox combination.
    let markup = cfg.svg.trim().startsWith('<') ? cfg.svg : await (await fetch(cfg.svg, { mode: 'cors' })).text();
    const vb = markup.match(/viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)\s*["']/i);
    let vw = vb ? parseFloat(vb[3]) : NaN, vh = vb ? parseFloat(vb[4]) : NaN;
    if (!(vw > 0 && vh > 0)) {
      const wm = markup.match(/<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i), hm = markup.match(/<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i);
      vw = wm ? parseFloat(wm[1]) : 300; vh = hm ? parseFloat(hm[1]) : 150;
      if (!vb) markup = markup.replace(/<svg/i, `<svg viewBox="0 0 ${vw} ${vh}"`);
    }
    const s = resolution / Math.max(vw, vh);
    const W = Math.max(1, Math.round(vw * s)), H = Math.max(1, Math.round(vh * s));
    markup = markup.replace(/<svg([^>]*?)\s(width|height)\s*=\s*["'][^"']*["']/gi, '<svg$1').replace(/<svg([^>]*?)\s(width|height)\s*=\s*["'][^"']*["']/gi, '<svg$1');
    markup = markup.replace(/<svg/i, `<svg width="${W}" height="${H}"`);
    if (!/xmlns\s*=/.test(markup)) markup = markup.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    objectUrl = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    url = objectUrl;
  }
  const image = await new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`shape image failed to load: ${cfg.image || cfg.svg}`));
    im.src = url;
  });
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
  const s = resolution / Math.max(iw, ih);
  return { image, width: Math.max(1, Math.round(iw * s)), height: Math.max(1, Math.round(ih * s)) };
}

function boxBlur(src, W, H, r) {
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  const n = r * 2 + 1;
  for (let y = 0; y < H; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[y * W + Math.min(W - 1, Math.max(0, k))];
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = acc / n;
      const outIdx = Math.min(W - 1, Math.max(0, x - r)), inIdx = Math.min(W - 1, Math.max(0, x + r + 1));
      acc += src[y * W + inIdx] - src[y * W + outIdx];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(H - 1, Math.max(0, k)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / n;
      const outIdx = Math.min(H - 1, Math.max(0, y - r)), inIdx = Math.min(H - 1, Math.max(0, y + r + 1));
      acc += tmp[inIdx * W + x] - tmp[outIdx * W + x];
    }
  }
  return out;
}
