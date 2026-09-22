// Soft luminance clamp applied to the HDR output of the grass/flower materials before
// post-processing. Thin, wind-blown blades produce sub-pixel specular hits that change every
// frame; unclamped they cross the bloom threshold intermittently and the glow flickers.
// Below the knee the colour is untouched; above it luminance rolls off toward uBloomClamp.y.
uniform vec2 uBloomClamp; // x = knee (start of roll-off), y = ceiling
vec3 softClampLuminance(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (l <= uBloomClamp.x) return c;
  float range = max(uBloomClamp.y - uBloomClamp.x, 1e-3);
  float over = l - uBloomClamp.x;
  float nl = uBloomClamp.x + range * (over / (over + range));
  return c * (nl / l);
}
