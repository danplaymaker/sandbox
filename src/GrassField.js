import {
  Scene, PerspectiveCamera, OrthographicCamera, WebGLRenderer, Color, Vector2, Vector3, Vector4, Plane, Raycaster,
  InstancedMesh, InstancedBufferAttribute, DynamicDrawUsage, Matrix4,
  MeshPhysicalMaterial, MeshStandardMaterial, MeshDepthMaterial, MeshNormalMaterial, NoBlending, RGBADepthPacking, DoubleSide,
  PlaneGeometry, Mesh, DirectionalLight, PMREMGenerator, EquirectangularReflectionMapping,
  ACESFilmicToneMapping, SRGBColorSpace, PCFShadowMap, MathUtils, Sphere,
} from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'; // successor of RGBELoader (same .hdr / RGBE format)

import { defaultConfig, mergeConfig, isLowPowerDevice, SHADOW_MAP_SIZES } from './config.js';
import { createBladeGeometry } from './geometry/bladeGeometry.js';
import { createFlowerGeometry } from './geometry/flowerGeometry.js';
import { scatterBlades, createRng } from './scatter.js';
import { createShapeMask } from './shape.js';
import { FlowerPool } from './flowers.js';
import { createPostFX } from './postfx.js';

import noiseGLSL from './shaders/noise.glsl?raw';
import fieldParsVert from './shaders/field_pars.vert.glsl?raw';
import grassParsVert from './shaders/grass_pars.vert.glsl?raw';
import grassBeginNormalVert from './shaders/grass_beginnormal.vert.glsl?raw';
import grassBeginVert from './shaders/grass_begin.vert.glsl?raw';
import grassParsFrag from './shaders/grass_pars.frag.glsl?raw';
import grassColorFrag from './shaders/grass_color.frag.glsl?raw';
import grassLightsFrag from './shaders/grass_lights.frag.glsl?raw';
import flowerParsVert from './shaders/flower_pars.vert.glsl?raw';
import flowerBeginNormalVert from './shaders/flower_beginnormal.vert.glsl?raw';
import flowerBeginVert from './shaders/flower_begin.vert.glsl?raw';
import flowerParsFrag from './shaders/flower_pars.frag.glsl?raw';
import flowerColorFrag from './shaders/flower_color.frag.glsl?raw';
import groundParsFrag from './shaders/ground_pars.frag.glsl?raw';
import groundColorFrag from './shaders/ground_color.frag.glsl?raw';
import clampFrag from './shaders/clamp.frag.glsl?raw';

const MAX_FLOWERS = 16;

export class GrassField {
  constructor(container, options = {}) {
    this.container = container;
    // Shape-constrained fields get the topDown preset underneath the caller's options, and the
    // shapeSource object is completed with shapeDefaults.
    let base = defaultConfig;
    if (options.shapeSource) {
      base = mergeConfig(defaultConfig, defaultConfig.topDown);
      options = { ...options, shapeSource: mergeConfig(defaultConfig.shapeDefaults, options.shapeSource) };
    }
    this.config = mergeConfig(base, options);
    if (this.config.autoDetect && isLowPowerDevice()) {
      this.config = mergeConfig(this.config, this.config.lowPower);
      this.lowPower = true;
    }
    this.disposed = false;
    this.ready = false;
    this._raf = 0;
    this._visible = true;
    this._pageVisible = true;
    this._pointerActive = false;
    this._pointerNDC = new Vector2();
    this._cursorTarget = new Vector3(0, 0, 0);
    this._cursorSmoothed = new Vector3(0, 0, 0);
    this._cursorPrev = new Vector3(0, 0, 0);
    this._cursorVel = new Vector2();
    this._velScratch = new Vector2();
    this._cursorMix = 0; // eases push strength in/out as the pointer enters/leaves
    this._clock = { start: performance.now(), last: performance.now() };
    this._fps = { frames: 0, t: performance.now(), value: 0 };
    this._listeners = [];
    this._init();
  }

  // ----------------------------------------------------------------------------------
  // Setup
  // ----------------------------------------------------------------------------------
  _init() {
    const cfg = this.config;
    const c = this.container;
    if (getComputedStyle(c).position === 'static') c.style.position = 'relative';

    let renderer;
    try {
      // With post-processing on, MSAA happens on the composer target instead of the canvas.
      renderer = new WebGLRenderer({ antialias: !cfg.post.enabled, alpha: cfg.background === null, powerPreference: 'high-performance', stencil: false });
    } catch (e) {
      this._fail('WebGL is not available', e);
      return;
    }
    this.renderer = renderer;
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = [gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs), gl.getProgramInfoLog(program)].filter(Boolean).join('\n');
      this._fail('Shader failed to compile on this GPU', log);
    };
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cfg.dprCap));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = cfg.toneMappingExposure;
    const shadowSize = SHADOW_MAP_SIZES[cfg.shadows] ?? 2048;
    renderer.shadowMap.enabled = shadowSize > 0;
    renderer.shadowMap.type = PCFShadowMap;
    if (cfg.background === null) renderer.setClearColor(0x000000, 0);
    else if (cfg.background !== 'hdri') renderer.setClearColor(new Color(cfg.background), 1);

    const canvas = renderer.domElement;
    canvas.style.cssText = 'display:block;width:100%;height:100%;position:absolute;inset:0;touch-action:none;';
    canvas.setAttribute('aria-hidden', 'true');
    c.appendChild(canvas);
    this.canvas = canvas;

    this.scene = new Scene();
    this.groundPlane = new Plane(new Vector3(0, 1, 0), 0);
    this.raycaster = new Raycaster();

    this._buildUniforms();
    this._loadEnvironment();
    if (cfg.debug) this._buildDebugOverlay();
    this._setup().catch((e) => this._fail('Setup failed', e));
  }

  async _setup() {
    // Shape mask first: it decides the field size everything else is built around.
    if (this.config.shapeSource) {
      try {
        this.mask = await createShapeMask(this.config.shapeSource);
        this.config.fieldSize = this.mask.fieldSize;
        this.shapeAspect = this.mask.aspect;
        this.uniforms.uShapeMask.value = this.mask.texture;
        this.uniforms.uShapeParams.value.set(this.mask.threshold, this.mask.band, this.mask.edgeNoise, this.mask.noiseFreq);
        this.uniforms.uFieldSize.value.fromArray(this.mask.fieldSize);
      } catch (e) {
        this._fail('Shape could not be rasterised; falling back to a rectangular field', e);
      }
    }
    if (this.disposed) return;
    this._buildCamera();
    this._buildLights();
    this._buildGround();
    this._buildFlowers();
    this._buildGrass();
    if (this.disposed) return;
    this._buildPost();
    this._bindEvents();
    this._resize();
    this.ready = true;
    this._loop();
  }

  _buildCamera() {
    const cam = this.config.camera;
    if (cam.type === 'orthographic') {
      // Top-down: straight above the field centre, tilted `cam.tilt` degrees toward +Z so thin
      // blades keep a readable silhouette. Frustum extents are set in _resize().
      const t = MathUtils.degToRad(cam.tilt ?? 8);
      const dist = 30;
      this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, dist * 2 + 10);
      this.camera.position.set(0, Math.cos(t) * dist, Math.sin(t) * dist);
      this.camera.up.set(0, 0, -1);
      this.camera.lookAt(0, 0, 0);
    } else {
      this.camera = new PerspectiveCamera(cam.fov, 1, cam.near, cam.far);
      this.camera.position.fromArray(cam.position);
      this.camera.lookAt(new Vector3().fromArray(cam.target));
    }
  }

  _fail(msg, err) {
    console.warn('[grass-field]', msg, err || '');
    this.container.dispatchEvent(new CustomEvent('grassfield:error', { detail: { message: msg, error: err } }));
  }

  _buildUniforms() {
    const cfg = this.config;
    const wd = new Vector2().fromArray(cfg.wind.direction).normalize();
    this.flowerUniform = Array.from({ length: MAX_FLOWERS }, () => new Vector4(0, 0, 0, 0));
    this.uniforms = {
      uTime: { value: 0 },
      uWindDir: { value: wd },
      uWindSpeed: { value: cfg.wind.speed },
      uWindStrength: { value: cfg.wind.strength },
      uWindScale: { value: cfg.wind.scale },
      uCursorPos: { value: new Vector3(0, 0, 0) },
      uCursorRadius: { value: cfg.cursor.radius },
      uCursorStrength: { value: 0 },
      uCursorVel: { value: new Vector2() },
      uFlowers: { value: this.flowerUniform },
      uFlowerRadius: { value: cfg.flowers.radius },
      uFlowerStrength: { value: cfg.flowers.strength },
      // fragment
      uRootColor: { value: new Color(cfg.colors.root) },
      uTipColor: { value: new Color(cfg.colors.tip) },
      uDryColor: { value: new Color(cfg.colors.dry) },
      uColorVariance: { value: cfg.colors.variance },
      uRootAO: { value: cfg.colors.rootAO },
      uSSSColor: { value: new Color(cfg.colors.sss) },
      uSSSStrength: { value: cfg.colors.sssStrength },
      uSSSPower: { value: cfg.colors.sssPower },
      uPetalColors: { value: cfg.flowers.petalColors.slice(0, 4).map((h) => new Color(h)) },
      uCenterColor: { value: new Color(cfg.flowers.centerColor) },
      uStemColor: { value: new Color(cfg.flowers.stemColor) },
      uGroundColorA: { value: new Color(cfg.colors.groundA) },
      uGroundColorB: { value: new Color(cfg.colors.groundB) },
      uGroundScale: { value: 0.6 },
      uBloomClamp: { value: new Vector2(cfg.post.clampKnee ?? 1.2, cfg.post.clampMax ?? 2.0) },
      uShapeMask: { value: null },
      uShapeParams: { value: new Vector4(0.5, 0.035, 0.35, 2.2) }, // threshold, band, edgeNoise, noiseFreq
      uFieldSize: { value: new Vector2().fromArray(cfg.fieldSize) },
    };
    while (this.uniforms.uPetalColors.value.length < 4) this.uniforms.uPetalColors.value.push(new Color(cfg.flowers.petalColors[0]));
  }

  _buildLights() {
    const cfg = this.config;
    const s = cfg.sun;
    const az = MathUtils.degToRad(s.azimuth), el = MathUtils.degToRad(s.elevation);
    const dir = new Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    const sun = new DirectionalLight(new Color(s.color), s.intensity);
    sun.position.copy(dir).multiplyScalar(12);
    sun.target.position.set(0, 0, 0);
    this.scene.add(sun, sun.target);
    const shadowSize = SHADOW_MAP_SIZES[cfg.shadows] ?? 2048;
    if (shadowSize > 0) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(shadowSize, shadowSize);
      const [w, d] = cfg.fieldSize;
      const half = Math.max(w, d) * 0.62;
      const sc = sun.shadow.camera;
      sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
      sc.near = 1; sc.far = 30;
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.02;
      sun.shadow.radius = 3;
    }
    this.sun = sun;
  }

  _injectField(shader, vertPars = '', fragPars = '') {
    // Shares wind/cursor/flower uniforms and the noise library with any material.
    // Order matters: noise -> field helpers -> material-specific helpers.
    Object.assign(shader.uniforms, this.uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${noiseGLSL}\n${fieldParsVert}\n${vertPars}`);
    if (fragPars) shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${fragPars}`);
  }

  _buildGround() {
    const cfg = this.config;
    const [w, d] = cfg.fieldSize;
    const mode = this.mask ? (cfg.shapeSource.ground ?? 'shape') : 'full';
    if (mode === 'none') return;
    const grow = mode === 'shape' ? 1.0 : 1.4;
    const geo = new PlaneGeometry(w * grow, d * grow, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
    if (mode === 'shape') mat.defines = { GROUND_SHAPE_CLIP: 1 };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${groundParsFrag}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${groundColorFrag}`);
    };
    const ground = new Mesh(geo, mat);
    ground.receiveShadow = true;
    ground.position.y = -0.005;
    this.scene.add(ground);
    this.ground = ground;
  }

  _buildGrass() {
    const cfg = this.config;
    const { matrices, bladeData, count } = scatterBlades({
      count: cfg.instanceCount, fieldSize: cfg.fieldSize, bladeHeight: cfg.bladeHeight,
      clustering: cfg.clustering, seed: cfg.seed, mask: this.mask, lean: cfg.bladeLean,
    });

    const geo = createBladeGeometry({ width: cfg.bladeWidth, cross: cfg.bladeCross });
    geo.setAttribute('aBladeData', new InstancedBufferAttribute(bladeData, 4));

    const mat = new MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.7,
      metalness: 0,
      side: DoubleSide,
      sheen: 0.3,
      sheenRoughness: 0.7,
      sheenColor: new Color('#b7d96b'),
      specularIntensity: 0.35,   // kept low: sub-pixel specular on moving blades is the main bloom-flicker source
      envMapIntensity: cfg.envIntensity,
    });
    mat.onBeforeCompile = (shader) => {
      this._injectField(shader, grassParsVert, grassParsFrag + '\n' + clampFrag);
      shader.vertexShader = shader.vertexShader
        .replace('#include <beginnormal_vertex>', grassBeginNormalVert)
        .replace('#include <begin_vertex>', grassBeginVert);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>\n${grassColorFrag}`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${grassLightsFrag}`)
        .replace('#include <opaque_fragment>', 'outgoingLight = softClampLuminance(outgoingLight);\n#include <opaque_fragment>');
    };
    // Shader source changes after compile are keyed by this so three re-links correctly.
    mat.customProgramCacheKey = () => 'grass-field-blade';

    const mesh = new InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.array.set(matrices);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // one draw call covering the whole field; culling would be per-mesh anyway
    const [w, d] = cfg.fieldSize;
    geo.boundingSphere = new Sphere(new Vector3(0, 0.4, 0), Math.hypot(w, d) * 0.5 + 1);

    // Shadow-map depth pass must bend identically or shadows won't follow the blades.
    const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: DoubleSide });
    depth.onBeforeCompile = (shader) => {
      this._injectField(shader, grassParsVert);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', grassBeginVert);
    };
    depth.customProgramCacheKey = () => 'grass-field-blade-depth';
    mesh.customDepthMaterial = depth;

    // Bending-aware normal material for the ambient-occlusion pre-pass (see postfx.js).
    const nrm = new MeshNormalMaterial({ side: DoubleSide, blending: NoBlending });
    nrm.onBeforeCompile = (shader) => {
      this._injectField(shader, grassParsVert);
      shader.vertexShader = shader.vertexShader
        .replace('#include <beginnormal_vertex>', grassBeginNormalVert)
        .replace('#include <begin_vertex>', grassBeginVert);
    };
    nrm.customProgramCacheKey = () => 'grass-field-blade-normal';
    mesh.userData.normalMaterial = nrm;

    this.scene.add(mesh);
    this.grass = mesh;
    this.bladeCount = count;
  }

  _buildFlowers() {
    const cfg = this.config;
    const max = Math.min(cfg.flowers.max, MAX_FLOWERS);
    const geo = createFlowerGeometry({ headScale: cfg.flowers.headScale ?? 1 });
    // The pool owns this array and rewrites it every frame; the attribute uploads it.
    const stateArray = new Float32Array(max * 4);
    const states = new InstancedBufferAttribute(stateArray, 4);
    states.setUsage(DynamicDrawUsage);
    geo.setAttribute('aFlowerState', states);

    const mat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0, side: DoubleSide, envMapIntensity: cfg.envIntensity });
    mat.onBeforeCompile = (shader) => {
      this._injectField(shader, flowerParsVert, flowerParsFrag + '\n' + clampFrag);
      shader.vertexShader = shader.vertexShader
        .replace('#include <beginnormal_vertex>', flowerBeginNormalVert)
        .replace('#include <begin_vertex>', flowerBeginVert);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>\n${flowerColorFrag}`)
        .replace('#include <opaque_fragment>', 'outgoingLight = softClampLuminance(outgoingLight);\n#include <opaque_fragment>');
    };
    mat.customProgramCacheKey = () => 'grass-field-flower';

    const mesh = new InstancedMesh(geo, mat, max);
    // Dead slots keep a unit-scale matrix: the shader collapses them to a point via bloom = 0.
    // A zero-scale matrix would make the shader's inverse-rotation divide by zero (NaN vertices,
    // which hardware GPUs rasterise as garbage and bloom then smears into full-frame flashes).
    const parked = new Matrix4();
    for (let i = 0; i < max; i++) mesh.setMatrixAt(i, parked);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: DoubleSide });
    depth.onBeforeCompile = (shader) => {
      this._injectField(shader, flowerParsVert);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', flowerBeginVert);
    };
    depth.customProgramCacheKey = () => 'grass-field-flower-depth';
    mesh.customDepthMaterial = depth;

    const nrm = new MeshNormalMaterial({ side: DoubleSide, blending: NoBlending });
    nrm.onBeforeCompile = (shader) => {
      this._injectField(shader, flowerParsVert);
      shader.vertexShader = shader.vertexShader
        .replace('#include <beginnormal_vertex>', flowerBeginNormalVert)
        .replace('#include <begin_vertex>', flowerBeginVert);
    };
    nrm.customProgramCacheKey = () => 'grass-field-flower-normal';
    mesh.userData.normalMaterial = nrm;

    this.scene.add(mesh);
    this.flowerMesh = mesh;
    // Flowers only spawn where grass was placed: share the rasterised mask, never re-rasterise.
    const [fw, fd] = cfg.fieldSize;
    const canSpawn = this.mask
      ? (x, z) => this.mask.inside(x / fw + 0.5, z / fd + 0.5, x, z)
      : (x, z) => Math.abs(x) <= fw / 2 && Math.abs(z) <= fd / 2;
    this.flowerPool = new FlowerPool(cfg.flowers, createRng(cfg.seed ^ 0x9e3779b9), mesh, this.flowerUniform, stateArray, canSpawn);
  }

  _loadEnvironment() {
    const cfg = this.config;
    let url = cfg.assets.hdri;
    if (!url) {
      if (import.meta.env?.DEV) url = '/hdri/meadow-sky.hdr'; // vite dev server serves ./public
      else {
        // Production: the .hdr is expected next to the bundle (dist/hdri/), wherever it is hosted.
        try { url = new URL(/* @vite-ignore */ './hdri/meadow-sky.hdr', import.meta.url).href; }
        catch { url = './hdri/meadow-sky.hdr'; }
      }
    }
    const pmrem = new PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    new HDRLoader().load(url, (tex) => {
      if (this.disposed) { tex.dispose(); pmrem.dispose(); return; }
      tex.mapping = EquirectangularReflectionMapping;
      const env = pmrem.fromEquirectangular(tex).texture;
      this.scene.environment = env;
      this.scene.environmentIntensity = cfg.envIntensity;
      if (cfg.background === 'hdri') { this.scene.background = tex; this.scene.backgroundBlurriness = 0.05; }
      else tex.dispose();
      this.envTexture = env;
      pmrem.dispose();
      this.container.dispatchEvent(new CustomEvent('grassfield:ready'));
    }, undefined, (err) => {
      pmrem.dispose();
      this._fail(`HDRI failed to load from ${url}; rendering with the sun light only`, err);
    });
  }

  _buildPost() {
    const { width, height } = this._size();
    this.post = createPostFX(this.renderer, this.scene, this.camera, this.config.post, width, height, { probe: !!this.config.debug });
  }

  _buildDebugOverlay() {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:8px;top:8px;padding:4px 8px;font:12px/1.4 monospace;color:#fff;background:rgba(0,0,0,.55);border-radius:4px;pointer-events:none;z-index:2;white-space:pre;';
    this.container.appendChild(el);
    this.debugEl = el;
  }

  // ----------------------------------------------------------------------------------
  // Events
  // ----------------------------------------------------------------------------------
  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push(() => target.removeEventListener(type, fn, opts));
  }

  _bindEvents() {
    const c = this.container;
    this._on(c, 'pointermove', (e) => this._onPointer(e), { passive: true });
    this._on(c, 'pointerdown', (e) => this._onPointer(e), { passive: true });
    this._on(c, 'pointerenter', (e) => this._onPointer(e), { passive: true });
    this._on(c, 'pointerleave', () => { this._pointerActive = false; }, { passive: true });
    this._on(c, 'pointercancel', () => { this._pointerActive = false; }, { passive: true });
    this._on(window, 'pointerup', (e) => { if (e.pointerType === 'touch') this._pointerActive = false; }, { passive: true });

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(c);

    if (this.config.pauseWhenHidden) {
      this._on(document, 'visibilitychange', () => {
        this._pageVisible = document.visibilityState !== 'hidden';
        this._clock.last = performance.now();
        if (this._pageVisible) this._loop();
      });
      this._io = new IntersectionObserver((entries) => {
        this._visible = entries[0]?.isIntersecting ?? true;
        this._clock.last = performance.now();
        if (this._visible) this._loop();
      }, { threshold: 0 });
      this._io.observe(c);
    }
    this._on(this.canvas, 'webglcontextlost', (e) => { e.preventDefault(); this._fail('WebGL context lost'); }, false);
  }

  _onPointer(e) {
    const r = this.canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this._pointerNDC.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this._pointerActive = true;
    this._updateCursorTarget();
  }

  _updateCursorTarget() {
    this.raycaster.setFromCamera(this._pointerNDC, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this._cursorTarget);
    if (!hit) this._pointerActive = false;
  }

  _size() {
    const r = this.container.getBoundingClientRect();
    return { width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
  }

  _resize() {
    if (!this.renderer) return;
    const { width, height } = this._size();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.config.dprCap));
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    if (this.camera.isOrthographicCamera) {
      // Contain the whole field (plus blade overhang) in the viewport, matching the shape's aspect;
      // the container should use the same aspect ratio to avoid letterboxing (see README).
      const [w, d] = this.config.fieldSize;
      const t = MathUtils.degToRad(this.config.camera.tilt ?? 8);
      const pad = this.config.camera.padding ?? 0.3;
      const spanX = w + pad * 2;
      const spanY = d * Math.cos(t) + this.config.bladeHeight[1] * Math.sin(t) + pad * 2;
      let halfW = spanX / 2, halfH = spanY / 2;
      if (aspect > spanX / spanY) halfW = halfH * aspect; else halfH = halfW / aspect;
      this.camera.left = -halfW; this.camera.right = halfW; this.camera.top = halfH; this.camera.bottom = -halfH;
    } else {
      this.camera.aspect = aspect;
    }
    this.camera.updateProjectionMatrix();
    this.post?.setSize(width, height);
  }

  // ----------------------------------------------------------------------------------
  // Frame loop
  // ----------------------------------------------------------------------------------
  _loop() {
    if (this.disposed || !this.ready) return;
    cancelAnimationFrame(this._raf);
    if (this.config.pauseWhenHidden && (!this._visible || !this._pageVisible)) return;
    this._raf = requestAnimationFrame(() => { this._frame(); this._loop(); });
  }

  _frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._clock.last) / 1000);
    this._clock.last = now;
    const u = this.uniforms;
    u.uTime.value = (now - this._clock.start) / 1000;

    // Cursor: smooth toward the raycast target, ease influence in/out on enter/leave.
    const cfg = this.config;
    const k = 1 - Math.pow(1 - cfg.cursor.smoothing, dt * 60);
    this._cursorPrev.copy(this._cursorSmoothed);
    this._cursorSmoothed.lerp(this._cursorTarget, k);
    const targetMix = this._pointerActive ? 1 : 0;
    this._cursorMix += (targetMix - this._cursorMix) * (1 - Math.pow(this._pointerActive ? 0.8 : 0.9, dt * 60));
    u.uCursorPos.value.copy(this._cursorSmoothed);
    u.uCursorStrength.value = cfg.cursor.strength * this._cursorMix;
    if (dt > 0) {
      const vx = (this._cursorSmoothed.x - this._cursorPrev.x) / dt;
      const vz = (this._cursorSmoothed.z - this._cursorPrev.z) / dt;
      this._cursorVel.lerp(this._velScratch.set(vx, vz).clampLength(0, 3), 0.25);
    }
    u.uCursorVel.value.copy(this._cursorVel);

    // Flowers
    this.flowerPool.update(now, this._pointerActive ? this._cursorSmoothed : null, this._pointerActive);

    if (!this._selfChecked) this._selfCheckRender();
    else this._render();

    if (this.debugEl) {
      const f = this._fps;
      f.frames++;
      if (now - f.t > 500) {
        f.value = Math.round((f.frames * 1000) / (now - f.t));
        f.frames = 0; f.t = now;
        const pr = this.post?.passes.probe?.stats;
        const probe = pr ? `\nprobe(${pr.samples} blocks): nan:${pr.nan}  hot:${pr.hot}  maxLum:${pr.maxLum.toFixed(2)}  thr:${cfg.post.bloomThreshold}` : '';
        this.debugEl.textContent =
          `${f.value} fps  blades:${this.bladeCount}  flowers:${this.flowerPool.liveCount}\n` +
          `post:${this.post ? 'on' : 'off'}  shadows:${cfg.shadows}  dpr:${this.renderer.getPixelRatio().toFixed(2)}${this.lowPower ? '  (low-power)' : ''}` + probe;
      }
    }
  }

  _render() {
    if (this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * First-frame GPU sanity check. Some drivers (Safari, some ANGLE/D3D configs) accept a
   * multisampled half-float composer target and then fail every draw into it, leaving a blank
   * canvas while JS keeps running. Render once, read the GL error state, and step down:
   * MSAA off -> post-processing off. Logs what it did.
   */
  _selfCheckRender() {
    this._selfChecked = true;
    const gl = this.renderer.getContext();
    const flush = () => { let n = 0; while (gl.getError() !== gl.NO_ERROR && n++ < 16); };
    const tryRender = () => { flush(); this._render(); return gl.getError(); };
    let err = tryRender();
    if (err === gl.NO_ERROR || !this.post) return;
    const hex = (e) => '0x' + e.toString(16);
    if (this.config.post.msaa > 0) {
      console.warn(`[grass-field] GL error ${hex(err)} on first frame; disabling MSAA on the post-processing target`);
      this.config.post.msaa = 0;
      this.post.dispose(); this._buildPost();
      err = tryRender();
      if (err === gl.NO_ERROR) return;
    }
    console.warn(`[grass-field] GL error ${hex(err)} persists; disabling post-processing (set post.enabled:false to skip this check)`);
    this.config.post.enabled = false;
    this.post.dispose(); this.post = null;
    flush(); this._render();
    this.container.dispatchEvent(new CustomEvent('grassfield:degraded', { detail: { glError: err } }));
  }

  // ----------------------------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------------------------
  /** Update tunables at runtime (wind, cursor, colours, exposure). Structural keys need a remount. */
  setOptions(partial) {
    const cfg = this.config = mergeConfig(this.config, partial);
    const u = this.uniforms;
    if (partial.wind) {
      u.uWindDir.value.fromArray(cfg.wind.direction).normalize();
      u.uWindSpeed.value = cfg.wind.speed; u.uWindStrength.value = cfg.wind.strength; u.uWindScale.value = cfg.wind.scale;
    }
    if (partial.cursor) u.uCursorRadius.value = cfg.cursor.radius;
    if (partial.flowers) { u.uFlowerRadius.value = cfg.flowers.radius; u.uFlowerStrength.value = cfg.flowers.strength; Object.assign(this.flowerPool.cfg, cfg.flowers); }
    if (partial.colors) {
      u.uRootColor.value.set(cfg.colors.root); u.uTipColor.value.set(cfg.colors.tip); u.uDryColor.value.set(cfg.colors.dry);
      u.uColorVariance.value = cfg.colors.variance; u.uRootAO.value = cfg.colors.rootAO;
      u.uSSSColor.value.set(cfg.colors.sss); u.uSSSStrength.value = cfg.colors.sssStrength; u.uSSSPower.value = cfg.colors.sssPower;
    }
    if (partial.toneMappingExposure !== undefined) this.renderer.toneMappingExposure = cfg.toneMappingExposure;
    if (partial.post) u.uBloomClamp.value.set(cfg.post.clampKnee, cfg.post.clampMax);
    if (partial.post && this.ready) { this.post?.dispose(); this._buildPost(); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this._raf);
    for (const off of this._listeners) off();
    this._listeners.length = 0;
    this._ro?.disconnect();
    this._io?.disconnect();
    this.post?.dispose();
    this.scene?.traverse((obj) => {
      obj.geometry?.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m?.dispose?.();
      obj.customDepthMaterial?.dispose?.();
      obj.userData?.normalMaterial?.dispose?.();
    });
    this.envTexture?.dispose();
    this.mask?.dispose();
    this.scene?.background?.dispose?.();
    if (this.sun?.shadow?.map) this.sun.shadow.map.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
    }
    this.debugEl?.remove();
    this.renderer = null;
    this.scene = null;
  }
}
