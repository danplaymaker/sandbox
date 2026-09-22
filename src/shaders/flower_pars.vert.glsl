// Flower-specific vertex helpers. Requires field_pars.vert.glsl first.
// Per-instance animation state, updated from JS each frame: (bloom 0..1, wilt 0..1, seed, colourIndex)
attribute vec4 aFlowerState;
// Per-vertex: x = part (0 stem, 1 petal, 2 centre, 3 leaf), y = radial t along petal (0 base .. 1 tip)
attribute vec2 aPart;

varying float vPart;
varying float vColorIdx;
varying float vWilt;
varying float vPetalT;

struct FlowerPose { vec3 pos; vec3 nrm; };

FlowerPose poseFlower(vec3 pos, vec3 nrm) {
  FlowerPose fp;
  float bloom = aFlowerState.x;
  float wilt  = aFlowerState.y;
  float seed  = aFlowerState.z;
  float part  = aPart.x;

  float grow = smoothstep(0.0, 0.55, bloom);           // stem shoots up first
  float open = smoothstep(0.3, 1.0, bloom) * (1.0 - wilt * 0.6); // then the head unfolds
  float headScale = smoothstep(0.2, 1.0, bloom) * (1.0 - wilt * 0.35);

  vec3 p = pos;
  vec3 n = nrm;

  if (part < 0.5) {
    // Stem: grows in height, thickens slightly with bloom.
    p.y *= grow;
    p.xz *= 0.6 + 0.4 * grow;
  } else if (part < 2.5) {
    // Head (petals + centre): sits at the top of the stem (local y = 1).
    vec3 rel = p - vec3(0.0, 1.0, 0.0);
    float r = length(rel.xz);
    vec2 dir = r > 1e-4 ? rel.xz / r : vec2(0.0);
    if (part < 1.5) {
      // Petal: blend between closed bud (pointing up) and open (flat with a gentle curl).
      vec3 closed = vec3(dir * r * 0.18, 0.05 + r * 0.95);
      vec3 opened = vec3(dir * r, rel.y + r * r * 0.9);   // curl upward at the tip
      rel = mix(closed, opened, open);
      n = normalize(mix(vec3(dir.x, 0.25, dir.y), n, open));
    }
    rel *= headScale;
    p = vec3(0.0, grow, 0.0) + rel;
  } else {
    // Leaf: appears with growth, hangs off the stem.
    p.y *= grow;
    p.xz *= grow;
  }

  // Wilting: the whole head droops toward one side and sinks.
  float droopDir = seed * 6.2831;
  float droop = wilt * wilt;
  if (part > 0.5 && part < 2.5) {
    p.xz += vec2(cos(droopDir), sin(droopDir)) * droop * 0.45;
    p.y  -= droop * 0.35;
  } else if (part < 0.5) {
    float ty = p.y;
    p.xz += vec2(cos(droopDir), sin(droopDir)) * droop * 0.45 * ty * ty;
    p.y  -= droop * 0.35 * ty * ty;
  }

  fp.pos = p;
  fp.nrm = n;
  return fp;
}

// World-space sway (wind) applied to the top of the flower, converted to local space.
vec3 flowerSwayLocal(float y) {
  mat3 im = mat3(instanceMatrix);
  float s2 = dot(im[0], im[0]);
  if (s2 < 1e-8 || aFlowerState.x <= 0.0) return vec3(0.0); // parked / dead slot: no sway, no divide
  vec3 root = instanceMatrix[3].xyz;
  vec2 wind = windAt(root.xz, aFlowerState.z * 10.0) * 0.35;
  vec2 cursor = cursorPushAt(root.xz) * 0.25;
  vec2 d = (wind + cursor) * y * y;
  return (transpose(im) * vec3(d.x, 0.0, d.y)) / s2;
}
