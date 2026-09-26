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
  RockField,
  SteeringWheel,
  TerrainStreaming,
  Tracks,
  Deformation,
  Soil,
  AxleRig,
  Time,
  Vehicle,
  WheelRig,
} from './ecs/traits.js';
import { createRenderer } from './render/scene.js';
import { createGauges } from './ui/gauges.js';
import { attachZoom, followCamera } from './systems/camera.js';
import { updateHud } from './systems/hud.js';
import { attachKeyboard, readInput } from './systems/input.js';
import { stepPhysics, syncBodies } from './systems/physics.js';
import { streamTerrain } from './systems/terrain.js';
import { syncAxles, syncSoftTires, syncViews, syncWheels } from './systems/views.js';
import { updateTracks } from './systems/tracks.js';
import { updateSoil } from './systems/soil.js';
import { SoilParticles } from './render/soil-particles.js';
import { TireTracks } from './render/tracks.js';
import { GROUND } from './tire/config.js';
import { GroundDeformation } from './terrain/deformation.js';
import { createHeightField } from './terrain/height.js';
import { applyPendingCarAction, requestRespawn, requestRespawnAt, spawnCar, startHeight } from './vehicle/spawn.js';
import { createTuningPanel } from './tuning/panel.js';
import { createTouchControls } from './ui/touch-controls.js';

async function main() {
  const container = document.getElementById('app');
  const [render] = await Promise.all([createRenderer(container), RAPIER.init(), glyph.init()]);

  const world = createWorld();
  // Red-rock canyon with gravel roads by default; ?terrain=flat (tests) or ?terrain=hills.
  const mode = new URLSearchParams(location.search).get('terrain') ?? 'canyon';
  const heightAt = createHeightField({ mode });
  const physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physicsWorld.timestep = 1 / 120;
  // The jointed car is a chain of light links under a heavy chassis; Rapier's default 4 solver
  // iterations leave it leaning and trembling at rest. 8 settles it level and still.
  physicsWorld.numSolverIterations = 8;

  world.add(Time, Input, TerrainStreaming);
  world.add(Physics({ rapier: RAPIER, world: physicsWorld, accumulator: 0, step: 1 / 120, stepMs: 0 }));
  world.add(Render(render));
  const deformation = new GroundDeformation();
  const surfaceAt = (x, z) => heightAt(x, z) + deformation.at(x, z);
  world.add(HeightField({ heightAt, surfaceAt }));
  world.add(Deformation({ map: deformation }));
  world.add(Soil({ particles: new SoilParticles(render.scene), carry: [0, 0, 0, 0], spin: [0, 0, 0, 0] }));
  world.add(
    Tracks({
      renderer: new TireTracks(render.scene, { segments: GROUND.trackLength, deformation }),
      contacts: [null, null, null, null],
    }),
  );

  // The car starts just above the ground at the origin (on a road in the canyon, facing along it).
  const yaw = heightAt.roadHeading ? heightAt.roadHeading(0, 0) : 0;
  spawnCar(world, {
    position: { x: 0, y: heightAt(0, 0) + startHeight(), z: 0 },
    rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  });
  const panel = createTuningPanel(world, { heightAt });
  const touch = createTouchControls({ onRespawn: () => requestRespawn(world, heightAt) });
  // Small screens start with the panel folded so the road stays visible.
  if (window.innerWidth < 700 || touch.isVisible()) panel.close();

  streamTerrain(world, { force: true });

  // HUD text through Glyph.
  const hud = glyph.handle('hud', ThreeConfig);
  const inter = glyph.fontFace('/fonts/inter-latin.font.glb');
  await inter.load();
  // Speedometer, tachometer, and gear indicator.
  const gauges = createGauges({ hud, font: inter, scene: render.hudScene });

  const perfText = hud.createText({
    font: inter,
    text: '',
    style: { fontSize: 12, lineHeight: 1.2, color: '#9a927e' },
  });
  perfText.position.set(28, -48, 0);
  render.hudScene.add(perfText);
  world.spawn(
    HudLabel({
      text: perfText,
      format: (v) => {
        const tyres = v.controller.gpu ? 'GPU tyres' : v.controller.wheels ? 'Rapier soft tyres' : 'rigid wheels';
        const gpu = render.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2 (no WebGPU)';
        return `${tyres}    physics ${world.get(Physics).stepMs.toFixed(1)} ms/step    ${gpu}`;
      },
    }),
  );

  const hintText = hud.createText({
    font: inter,
    text: '',
    style: { fontSize: 14, lineHeight: 1.2, color: '#8a826f' },
  });
  hintText.position.set(28, -24, 0);
  render.hudScene.add(hintText);
  const KEY_HINT =
    'W / Up  accelerate (hold)    S / Down  brake, reverse    A D  steer    Q E  shift    L  low range    Space  handbrake    R  respawn';
  const TOUCH_HINT = 'Hold the up button to drive, down to brake    Pinch to zoom';
  world.spawn(HudLabel({ text: hintText, format: () => (touch.isVisible() ? TOUCH_HINT : KEY_HINT) }));

  attachKeyboard();
  attachZoom(render.renderer.domElement);

  let last = performance.now();
  // Physics can wait on the GPU, so a frame is async; a frame that arrives while the previous one
  // is still simulating is skipped rather than overlapped.
  let busy = false;
  const frame = async (now) => {
    if (busy) return;
    busy = true;
    try {
      const time = world.get(Time);
      time.delta = Math.min((now - last) / 1000, 0.1);
      time.elapsed += time.delta;
      last = now;

      // Queued rebuilds and respawns run here, never while physics awaits the GPU.
      applyPendingCarAction();
      readInput(world);
      await stepPhysics(world);
      syncBodies(world);
      streamTerrain(world);
      syncViews(world);
      syncWheels(world);
      syncAxles(world);
      syncSoftTires(world);
      updateTracks(world);
      updateSoil(world);
      followCamera(world);
      updateHud(world);
      const player = world.queryFirst(IsPlayer, Vehicle);
      if (player) {
        const canvas = render.renderer.domElement;
        gauges.layout(canvas.clientWidth, canvas.clientHeight, touch.isVisible());
        gauges.update(player.get(Vehicle), time.delta);
      }

      glyph.shape();
      const { renderer, scene, activeCamera: camera, hudScene, hudCamera } = render;
      renderer.clear();
      renderer.render(scene, camera);
      renderer.clearDepth();
      renderer.render(hudScene, hudCamera);
    } finally {
      busy = false;
    }
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
    respawnAt: (x, z, yaw) => requestRespawnAt(world, heightAt, x, z, yaw),
    heightAt,
    traits: { Vehicle, WheelRig, SteeringWheel, Input, Time, Physics, Tracks, Deformation, Soil, AxleRig, RockField },
  };
}

main().catch((error) => {
  console.error(error);
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = String(error?.stack ?? error);
  document.body.append(pre);
});
