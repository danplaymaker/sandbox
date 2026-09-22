import { Vector2, WebGLRenderTarget, HalfFloatType } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Builds an EffectComposer chain: render -> GTAO -> bloom -> (DoF) -> output (tone map + sRGB).
 * Every effect is toggleable from `config.post`. Returns null when post is disabled so the
 * caller renders directly.
 */
export function createPostFX(renderer, scene, camera, cfg, width, height) {
  if (!cfg.enabled) return null;
  // MSAA on the composer's own target so blades stay crisp without the canvas antialias flag.
  const target = new WebGLRenderTarget(width, height, { type: HalfFloatType, samples: cfg.msaa ?? 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, camera));

  const passes = {};

  if (cfg.ao) {
    const gtao = new GTAOPass(scene, camera, width, height);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = cfg.aoIntensity;
    gtao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 0.6, scale: 1.0, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 8 });
    patchNormalPass(gtao);
    composer.addPass(gtao);
    passes.ao = gtao;
  }

  if (cfg.bloom) {
    const bloom = new UnrealBloomPass(new Vector2(width, height), cfg.bloomStrength, cfg.bloomRadius, cfg.bloomThreshold);
    composer.addPass(bloom);
    passes.bloom = bloom;
  }

  if (cfg.dof) {
    const bokeh = new BokehPass(scene, camera, { focus: cfg.dofFocus, aperture: cfg.dofAperture, maxblur: cfg.dofMaxBlur });
    composer.addPass(bokeh);
    passes.dof = bokeh;
  }

  composer.addPass(new OutputPass());

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
