import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  OrthographicCamera,
  PCFSoftShadowMap,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';

export const VIEW_HEIGHT = 22; // metres visible vertically at zoom 1

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
  const s = 45;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 160 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);

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
    hudCamera.right = w;
    hudCamera.bottom = -h;
    hudCamera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  return { renderer, scene, camera, sun, hudScene, hudCamera, resize };
}
