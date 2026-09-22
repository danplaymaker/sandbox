{
  vec3 c;
  if (vPart < 0.5 || vPart > 2.5) {
    c = uStemColor * (0.8 + 0.2 * vPetalT);
  } else if (vPart < 1.5) {
    int idx = int(clamp(vColorIdx + 0.5, 0.0, 3.0));
    vec3 petal = uPetalColors[idx];
    // Darker/saturated toward the base, paler toward the petal tip.
    c = mix(petal * 0.75, mix(petal, vec3(1.0), 0.35), smoothstep(0.1, 0.9, vPetalT));
  } else {
    c = uCenterColor;
  }
  // Wilting drains saturation and browns the flower.
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(lum) * vec3(0.55, 0.42, 0.28), vWilt * 0.8);
  diffuseColor.rgb *= c;
}
