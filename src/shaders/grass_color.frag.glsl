// Replaces <color_fragment>: per-instance / per-height colour before lighting.
{
  float h = vHeight;
  // Root -> tip gradient, pushed toward the tip so most of the blade is mid-green.
  vec3 c = mix(uRootColor, uTipColor, pow(h, 1.4));
  // Some blades drift toward straw/yellow using the per-instance seed.
  float dry = smoothstep(0.55, 1.0, vColorSeed) * uColorVariance;
  c = mix(c, uDryColor, dry * (0.35 + 0.65 * h));
  // Subtle hue noise across the field.
  float hueN = (vColorSeed - 0.5) * 2.0 * uColorVariance;
  c *= vec3(1.0 + hueN * 0.18, 1.0 + hueN * 0.06, 1.0 - hueN * 0.12);
  // Fake inter-blade occlusion: roots live in the dark.
  c *= mix(1.0 - uRootAO, 1.0, smoothstep(0.0, 0.75, h));
  // Bent blades expose lighter undersides.
  c *= 1.0 + vBend * 0.12;
  diffuseColor.rgb *= c;
}
