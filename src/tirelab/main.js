import RAPIER from '@dimforge/rapier3d-compat';
import { glyph } from '@pmndrs/glyph';
import { ThreeConfig } from '@pmndrs/glyph/three';
import GUI from 'lil-gui';
import { createNoise3D } from 'simplex-noise';
import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  BoxGeometry,
} from 'three/webgpu';
import { createRocksMesh } from '../render/rock-mesh.js';
import { createSoftTireMesh, updateSoftTireMesh } from '../render/soft-tire-mesh.js';
import { createRenderer } from '../render/scene.js';
import { createChunkMesh } from '../render/terrain-mesh.js';
import { CHUNK_SIZE, sampleChunk } from '../terrain/chunk.js';
import { mulberry32 } from '../terrain/height.js';
import { makeRock } from '../terrain/rocks.js';
import { DEFAULT_TIRE, TIRE, resetTire, saveTire } from '../tire/config.js';
import { GROUP, TIRE_REBUILD_KEYS, createSoftTire, groups, updateSoftTire } from '../tire/soft-tire.js';
import { isTyping } from '../tuning/panel.js';

const DT = 1 / 120;
const START = { x: 0, y: 0.9, z: 0 };
const flat = () => 0;

// Lab-only settings: the load on the hub and how hard the keys drive it.
const LAB = { load: 450, driveTorque: 900, brakeTorque: 2500 };

async function main() {
  const container = document.getElementById('app');
  const [render] = await Promise.all([createRenderer(container), RAPIER.init(), glyph.init()]);
  const { renderer, scene, camera, sun, hudScene, hudCamera } = render;

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;

  // Ground: a long flat strip with a lane of rocks along +x, in the wheel's path.
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(2000, 1, 50).setTranslation(1900, -1, 0).setFriction(1).setCollisionGroups(groups(GROUP.WORLD, 0xffff)),
  );
  for (let cx = -1; cx < 32; cx++) {
    for (const cz of [-1, 0]) scene.add(createChunkMesh(flat, sampleChunk(flat, cx, cz), cx, cz));
  }
  const rand = mulberry32(2024);
  const noise = createNoise3D(rand);
  const rocks = [];
  for (let x = 6, k = 0; x < 32 * CHUNK_SIZE; x += 4 + rand() * 6, k++) {
    const size = [0.12, 0.18, 0.25, 0.32, 0.4][k % 5] * (0.8 + rand() * 0.4);
    rocks.push(makeRock(flat, x, (rand() - 0.5) * 0.3, size, rand, noise));
  }
  for (const rock of rocks) {
    world.createCollider(RAPIER.ColliderDesc.convexHull(rock.vertices).setFriction(0.9).setCollisionGroups(groups(GROUP.WORLD, 0xffff)));
  }
  scene.add(createRocksMesh(rocks));

  // The hub moves in the x-y plane and spins about its axle (z), like one corner of a car.
  const hub = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(START.x, START.y, START.z)
      .enabledTranslations(true, true, false)
      .enabledRotations(false, false, true)
      .setCanSleep(false),
  );
  let rimCollider = null;
  const setLoad = () => {
    if (rimCollider) world.removeCollider(rimCollider, false);
    rimCollider = world.createCollider(
      RAPIER.ColliderDesc.cylinder(TIRE.width / 2 - 0.02, TIRE.rimRadius - 0.02)
        .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 })
        .setMass(LAB.load)
        .setCollisionGroups(groups(GROUP.RIM, GROUP.WORLD)),
      hub,
    );
  };
  setLoad();

  // Rim and hub visuals follow the rigid hub.
  const rimGroup = new Group();
  const rimMat = new MeshStandardMaterial({ color: '#c9c6bd', roughness: 0.4, metalness: 0.6 });
  const darkMat = new MeshStandardMaterial({ color: '#2d2f31', roughness: 0.6, metalness: 0.4 });
  const buildRim = () => {
    rimGroup.clear();
    const rim = new Mesh(new CylinderGeometry(TIRE.rimRadius, TIRE.rimRadius, TIRE.width * 0.9, 28), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.castShadow = true;
    rimGroup.add(rim);
    for (let i = 0; i < 5; i++) {
      const spoke = new Mesh(new BoxGeometry(TIRE.rimRadius * 1.9, 0.05, TIRE.width * 0.95), darkMat);
      spoke.rotation.z = (i / 5) * Math.PI;
      rimGroup.add(spoke);
    }
  };
  buildRim();
  scene.add(rimGroup);

  // Tyre: a mesh whose vertices are the soft body's particles.
  let tire = null;
  let tireMesh = null;
  const buildTire = () => {
    if (tire) world.removeSoftBody(tire.soft);
    if (tireMesh) {
      scene.remove(tireMesh);
      tireMesh.geometry.dispose();
    }
    tire = createSoftTire(RAPIER, world, hub, TIRE);
    tireMesh = createSoftTireMesh(tire.soft, tire.mesh);
    scene.add(tireMesh);
  };
  buildTire();

  const reset = () => {
    hub.setTranslation(START, true);
    hub.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    hub.setLinvel({ x: 0, y: 0, z: 0 }, true);
    hub.setAngvel({ x: 0, y: 0, z: 0 }, true);
    buildTire();
  };

  // Keyboard.
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    keys.add(e.code);
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    if (e.code === 'KeyR') reset();
    if (e.code === 'Space' && !e.repeat) {
      // Drop test: lift the wheel and let it fall.
      const p = hub.translation();
      hub.setTranslation({ x: p.x, y: p.y + 1.2, z: p.z }, true);
      hub.setLinvel({ x: hub.linvel().x, y: 0, z: 0 }, true);
      buildTire();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  // Panel.
  const gui = new GUI({ title: 'Soft tyre lab' });
  gui.domElement.classList.add('tuning');
  const actions = {
    copy: async () => {
      const text = JSON.stringify({ tire: TIRE, lab: LAB }, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        copyButton.name('Copied ✓');
      } catch {
        console.log(text);
        copyButton.name('Copy failed, see console');
      }
      setTimeout(() => copyButton.name('Copy settings'), 1800);
    },
    reset: () => {
      resetTire();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      buildRim();
      setLoad();
      buildTire();
    },
    drop: () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })),
    back: () => (location.href = '/'),
  };
  const copyButton = gui.add(actions, 'copy').name('Copy settings');
  gui.add(actions, 'reset').name('Reset tyre to defaults');
  gui.add(actions, 'drop').name('Drop test (Space)');
  gui.add(actions, 'back').name('← Back to the car');

  let rebuildTimer = null;
  const onTire = (key) => () => {
    saveTire();
    if (TIRE_REBUILD_KEYS.includes(key)) {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        buildRim();
        setLoad();
        buildTire();
      }, 200);
    } else {
      updateSoftTire(RAPIER, tire.soft, TIRE);
    }
  };
  const air = gui.addFolder('Air & rubber');
  air.add(TIRE, 'inflation', 0.8, 1.3, 0.01).name('Air pressure (inflation ×)').onChange(onTire('inflation'));
  air.add(TIRE, 'airStiffness', 20, 800, 10).name('Air stiffness (Hz)').onChange(onTire('airStiffness'));
  air.add(TIRE, 'carcassStiffness', 20, 800, 10).name('Carcass / cords (Hz)').onChange(onTire('carcassStiffness'));
  air.add(TIRE, 'sidewallStiffness', 0, 120, 1).name('Sidewall bending (Hz)').onChange(onTire('sidewallStiffness'));
  air.add(TIRE, 'shapeMemory', 0, 120, 1).name('Shape memory (Hz)').onChange(onTire('shapeMemory'));
  air.add(TIRE, 'damping', 0, 2, 0.05).name('Damping ratio').onChange(onTire('damping'));
  air.add(TIRE, 'friction', 0.2, 2, 0.05).name('Rubber friction').onChange(onTire('friction'));
  air.add(TIRE, 'rubberMass', 2, 40, 1).name('Rubber mass (kg)').onChange(onTire('rubberMass'));
  const size = gui.addFolder('Size & mesh');
  size.add(TIRE, 'outerRadius', 0.3, 0.8, 0.01).name('Outer radius (m)').onChange(onTire('outerRadius'));
  size.add(TIRE, 'rimRadius', 0.15, 0.6, 0.01).name('Rim radius (m)').onChange(onTire('rimRadius'));
  size.add(TIRE, 'width', 0.12, 0.6, 0.01).name('Width (m)').onChange(onTire('width'));
  size.add(TIRE, 'segmentsAround', 12, 48, 1).name('Segments around').onChange(onTire('segmentsAround'));
  size.add(TIRE, 'segmentsAcross', 4, 16, 1).name('Segments across').onChange(onTire('segmentsAcross'));
  size.add(TIRE, 'beadRings', 0, 2, 1).name('Bead width (rings)').onChange(onTire('beadRings'));
  size.add(TIRE, 'substeps', 0, 6, 1).name('Solver substeps').onChange(onTire('substeps'));
  size.add(TIRE, 'pgsIterations', 0, 6, 1).name('Solver iterations').onChange(onTire('pgsIterations'));
  size.close();
  const lab = gui.addFolder('Lab');
  lab.add(LAB, 'load', 20, 1500, 10).name('Load on hub (kg)').onChange(setLoad);
  lab.add(LAB, 'driveTorque', 0, 4000, 50).name('Drive torque (N·m)');
  lab.add(LAB, 'brakeTorque', 0, 8000, 100).name('Brake torque (N·m)');
  gui.onFinishChange(() => {
    if (isTyping({ target: document.activeElement })) document.activeElement.blur();
  });

  // HUD.
  const hud = glyph.handle('hud', ThreeConfig);
  const inter = glyph.fontFace('/fonts/inter-latin.font.glb');
  await inter.load();
  const label = (text, y, size, color) => {
    const t = hud.createText({ font: inter, text, style: { fontSize: size, lineHeight: 1.2, color } });
    t.position.set(28, y, 0);
    hudScene.add(t);
    return t;
  };
  const title = label('Soft tyre lab', -24, 22, '#4a4538');
  const stats = label('', -54, 14, '#6b6453');
  const hint = label('W / Up  drive    S / Down  brake    Space  drop test    R  reset    Scroll  zoom', -78, 14, '#8a826f');
  void title;
  void hint;

  // Camera: isometric, close, following the hub.
  let zoom = Number(new URLSearchParams(location.search).get('zoom')) || 5;
  renderer.domElement.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom = Math.min(8, Math.max(0.5, zoom * Math.exp(-e.deltaY * 0.0015)));
    },
    { passive: false },
  );
  const cam = { x: START.x, y: 0.4 };

  let accumulator = 0;
  let last = performance.now();
  let stepMs = 0;
  let statsTimer = 0;
  renderer.setAnimationLoop((now) => {
    const delta = Math.min((now - last) / 1000, 0.1);
    last = now;
    accumulator = Math.min(accumulator + delta, 0.1);

    const drive = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const t0 = performance.now();
    let steps = 0;
    while (accumulator >= DT) {
      hub.resetTorques(true);
      const w = hub.angvel().z;
      if (drive > 0) hub.addTorque({ x: 0, y: 0, z: -LAB.driveTorque }, true);
      else if (drive < 0) {
        // Brake against the spin; below a crawl, drive backwards instead.
        if (w < -0.5) hub.addTorque({ x: 0, y: 0, z: LAB.brakeTorque }, true);
        else hub.addTorque({ x: 0, y: 0, z: LAB.driveTorque * 0.5 }, true);
      }
      world.step();
      accumulator -= DT;
      steps++;
    }
    if (steps) stepMs = stepMs * 0.9 + ((performance.now() - t0) / steps) * 0.1;

    // Sync visuals.
    const p = hub.translation();
    const q = hub.rotation();
    rimGroup.position.set(p.x, p.y, p.z);
    rimGroup.quaternion.set(q.x, q.y, q.z, q.w);
    updateSoftTireMesh(tireMesh, tire.soft);

    statsTimer -= delta;
    if (statsTimer <= 0) {
      statsTimer = 0.2;
      const kmh = Math.abs(hub.linvel().x) * 3.6;
      const sag = TIRE.outerRadius + tire.soft.particleRadius() - p.y;
      const vol = tire.soft.volume() / tire.soft.restVolume();
      stats.text = `${kmh.toFixed(0)} km/h    sag ${(sag * 100).toFixed(1)} cm    air volume ${(vol * 100).toFixed(0)}% of moulded    physics ${stepMs.toFixed(2)} ms/step`;
    }

    // Camera follow with a little look-ahead.
    const k = 1 - Math.exp(-delta * 4);
    cam.x += (p.x + hub.linvel().x * 0.3 - cam.x) * k;
    cam.y += (Math.max(0.3, p.y * 0.6) - cam.y) * k;
    if (Math.abs(camera.zoom - zoom) > 1e-3) {
      camera.zoom += (zoom - camera.zoom) * 0.2;
      camera.updateProjectionMatrix();
    }
    camera.position.set(cam.x + 60, cam.y + 60, 60);
    camera.lookAt(cam.x, cam.y, 0);
    sun.target.position.set(cam.x, 0, 0);
    sun.position.set(cam.x - 35, 45, -25);
    sun.target.updateMatrixWorld();

    glyph.shape();
    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.render(hudScene, hudCamera);
  });

  window.__lab = { world, hub, get tire() { return tire; }, TIRE, LAB };
}

main().catch((error) => {
  console.error(error);
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = String(error?.stack ?? error);
  document.body.append(pre);
});
