import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  OrthographicCamera,
  PerspectiveCamera,
  PCFSoftShadowMap,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';

export const VIEW_HEIGHT = 22; // metres visible vertically at zoom 1
// Ground depth per metre of screen height: 1 / sin(35.26 deg) for the isometric view.
const SHADOW_DEPTH_STRETCH = 1.75;

export async function createRenderer(container) {
  const renderer = new WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.autoClear = false;
  container.append(renderer.domElement);
  await renderer.init();

  const scene = new Scene();
  const sky = new Color('#e9e2d3');
  scene.background = sky;
  scene.fog = new Fog(sky, 125, 210);

  scene.add(new HemisphereLight('#fff6e8', '#6f7d5e', 0.9));
  const sun = new DirectionalLight('#fff1dc', 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 130 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  // Low, tilted views switch to a perspective camera so the horizon and backdrop show (see
  // followCamera); the orthographic camera keeps the isometric look for everything else.
  const perspective = new PerspectiveCamera(38, 1, 0.3, 2500);

  // The shadow box follows the car (see followCamera) and is only as big as the visible ground:
  // the circle around the screen's footprint on the ground, which is stretched in depth because the
  // isometric view looks down at about 35 degrees. Smaller box: sharper shadows, fewer casters.
  const fitShadow = sun.shadow.updateMatrices.bind(sun.shadow);
  sun.shadow.updateMatrices = (light) => {
    const halfW = (camera.right - camera.left) / 2 / camera.zoom;
    const halfH = (camera.top - camera.bottom) / 2 / camera.zoom;
    const r = Math.min(60, Math.max(12, Math.hypot(halfW, halfH * SHADOW_DEPTH_STRETCH) + 3));
    const box = sun.shadow.camera;
    if (Math.abs(box.right - r) > 0.25) {
      Object.assign(box, { left: -r, right: r, top: r, bottom: -r });
      box.updateProjectionMatrix();
    }
    fitShadow(light);
  };

  // Screen-space HUD in CSS pixels, origin at the top-left corner.
  const hudScene = new Scene();
  const hudCamera = new OrthographicCamera(0, 1, 0, -1, -10, 10);

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.left = (-VIEW_HEIGHT * aspect) / 2;
    camera.right = (VIEW_HEIGHT * aspect) / 2;
    camera.top = VIEW_HEIGHT / 2;
    camera.bottom = -VIEW_HEIGHT / 2;
    camera.updateProjectionMatrix();
    perspective.aspect = aspect;
    perspective.updateProjectionMatrix();
    hudCamera.right = w;
    hudCamera.bottom = -h;
    hudCamera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  return { renderer, scene, camera, perspective, activeCamera: camera, sun, hudScene, hudCamera, resize };
}
