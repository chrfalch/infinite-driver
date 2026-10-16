import { NodeMaterial, QuadMesh } from 'three/webgpu';
import { orthographicDepthToViewZ, pass, perspectiveDepthToViewZ, select, uniform } from 'three/tsl';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { CONTROLS } from '../controls.js';

// Depth of field like a photo taken with a wide-open lens: the car is in focus and the world
// behind it softens with distance, so far streets and hills melt into the haze instead of
// drawing every window. Only the far side blurs: the ground between the camera and the car is
// treated as in focus (its depth is clamped to the focus distance), so nothing in front of the car
// smears over it. ?dof=0 switches it off, as do the panel's checkbox and the low graphics quality.
//
// The scene is drawn into a render target, its depth turned into view-space distance (ortho or
// perspective, whichever camera is active), and three's bokeh DOF node blurs the far field.
const params = new URLSearchParams(globalThis.location?.search ?? '');
const FORCE_OFF = params.get('dof') === '0';
// Metres behind the car that stay sharp, so its tail and the ground under it never soften.
const FOCUS_MARGIN = 4;

// `allowed()`: whether the graphics quality level draws it at all.
export function createDepthOfField(renderer, scene, camera, allowed = () => true) {
  const scenePass = pass(scene, camera);
  const depth = scenePass.getTextureNode('depth');
  const near = uniform(camera.near);
  const far = uniform(camera.far);
  const ortho = uniform(0);
  const viewZ = select(ortho.greaterThan(0.5), orthographicDepthToViewZ(depth, near, far), perspectiveDepthToViewZ(depth, near, far));

  const focus = uniform(30); // m along the view direction to the car, plus the margin
  const range = uniform(CONTROLS.dofRange); // m behind the focus to full blur
  const strength = uniform(CONTROLS.dofStrength); // bokeh size
  // Nearer than the focus counts as at the focus: no near-field blur.
  const farOnly = viewZ.min(focus.negate());
  // Drawn as a plain full-screen quad rather than through a RenderPipeline: the quad lands in the
  // renderer's usual output buffer (tone mapped and converted on the way to the canvas), so the
  // HUD drawn after it stacks on top as before. A RenderPipeline writes the canvas directly, and
  // the HUD's own pass then copied its buffer over it.
  const material = new NodeMaterial();
  material.fragmentNode = dof(scenePass, farOnly, focus, range, strength);
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
      focus.value = distance + FOCUS_MARGIN;
      range.value = Math.max(1, CONTROLS.dofRange);
      strength.value = CONTROLS.dofStrength;
      quad.render(renderer);
    },
  };
}
