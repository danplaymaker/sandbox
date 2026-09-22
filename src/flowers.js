import { Matrix4, Quaternion, Vector3 } from 'three';

/**
 * Fixed-size pool of flower slots. Slots are reused (never allocated at runtime).
 * Each frame `update()` advances bloom/wilt timers and writes:
 *   - `states` (Float32Array, 4 per slot) -> instanced attribute for the flower mesh
 *   - `uniformArray` (Vector4[]) -> uFlowers uniform shared with the grass shader
 */
export class FlowerPool {
  constructor(cfg, rng, mesh, uniformArray, states, canSpawn = null) {
    this.canSpawn = canSpawn;
    this.cfg = cfg;
    this.rng = rng;
    this.mesh = mesh;
    this.uniformArray = uniformArray;
    this.max = Math.min(cfg.max, 16);
    this.slots = [];
    for (let i = 0; i < this.max; i++) {
      this.slots.push({ alive: false, x: 0, z: 0, t0: 0, phase: 'dead', phaseT0: 0, bloom: 0, wilt: 0, seed: 0, color: 0, scale: 1 });
    }
    this.states = states; // backing array of the mesh's `aFlowerState` attribute
    this.lastSpawnAt = -Infinity;
    this.hoverStart = null;
    this._m = new Matrix4();
    this._q = new Quaternion();
    this._p = new Vector3();
    this._s = new Vector3();
    this._up = new Vector3(0, 1, 0);
  }

  /** Called with the smoothed cursor ground position each frame (or null when the pointer is outside). */
  update(now, cursor, pointerActive) {
    const cfg = this.cfg;

    // ---- spawning ----------------------------------------------------------------
    if (cfg.enabled && pointerActive && cursor) {
      if (this.hoverStart === null) this.hoverStart = now;
      const dwelled = now - this.hoverStart >= cfg.dwellMs;
      const cooled = now - this.lastSpawnAt >= cfg.spawnInterval;
      const allowed = !this.canSpawn || this.canSpawn(cursor.x, cursor.z);
      if (dwelled && cooled && allowed && this._farFromLive(cursor.x, cursor.z, cfg.spacing)) {
        this._spawn(now, cursor.x, cursor.z);
      }
    } else {
      this.hoverStart = null;
    }

    // ---- animate -------------------------------------------------------------------
    for (let i = 0; i < this.max; i++) {
      const s = this.slots[i];
      if (s.alive) {
        const near = pointerActive && cursor && Math.hypot(cursor.x - s.x, cursor.z - s.z) < cfg.holdRadius;
        const dt = now - s.phaseT0;
        if (s.phase === 'bloom') {
          s.bloom = easeOutBack(Math.min(1, dt / cfg.bloomMs));
          if (dt >= cfg.bloomMs) { s.phase = 'hold'; s.phaseT0 = now; s.bloom = 1; }
        } else if (s.phase === 'hold') {
          if (near) s.phaseT0 = now;           // keep it open while the cursor lingers
          else if (dt >= cfg.holdMs) { s.phase = 'wilt'; s.phaseT0 = now; }
        } else if (s.phase === 'wilt') {
          const k = Math.min(1, dt / cfg.wiltMs);
          s.wilt = easeInOutCubic(k);
          s.bloom = 1 - Math.pow(k, 3) * 0.999;  // shrink away at the very end
          if (k >= 1) { s.alive = false; s.phase = 'dead'; s.bloom = 0; s.wilt = 0; }
        }
      }
      const i4 = i * 4;
      const b = s.alive ? s.bloom : 0;
      this.states[i4 + 0] = b;
      this.states[i4 + 1] = s.alive ? s.wilt : 0;
      this.states[i4 + 2] = s.seed;
      this.states[i4 + 3] = s.color;
      // Grass yields to the flower while it is up; ease off as it wilts.
      const u = this.uniformArray[i];
      u.set(s.x, s.z, s.alive ? b * (1 - s.wilt * 0.7) : 0, s.seed);
    }
    this.mesh.geometry.getAttribute('aFlowerState').needsUpdate = true;
  }

  _farFromLive(x, z, spacing) {
    for (const s of this.slots) {
      if (s.alive && s.phase !== 'wilt' && Math.hypot(s.x - x, s.z - z) < spacing) return false;
    }
    return true;
  }

  _spawn(now, x, z) {
    // Reuse a dead slot; if none, recycle the oldest wilting one; else skip.
    let slot = this.slots.find((s) => !s.alive);
    if (!slot) {
      slot = this.slots.filter((s) => s.phase === 'wilt').sort((a, b) => a.t0 - b.t0)[0];
      if (!slot) return;
    }
    const rng = this.rng;
    const jitter = 0.12;
    slot.alive = true;
    slot.x = x + (rng() - 0.5) * jitter;
    slot.z = z + (rng() - 0.5) * jitter;
    slot.t0 = now;
    slot.phase = 'bloom';
    slot.phaseT0 = now;
    slot.bloom = 0;
    slot.wilt = 0;
    slot.seed = rng();
    slot.color = Math.floor(rng() * 4);
    const [h0, h1] = this.cfg.height;
    slot.scale = h0 + (h1 - h0) * rng();
    this.lastSpawnAt = now;

    const idx = this.slots.indexOf(slot);
    this._p.set(slot.x, 0, slot.z);
    this._q.setFromAxisAngle(this._up, rng() * Math.PI * 2);
    this._s.setScalar(slot.scale);
    this._m.compose(this._p, this._q, this._s);
    this.mesh.setMatrixAt(idx, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Force every flower to start wilting (e.g. pointer left the canvas). */
  releaseAll(now) {
    for (const s of this.slots) {
      if (s.alive && s.phase === 'hold') { s.phase = 'wilt'; s.phaseT0 = now; }
    }
  }

  get liveCount() { return this.slots.filter((s) => s.alive).length; }
}

function easeOutBack(t) {
  const c1 = 1.4, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
