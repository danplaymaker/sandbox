// Grass-specific vertex helpers. Requires field_pars.vert.glsl to be included first.

struct Bend {
  vec3  localDisp;  // XZ displacement in blade-local space
  float newY;       // adjusted height after bending
  float amount;     // 0..1 how far this vertex bent
  vec3  dir;        // unit bend direction (local)
  float yield;      // 0..1 flower influence
  vec3  root;       // world root position
};

Bend computeBend(vec3 pos, vec2 texcoord, vec4 bladeData) {
  Bend b;
  mat3 im = mat3(instanceMatrix);
  float s2 = dot(im[0], im[0]);              // uniform scale^2 baked into the instance matrix
  b.root = instanceMatrix[3].xyz;            // world-space root position
  float t = texcoord.y;                      // 0 at root, 1 at tip
  float stiffness = bladeData.y;

  // ---- world-space displacement -------------------------------------------------
  vec2 wind = windAt(b.root.xz, bladeData.x);
  vec2 cursor = cursorPushAt(b.root.xz);
  float yield;
  vec2 flower = flowerPushAt(b.root.xz, yield);

  // Static lean gives each blade an individual resting pose.
  vec2 lean = vec2(sin(bladeData.x * 6.2831), cos(bladeData.x * 3.7)) * 0.05;

  vec2 dispW = (wind + lean) * (1.0 - stiffness * 0.5) + cursor + flower;

  // Displacement grows quadratically toward the tip: root pinned, tip swings most.
  float w = t * t;
  vec2 tipDisp = dispW * w;

  // ---- world displacement -> local blade space --------------------------------------
  // instanceMatrix = T * R * S with uniform S: inverse rotation is transpose / s^2.
  vec3 localDisp = (transpose(im) * vec3(tipDisp.x, 0.0, tipDisp.y)) / s2;

  // Preserve blade length: lower the vertex as it swings out (sqrt(y^2 - d^2)).
  float y = pos.y;
  float dLocal = length(localDisp);
  float maxD = max(y, 1e-3);
  if (dLocal > maxD) { localDisp *= maxD / dLocal; dLocal = maxD; }
  float newY = sqrt(max(y * y - dLocal * dLocal, 0.0));

  // Extra crush: blades directly under the cursor / a flower get pressed down.
  float crush = clamp(length(cursor) / max(uCursorStrength, 1e-3), 0.0, 1.0) * 0.35 + yield * 0.25;
  newY *= 1.0 - crush * w;

  b.localDisp = localDisp;
  b.newY = newY;
  b.amount = clamp(dLocal / maxD, 0.0, 1.0);
  b.dir = dLocal > 1e-5 ? localDisp / dLocal : vec3(0.0);
  b.yield = yield;
  return b;
}
