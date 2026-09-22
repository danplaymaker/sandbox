// Appended after <lights_fragment_end>: cheap subsurface / back-scatter so blades glow when backlit.
#if NUM_DIR_LIGHTS > 0
{
  // Light direction in view space (points toward the light).
  vec3 L = normalize(directionalLights[0].direction);
  vec3 V = geometryViewDir;
  // Light coming through the blade toward the viewer: strongest when looking into the sun through the blade.
  float backlit = pow(saturate(dot(V, -L)), uSSSPower);
  // Thin blades scatter regardless of normal; bias toward the thinner, brighter tip.
  float thin = 0.35 + 0.65 * vHeight;
  vec3 sss = uSSSColor * directionalLights[0].color * backlit * thin * uSSSStrength;
  reflectedLight.directDiffuse += sss * diffuseColor.rgb;
  // Ambient translucency from the environment (tips catch skylight from behind).
  reflectedLight.indirectDiffuse += uSSSColor * 0.12 * uSSSStrength * vHeight * diffuseColor.rgb;
}
#endif
