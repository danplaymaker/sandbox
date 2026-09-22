{
  // Mottled soil: layered noise so the ground is not a flat colour between blade clusters.
  vec2 p = vGroundWorld.xz * uGroundScale;
  float n = snoise(p) * 0.5 + snoise(p * 3.1 + 7.0) * 0.3 + snoise(p * 9.7 + 3.0) * 0.2;
  n = n * 0.5 + 0.5;
  diffuseColor.rgb *= mix(uGroundColorA, uGroundColorB, n);
}
