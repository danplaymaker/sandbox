import { Vector2, WebGLRenderTarget, HalfFloatType, UnsignedByteType, ShaderMaterial, NearestFilter } from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

/**
 * Builds an EffectComposer chain: render -> GTAO -> bloom -> (DoF) -> output (tone map + sRGB).
 * Every effect is toggleable from `config.post`. Returns null when post is disabled so the
 * caller renders directly.
 */
export function createPostFX(renderer, scene, camera, cfg, width, height, { probe = false } = {}) {
  if (!cfg.enabled) return null;
  // NOTE: cfg.msaa defaults to 0 on purpose; see config.js. Anti-aliasing comes from SMAA/FXAA below.
  const target = new WebGLRenderTarget(width, height, { type: HalfFloatType, samples: cfg.msaa ?? 0 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, camera));

  const passes = {};

  if (probe) {
    // Debug-only: samples the raw scene buffer for NaN/Inf and hot pixels (see ProbePass).
    passes.probe = new ProbePass(cfg.bloomThreshold);
    composer.addPass(passes.probe);
  }

  if (cfg.ao) {
    const gtao = new GTAOPass(scene, camera, width, height);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = cfg.aoIntensity;
    gtao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 0.6, scale: 1.0, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 8 });
    patchNormalPass(gtao);
    hardenGtaoShaders(gtao);
    composer.addPass(gtao);
    passes.ao = gtao;
  }

  if (cfg.bloom) {
    const bloom = new UnrealBloomPass(new Vector2(width, height), cfg.bloomStrength, cfg.bloomRadius, cfg.bloomThreshold);
    hardenBloomShaders(bloom);
    composer.addPass(bloom);
    passes.bloom = bloom;
  }

  if (cfg.dof) {
    const bokeh = new BokehPass(scene, camera, { focus: cfg.dofFocus, aperture: cfg.dofAperture, maxblur: cfg.dofMaxBlur });
    composer.addPass(bokeh);
    passes.dof = bokeh;
  }

  if (cfg.antialias === 'smaa') {
    // SMAA runs on the HDR buffer before tone mapping (matches three's own SMAA example).
    const smaa = new SMAAPass();
    composer.addPass(smaa);
    passes.aa = smaa;
  }

  composer.addPass(new OutputPass());

  if (cfg.antialias === 'fxaa') {
    // FXAA expects sRGB input, so it goes after the output pass.
    const fxaa = new FXAAPass();
    composer.addPass(fxaa);
    passes.aa = fxaa;
  }

  return {
    composer,
    passes,
    setSize(w, h) {
      // EffectComposer forwards the DPR-scaled size to every pass; don't resize passes again.
      composer.setSize(w, h);
    },
    render() { composer.render(); },
    dispose() {
      composer.dispose();
      passes.ao?.dispose?.();
      passes.bloom?.dispose?.();
      passes.dof?.dispose?.();
      passes.aa?.dispose?.();
      passes.probe?.dispose?.();
    },
  };
}

/**
 * GTAO renders scene normals/depth with a single override material, which would ignore the
 * wind/cursor bending baked into our vertex shaders (AO halos would not follow the blades).
 * Instead, meshes that carry `userData.normalMaterial` get their own bending-aware normal
 * material swapped in for that pass; everything else uses the pass's default normal material.
 */
function patchNormalPass(gtao) {
  const swapped = [];
  gtao._renderOverride = function (renderer, overrideMaterial, renderTarget, clearColor, clearAlpha) {
    renderer.getClearColor(this._originalClearColor);
    const originalClearAlpha = renderer.getClearAlpha();
    const originalAutoClear = renderer.autoClear;
    renderer.setRenderTarget(renderTarget);
    renderer.autoClear = false;
    renderer.setClearColor(clearColor);
    renderer.setClearAlpha(clearAlpha || 0.0);
    renderer.clear();

    this.scene.traverse((obj) => {
      if (!obj.isMesh) return;
      swapped.push([obj, obj.material]);
      obj.material = obj.userData.normalMaterial || overrideMaterial;
    });
    renderer.render(this.scene, this.camera);
    for (const [obj, mat] of swapped) obj.material = mat;
    swapped.length = 0;

    renderer.autoClear = originalAutoClear;
    renderer.setClearColor(this._originalClearColor);
    renderer.setClearAlpha(originalClearAlpha);
  };
}

/**
 * GTAO's shader can produce NaN on real GPUs: `normalize()` of a zero sample delta, and
 * `sqrt(1 - cos²)` / `acos(cos)` when cos drifts past 1 in half-float precision. Software GL
 * returns 0 for normalize(0) so this never shows in headless tests, but on hardware a single
 * NaN texel is multiplied into the scene colour and then smeared over the whole frame by the
 * bloom blur (NaN -> white canvas). Clamp the maths and sanitise the outputs.
 */
function hardenGtaoShaders(gtao) {
  const g = gtao.gtaoMaterial;
  g.fragmentShader = g.fragmentShader
    .split('normalize(viewDelta)').join('(viewDelta / max(length(viewDelta), 1e-6))')
    .replace('vec2 sinHorizons = sqrt(1. - cosHorizons * cosHorizons);',
             'cosHorizons = clamp(cosHorizons, -1., 1.);\n\t\t\t\tvec2 sinHorizons = sqrt(max(vec2(0.), 1. - cosHorizons * cosHorizons));')
    .replace('gl_FragColor = FRAGMENT_OUTPUT;', 'if (isnan(ao) || isinf(ao)) ao = 1.0;\n\t\t\tgl_FragColor = FRAGMENT_OUTPUT;');
  g.needsUpdate = true;
  const pd = gtao.pdMaterial;
  pd.fragmentShader = pd.fragmentShader
    .replace('gl_FragColor = FRAGMENT_OUTPUT;', 'denoised = mix(denoised, vec3(1.0), vec3(isnan(denoised.x) || isinf(denoised.x)));\n\t\t\tgl_FragColor = FRAGMENT_OUTPUT;');
  pd.needsUpdate = true;
}

/**
 * Bloom's blur chain spreads any NaN/Inf texel in its input across the whole frame (a single
 * bad texel becomes a white flash). Zero such texels in the high-pass before they enter the
 * blur, whatever produced them.
 */
function hardenBloomShaders(bloom) {
  const m = bloom.materialHighPassFilter;
  m.fragmentShader = m.fragmentShader.replace(
    'vec4 texel = texture2D( tDiffuse, vUv );',
    'vec4 texel = texture2D( tDiffuse, vUv );\n\t\t\tif (any(isnan(texel)) || any(isinf(texel))) texel = vec4(0.0);'
  );
  m.needsUpdate = true;
}

/**
 * Debug probe: every N frames, reduce the scene buffer to a small RGBA8 target where
 * r = any NaN/Inf in the block, g = any texel above the bloom threshold, b = peak luminance / 16,
 * then read it back on the CPU. Lets a real GPU report what software GL cannot reproduce.
 */
class ProbePass extends Pass {
  constructor(threshold, every = 20) {
    super();
    this.needsSwap = false;
    this.every = every;
    this.frame = 0;
    this.w = 160; this.h = 90;
    this.rt = new WebGLRenderTarget(this.w, this.h, { type: UnsignedByteType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter });
    this.buffer = new Uint8Array(this.w * this.h * 4);
    this.stats = { nan: 0, hot: 0, maxLum: 0, samples: 0 };
    this.material = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: threshold }, uTexel: { value: new Vector2() } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uThreshold; uniform vec2 uTexel; varying vec2 vUv;
        void main() {
          float bad = 0.0, hot = 0.0, maxL = 0.0;
          for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) {
            vec4 t = texture2D(tDiffuse, vUv + vec2(float(x), float(y)) * uTexel * 1.7);
            if (any(isnan(t)) || any(isinf(t))) bad = 1.0;
            float l = dot(t.rgb, vec3(0.2126, 0.7152, 0.0722));
            if (l > uThreshold) hot = 1.0;
            maxL = max(maxL, l);
          }
          gl_FragColor = vec4(bad, hot, clamp(maxL / 16.0, 0.0, 1.0), 1.0);
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    if (++this.frame % this.every) return;
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.material.uniforms.uTexel.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    renderer.readRenderTargetPixels(this.rt, 0, 0, this.w, this.h, this.buffer);
    let nan = 0, hot = 0, maxB = 0;
    const b = this.buffer;
    for (let i = 0; i < b.length; i += 4) { if (b[i]) nan++; if (b[i + 1]) hot++; if (b[i + 2] > maxB) maxB = b[i + 2]; }
    this.stats = { nan, hot, maxLum: (maxB / 255) * 16, samples: this.w * this.h };
  }
  setSize() {}
  dispose() { this.rt.dispose(); this.material.dispose(); this.quad.dispose(); }
}
