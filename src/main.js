import RAPIER from '@dimforge/rapier3d-compat';
import { glyph } from '@pmndrs/glyph';
import { ThreeConfig } from '@pmndrs/glyph/three';
import { createWorld } from 'koota';
import {
  HeightField,
  HudLabel,
  Input,
  IsPlayer,
  Physics,
  Render,
  SteeringWheel,
  TerrainStreaming,
  Time,
  Vehicle,
  WheelRig,
} from './ecs/traits.js';
import { createRenderer } from './render/scene.js';
import { attachZoom, followCamera } from './systems/camera.js';
import { updateHud } from './systems/hud.js';
import { attachKeyboard, readInput } from './systems/input.js';
import { stepPhysics, syncBodies } from './systems/physics.js';
import { streamTerrain } from './systems/terrain.js';
import { syncSoftTires, syncViews, syncWheels } from './systems/views.js';
import { createHeightField } from './terrain/height.js';
import { spawnCar, startHeight } from './vehicle/spawn.js';
import { createTuningPanel } from './tuning/panel.js';

async function main() {
  const container = document.getElementById('app');
  const [render] = await Promise.all([createRenderer(container), RAPIER.init(), glyph.init()]);

  const world = createWorld();
  // ?terrain=hills brings back the rolling hills from iteration 1.
  const mode = new URLSearchParams(location.search).get('terrain') ?? 'flat';
  const heightAt = createHeightField({ mode });
  const physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physicsWorld.timestep = 1 / 120;

  world.add(Time, Input, TerrainStreaming);
  world.add(Physics({ rapier: RAPIER, world: physicsWorld, accumulator: 0, step: 1 / 120, stepMs: 0 }));
  world.add(Render(render));
  world.add(HeightField({ heightAt }));

  // The car starts just above the ground at the origin.
  spawnCar(world, { position: { x: 0, y: heightAt(0, 0) + startHeight(), z: 0 } });
  createTuningPanel(world, { heightAt });

  streamTerrain(world, { force: true });

  // HUD text through Glyph.
  const hud = glyph.handle('hud', ThreeConfig);
  const inter = glyph.fontFace('/fonts/inter-latin.font.glb');
  await inter.load();
  const speedText = hud.createText({
    font: inter,
    text: '0 km/h',
    style: { fontSize: 22, lineHeight: 1.2, color: '#4a4538' },
  });
  speedText.position.set(28, -24, 0);
  render.hudScene.add(speedText);
  world.spawn(HudLabel({ text: speedText, format: (v) => `${Math.round(Math.abs(v.speed) * 3.6)} km/h` }));

  const engineText = hud.createText({
    font: inter,
    text: 'idle',
    style: { fontSize: 14, lineHeight: 1.2, color: '#6b6453' },
  });
  engineText.position.set(28, -54, 0);
  render.hudScene.add(engineText);
  world.spawn(
    HudLabel({
      text: engineText,
      format: (v, input) => {
        if (input.engineOn) return 'engine on';
        if (input.brake) return 'braking';
        return Math.abs(v.speed) < 0.3 ? 'idle' : 'engine braking';
      },
    }),
  );

  const perfText = hud.createText({
    font: inter,
    text: '',
    style: { fontSize: 12, lineHeight: 1.2, color: '#9a927e' },
  });
  perfText.position.set(28, -100, 0);
  render.hudScene.add(perfText);
  world.spawn(
    HudLabel({
      text: perfText,
      format: (v) => {
        const tyres = v.controller.wheels ? 'soft tyres' : 'rigid wheels';
        return `${tyres}    physics ${world.get(Physics).stepMs.toFixed(1)} ms/step`;
      },
    }),
  );

  const hintText = hud.createText({
    font: inter,
    text: 'W / Up  accelerate (hold)    S / Down  brake    A D / Left Right  steer    Space  handbrake    R  respawn    Scroll  zoom',
    style: { fontSize: 14, lineHeight: 1.2, color: '#8a826f' },
  });
  hintText.position.set(28, -78, 0);
  render.hudScene.add(hintText);

  attachKeyboard();
  attachZoom(render.renderer.domElement);

  let last = performance.now();
  const frame = (now) => {
    const time = world.get(Time);
    time.delta = Math.min((now - last) / 1000, 0.1);
    time.elapsed += time.delta;
    last = now;

    readInput(world);
    stepPhysics(world);
    syncBodies(world);
    streamTerrain(world);
    syncViews(world);
    syncWheels(world);
    syncSoftTires(world);
    followCamera(world);
    updateHud(world);

    glyph.shape();
    const { renderer, scene, camera, hudScene, hudCamera } = render;
    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.render(hudScene, hudCamera);
  };
  render.renderer.setAnimationLoop(frame);

  // Handy for debugging from the console.
  window.__game = {
    world,
    RAPIER,
    render,
    get car() {
      return world.queryFirst(IsPlayer, Vehicle);
    },
    traits: { Vehicle, WheelRig, SteeringWheel, Input, Time, Physics },
  };
}

main().catch((error) => {
  console.error(error);
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = String(error?.stack ?? error);
  document.body.append(pre);
});
