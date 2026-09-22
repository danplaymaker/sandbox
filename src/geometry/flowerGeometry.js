import { BufferGeometry, Float32BufferAttribute } from 'three';

/**
 * Low-poly flower, authored in its OPEN pose: stem (crossed quads, 0..1 tall),
 * 6 petals radiating flat from y=1, a small centre disc and one leaf.
 * `aPart` per vertex: x = part id (0 stem, 1 petal, 2 centre, 3 leaf), y = radial t.
 * The vertex shader blends toward a closed bud / wilted pose from this.
 */
export function createFlowerGeometry({ petals = 6, petalLength = 0.16, petalWidth = 0.075, stemWidth = 0.022 } = {}) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const parts = [];
  const indices = [];
  let vi = 0;

  const pushV = (x, y, z, nx, ny, nz, u, v, part, pt) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
    parts.push(part, pt);
    return vi++;
  };

  // ---- stem: two crossed strips with 4 segments so it can droop --------------------
  const stemSegs = 4;
  for (let k = 0; k < 2; k++) {
    const ang = k * Math.PI * 0.5;
    const dx = Math.cos(ang) * stemWidth * 0.5;
    const dz = Math.sin(ang) * stemWidth * 0.5;
    const nx = -Math.sin(ang), nz = Math.cos(ang);
    const base = vi;
    for (let s = 0; s <= stemSegs; s++) {
      const y = s / stemSegs;
      const w = 1 - 0.35 * y; // slightly thinner at the top
      pushV(-dx * w, y, -dz * w, nx, 0, nz, 0, y, 0, y);
      pushV(dx * w, y, dz * w, nx, 0, nz, 1, y, 0, y);
    }
    for (let s = 0; s < stemSegs; s++) {
      const a = base + s * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  // ---- petals: each a 2-segment strip from the centre outward ----------------------
  for (let p = 0; p < petals; p++) {
    const ang = (p / petals) * Math.PI * 2;
    const cx = Math.cos(ang), cz = Math.sin(ang);
    const px = -cz, pz = cx; // perpendicular (width) direction
    const base = vi;
    const segs = 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const r = 0.02 + t * petalLength;
      // petal outline: narrow at base, widest at 60%, rounded tip
      const hw = petalWidth * 0.5 * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.9));
      pushV(cx * r - px * hw, 1, cz * r - pz * hw, 0, 1, 0, 0, t, 1, t);
      pushV(cx * r + px * hw, 1, cz * r + pz * hw, 0, 1, 0, 1, t, 1, t);
    }
    for (let s = 0; s < segs; s++) {
      const a = base + s * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  // ---- centre disc ------------------------------------------------------------------
  const centreR = 0.035;
  const cIdx = pushV(0, 1.012, 0, 0, 1, 0, 0.5, 0.5, 2, 0);
  const ring = [];
  const N = 8;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    ring.push(pushV(Math.cos(a) * centreR, 1.008, Math.sin(a) * centreR, 0, 1, 0, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5, 2, 1));
  }
  for (let i = 0; i < N; i++) indices.push(cIdx, ring[(i + 1) % N], ring[i]);

  // ---- one leaf on the stem -----------------------------------------------------------
  {
    const base = vi;
    const ly = 0.42;
    const ang = 0.9;
    const cx = Math.cos(ang), cz = Math.sin(ang);
    const px = -cz, pz = cx;
    const segs = 2, len = 0.14, wid = 0.05;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const r = t * len;
      const hw = wid * 0.5 * Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.9));
      const y = ly + t * 0.05;
      pushV(cx * r - px * hw, y, cz * r - pz * hw, 0, 1, 0, 0, t, 3, t);
      pushV(cx * r + px * hw, y, cz * r + pz * hw, 0, 1, 0, 1, t, 3, t);
    }
    for (let s = 0; s < segs; s++) {
      const a = base + s * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aPart', new Float32BufferAttribute(parts, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}
