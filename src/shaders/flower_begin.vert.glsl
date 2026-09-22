vec3 transformed = vec3(position);
#ifdef USE_INSTANCING
  #ifndef FLOWER_POSE_COMPUTED
    FlowerPose gPose = poseFlower(position, normal);
  #endif
  transformed = gPose.pos;
  transformed += flowerSwayLocal(clamp(transformed.y, 0.0, 1.2));
  vPart = aPart.x;
  vPetalT = aPart.y;
  vColorIdx = aFlowerState.w;
  vWilt = aFlowerState.y;
#else
  vPart = aPart.x;
  vPetalT = aPart.y;
  vColorIdx = 0.0;
  vWilt = 0.0;
#endif
