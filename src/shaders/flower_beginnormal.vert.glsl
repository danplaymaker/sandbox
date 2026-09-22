vec3 objectNormal = vec3(normal);
#ifdef USE_INSTANCING
  #define FLOWER_POSE_COMPUTED
  FlowerPose gPose = poseFlower(position, normal);
  objectNormal = gPose.nrm;
#endif
