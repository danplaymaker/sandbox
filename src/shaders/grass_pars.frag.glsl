uniform vec3  uRootColor;
uniform vec3  uTipColor;
uniform vec3  uDryColor;       // hue drift toward straw for some blades
uniform float uColorVariance;  // 0..1 amount of per-instance hue noise
uniform float uRootAO;         // 0..1 darkness at the root (fake inter-blade occlusion)
uniform vec3  uSSSColor;       // translucency tint (backlit glow)
uniform float uSSSStrength;
uniform float uSSSPower;

varying float vHeight;
varying float vColorSeed;
varying float vBend;
varying vec3  vWorldRoot;
