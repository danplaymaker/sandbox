// Shared uniforms/attributes for anything that lives in the wind field (grass + flowers).
// Injected into the vertex shader "pars" section of MeshPhysicalMaterial / MeshDepthMaterial.
uniform float uTime;
uniform vec2  uWindDir;       // normalised XZ direction
uniform float uWindSpeed;
uniform float uWindStrength;  // tip displacement in world units at full gust
uniform float uWindScale;     // noise frequency (1 / metres)

uniform vec3  uCursorPos;     // world-space point on the ground plane
uniform float uCursorRadius;
uniform float uCursorStrength;
uniform vec2  uCursorVel;     // smoothed pointer velocity on the ground (XZ)

#define MAX_FLOWERS 16
uniform vec4  uFlowers[MAX_FLOWERS]; // x, z, bloom (0..1), seed
uniform float uFlowerRadius;
uniform float uFlowerStrength;

// Per-instance: (phase, stiffness, colourSeed, heightFrac)
attribute vec4 aBladeData;

varying float vHeight;     // 0 root .. 1 tip
varying float vColorSeed;
varying float vBend;       // 0..1 how much this vertex was displaced (used for shading)
varying vec3  vWorldRoot;

// Returns the wind displacement (world XZ) for a blade rooted at `root`.
vec2 windAt(vec2 root, float phase) {
  vec2 flow = uWindDir * uTime * uWindSpeed;
  float gust   = snoise(root * uWindScale        - flow);              // large gust fronts
  float ripple = snoise(root * uWindScale * 4.0  - flow * 2.3 + phase); // small ripples
  float w = gust * 0.75 + ripple * 0.35;
  w = w * 0.5 + 0.5;                                                     // bias: wind rarely pushes backwards
  vec2 side = vec2(-uWindDir.y, uWindDir.x);
  return (uWindDir * w + side * ripple * 0.25) * uWindStrength;
}

// Radial push away from the cursor. Falloff is quadratic so the centre parts hard and the rim is soft.
vec2 cursorPushAt(vec2 root) {
  vec2 to = root - uCursorPos.xz;
  float d = length(to);
  float f = 1.0 - smoothstep(0.0, uCursorRadius, d);
  f *= f;
  vec2 dir = d > 1e-4 ? to / d : vec2(0.0, 1.0);
  // blend radial push with the direction the pointer is moving (wake effect)
  vec2 wake = uCursorVel * 0.35;
  return (dir + wake) * f * uCursorStrength;
}

// Push away from every blooming flower, scaled by its bloom progress.
vec2 flowerPushAt(vec2 root, out float yield) {
  vec2 push = vec2(0.0);
  yield = 0.0;
  for (int i = 0; i < MAX_FLOWERS; i++) {
    vec4 fl = uFlowers[i];
    if (fl.z <= 0.001) continue;
    vec2 to = root - fl.xy;
    float d = length(to);
    float r = uFlowerRadius * (0.35 + 0.65 * fl.z);
    float f = 1.0 - smoothstep(0.0, r, d);
    f *= f;
    vec2 dir = d > 1e-4 ? to / d : vec2(1.0, 0.0);
    push += dir * f * fl.z * uFlowerStrength;
    yield = max(yield, f * fl.z);
  }
  return push;
}
