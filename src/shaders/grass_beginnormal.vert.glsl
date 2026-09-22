// Replaces <beginnormal_vertex> in the lit grass material: compute the bend once and
// tilt the normal along it so lighting follows the curvature.
vec3 objectNormal = vec3(normal);
#ifdef USE_INSTANCING
  #define GRASS_BEND_COMPUTED
  Bend gBend = computeBend(position, uv, aBladeData);
  objectNormal = normalize(objectNormal + gBend.dir * gBend.amount * 0.6);
#endif
