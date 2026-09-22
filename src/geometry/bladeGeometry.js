import { BufferGeometry, Float32BufferAttribute } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * One low-poly grass blade: 1 unit tall, tapered, gently curved forward, with a
 * centre crease (3 verts per row) so it catches light like a folded leaf.
 * uv.y runs 0 (root) .. 1 (tip) and drives the bend weight in the vertex shader.
 */
export function createBladeGeometry({ segments = 5, width = 0.045, curve = 0.12, crease = 0.25, cross = false } = {}) {
  const single = createSinglePlane({ segments, width, curve, crease });
  if (!cross) return single;
  // Cross-plane fallback for straight-down views: a second copy rotated 90° about Y so there is
  // always a visible cross-section from above. Doubles the triangle count per blade.
  const other = single.clone().rotateY(Math.PI / 2);
  const merged = mergeGeometries([single, other], false);
  single.dispose(); other.dispose();
  merged.computeBoundingSphere();
  return merged;
}

function createSinglePlane({ segments, width, curve, crease }) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const rows = segments + 1;
  for (let r = 0; r < rows; r++) {
    const t = r / segments;
    const y = t;
    // Tapered width: full at the base, ~0 at the tip.
    const halfW = (width * 0.5) * (1 - Math.pow(t, 1.6)) * (1 - 0.15 * t);
    // Gentle forward curvature (z) increasing toward the tip.
    const z = curve * t * t;
    const isTip = r === rows - 1;

    if (isTip) {
      positions.push(0, y, z + width * 0.3);
      normals.push(0, 0.2, 1);
      uvs.push(0.5, t);
    } else {
      // left, centre (pushed back for the crease), right
      positions.push(-halfW, y, z);
      positions.push(0, y, z - crease * halfW * 2.0);
      positions.push(halfW, y, z);
      // normals: face +z with the crease tilting the sides
      normals.push(-crease, 0, 1, 0, 0, 1, crease, 0, 1);
      uvs.push(0, t, 0.5, t, 1, t);
    }
  }

  // Index: rows 0..segments-1 have 3 verts; last row (tip) has 1.
  const rowStart = (r) => r * 3;
  for (let r = 0; r < segments; r++) {
    const a = rowStart(r);
    const nextIsTip = r + 1 === segments;
    if (!nextIsTip) {
      const b = rowStart(r + 1);
      // left quad
      indices.push(a, a + 1, b, a + 1, b + 1, b);
      // right quad
      indices.push(a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
    } else {
      const tip = rowStart(segments);
      indices.push(a, a + 1, tip, a + 1, a + 2, tip);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.normalizeNormals();
  geo.computeBoundingSphere();
  return geo;
}
