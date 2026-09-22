#ifdef GROUND_SHAPE_CLIP
{
  // Keep soil only inside the shape, with the same feathered + noise-jittered edge the blades use.
  vec2 uvm = vGroundWorld.xz / uFieldSize + 0.5;
  float m = texture2D(uShapeMask, uvm).r;
  vec2 np = vGroundWorld.xz * uShapeParams.w;
  float n = (snoise(np + vec2(31.0, 17.0)) * 0.6 + snoise(np * 2.0 + 5.0) * 0.4) * 0.5 * uShapeParams.z;
  float edge = smoothstep(uShapeParams.x - uShapeParams.y, uShapeParams.x + uShapeParams.y, m + n);
  if (edge < 0.45) discard;
}
#endif
{
  // Mottled soil: layered noise so the ground is not a flat colour between blade clusters.
  vec2 p = vGroundWorld.xz * uGroundScale;
  float n = snoise(p) * 0.5 + snoise(p * 3.1 + 7.0) * 0.3 + snoise(p * 9.7 + 3.0) * 0.2;
  n = n * 0.5 + 0.5;
  diffuseColor.rgb *= mix(uGroundColorA, uGroundColorB, n);
}
