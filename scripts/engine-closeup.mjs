// Close-up shots of the engine in the bay: an orthographic camera aimed at the engine from a
// direction given in the car's frame, following the car. Optional keys are held while shooting.
//   node scripts/engine-closeup.mjs [url] [out-prefix] [dir x,y,z] [zoom] [keys] [shots] [interval ms]
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const [url = 'http://127.0.0.1:8731/', out = 'engine', dir = '1,0.6,0.8', zoom = '40', keys = '', shots = '1', interval = '200', target = '0,0.2,0'] = process.argv.slice(2);
// SOLO=1 hides the rest of the car (seats, frame) so nothing is in the way.
const solo = !!process.env.SOLO;
// HIDE=static,spring hides parts of the engine by name.
const hide = (process.env.HIDE ?? '').split(',').filter(Boolean);
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(6000);
await page.evaluate(
  ({ dir, zoom, target, solo, hide }) => {
    const { render } = window.__game;
    const { renderer } = render;
    const draw = renderer.render.bind(renderer);
    let cam = null;
    renderer.render = (scene, camera) => {
      if (scene !== render.scene) return draw(scene, camera);
      const engine = scene.getObjectByName('dragster engine');
      if (!engine) return draw(scene, camera);
      for (const name of hide) {
        const o = engine.getObjectByName(name);
        if (o) o.visible = false;
      }
      if (solo) for (const c of engine.parent.children) if (c !== engine) c.visible = false;
      cam ??= camera.clone();
      const q = engine.parent.getWorldQuaternion(camera.quaternion.clone());
      const t = engine.localToWorld(engine.position.clone().set(...target));
      const d = engine.position.clone().set(...dir).normalize().applyQuaternion(q);
      cam.position.copy(t).addScaledVector(d, 30);
      cam.up.set(0, 1, 0);
      cam.lookAt(t);
      cam.zoom = zoom;
      cam.near = 0.1;
      cam.far = 100;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      return draw(scene, cam);
    };
  },
  { dir: dir.split(',').map(Number), zoom: Number(zoom), target: target.split(',').map(Number), solo, hide },
);
const held = keys ? keys.split('+') : [];
for (const k of held) await page.keyboard.down(k);
for (let i = 0; i < Number(shots); i++) {
  await page.waitForTimeout(Number(interval));
  await page.screenshot({ path: `${out}-${i}.png`, clip: { x: 0, y: 0, width: 960, height: 800 } });
}
await browser.close();
