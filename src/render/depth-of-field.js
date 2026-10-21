import { NodeMaterial, QuadMesh } from 'three/webgpu';
import { float, orthographicDepthToViewZ, pass, perspectiveDepthToViewZ, select, uniform } from 'three/tsl';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { CONTROLS } from '../controls.js';

// Depth of field like a photo taken with a wide-open lens: the car is in focus and the world
// behind it softens with distance, so far streets and hills melt into the haze instead of
// drawing every window. By default only the far side blurs: the ground between the camera and the
// car is treated as in focus, so nothing in front of the car smears over it. With dofNear > 0 the
// near side blurs too (full at dofNear metres in front of the car), a narrow focus plane like a
// macro or tilt-shift shot. ?dof=0 switches it off, as do the panel's checkbox and the low graphics
// quality. ?dofrange=, ?dofstrength=, ?dofnear= override the saved settings for this page load.
//
// The scene is drawn into a render target, its depth turned into view-space distance (ortho or
// perspective, whichever camera is active), and three's bokeh DOF node blurs the far field.
const params = new URLSearchParams(globalThis.location?.search ?? '');
const FORCE_OFF = params.get('dof') === '0';
for (const [param, key] of [['dofrange', 'dofRange'], ['dofstrength', 'dofStrength'], ['dofnear', 'dofNear']]) {
  if (params.has(param) && Number.isFinite(Number(params.get(param)))) CONTROLS[key] = Number(params.get(param));
}
// Metres either side of the car's centre that stay sharp, so its nose, tail and the ground under
// it never soften.
const FOCUS_MARGIN = 4;

// `allowed()`: whether the graphics quality level draws it at all.
export function createDepthOfField(renderer, scene, camera, allowed = () => true) {
  const scenePass = pass(scene, camera);
  const depth = scenePass.getTextureNode('depth');
  const near = uniform(camera.near);
  const far = uniform(camera.far);
  const ortho = uniform(0);
  const viewZ = select(ortho.greaterThan(0.5), orthographicDepthToViewZ(depth, near, far), perspectiveDepthToViewZ(depth, near, far));

  const focus = uniform(30); // m along the view direction to the car
  const range = uniform(CONTROLS.dofRange); // m behind the sharp band to full blur
  const nearRange = uniform(0); // m in front of the sharp band to full blur; 0 = no near blur
  const strength = uniform(CONTROLS.dofStrength); // bokeh size
  // The distance the blur sees: the sharp band around the car squeezed to the focus, the near side
  // stretched so it reaches full blur at nearRange (the node has one range for both sides), or
  // pinned to the focus when near blur is off.
  const d = viewZ.negate().sub(focus);
  const behind = d.sub(FOCUS_MARGIN).max(0);
  const before = d.negate().sub(FOCUS_MARGIN).max(0);
  const nearScale = select(nearRange.greaterThan(0), range.div(nearRange.max(0.01)), float(0));
  const shaped = focus.add(behind).sub(before.mul(nearScale)).negate();
  // Drawn as a plain full-screen quad rather than through a RenderPipeline: the quad lands in the
  // renderer's usual output buffer (tone mapped and converted on the way to the canvas), so the
  // HUD drawn after it stacks on top as before. A RenderPipeline writes the canvas directly, and
  // the HUD's own pass then copied its buffer over it.
  const material = new NodeMaterial();
  material.fragmentNode = dof(scenePass, shaped, focus, range, strength);
  const quad = new QuadMesh(material);

  return {
    // Whether this frame goes through the blur (the plain renderer.render is cheaper when off).
    get enabled() {
      return !FORCE_OFF && CONTROLS.depthOfField && CONTROLS.dofStrength > 0 && allowed();
    },
    // distance: metres from the camera to the car along the view direction.
    render(activeCamera, distance) {
      scenePass.camera = activeCamera;
      near.value = activeCamera.near;
      far.value = activeCamera.far;
      ortho.value = activeCamera.isOrthographicCamera ? 1 : 0;
      focus.value = distance;
      range.value = Math.max(1, CONTROLS.dofRange);
      nearRange.value = Math.max(0, CONTROLS.dofNear);
      strength.value = CONTROLS.dofStrength;
      quad.render(renderer);
    },
  };
}
