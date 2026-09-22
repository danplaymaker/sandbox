// Replaces <begin_vertex> in the grass material AND its shadow-depth material.
// Bends the blade in LOCAL space so three.js's own instancing/shadow/env code keeps working.
vec3 transformed = vec3(position);
#ifdef USE_INSTANCING
  #ifndef GRASS_BEND_COMPUTED
    Bend gBend = computeBend(position, uv, aBladeData);
  #endif
  transformed.xz += gBend.localDisp.xz;
  transformed.y = gBend.newY;
  vHeight = uv.y;
  vColorSeed = aBladeData.z;
  vBend = gBend.amount;
  vWorldRoot = gBend.root;
#else
  vHeight = uv.y;
  vColorSeed = 0.5;
  vBend = 0.0;
  vWorldRoot = vec3(0.0);
#endif
