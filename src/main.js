import RAPIER from '@dimforge/rapier3d-compat';
import { glyph } from '@pmndrs/glyph';
import { ThreeConfig } from '@pmndrs/glyph/three';
import { createWorld } from 'koota';
import {
  HeightField,
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
import { attachZoom, followCamera, isFollowCamera, orbitCamera, toggleFollowCamera } from './systems/camera.js';
import { attachKeyboard, readCameraKeys, readInput } from './systems/input.js';
import { CONTROLS } from './controls.js';
import { stepPhysics } from './systems/physics.js';
import { syncBodies } from './systems/draw-sync.js';
import { streamTerrain } from './systems/terrain.js';
import { syncAxles, syncBrakeLights, syncSoftTires, syncViews, syncWheels } from './systems/views.js';
import { updateTracks } from './systems/tracks.js';
import { updateSoil } from './systems/soil.js';
import { updateBushes } from './systems/vegetation.js';
import { SoilParticles } from './render/soil-particles.js';
import { TireTracks } from './render/tracks.js';
import { GROUND, setSnowCover } from './tire/config.js';
import { GroundDeformation } from './terrain/deformation.js';
import { createHeightField } from './terrain/height.js';
import { worldMode } from './world.js';
import { setGroundPatch, setTerrainWorld } from './render/terrain-mesh.js';
import { SnowSurface } from './render/snow-surface.js';
import { GroundSurface } from './render/ground-surface.js';
import { applyPendingCarAction, footprint, requestRespawn, requestRespawnAt, spawnCar, startHeight } from './vehicle/spawn.js';
import { createTuningPanel } from './tuning/panel.js';
import { updateInstanceBatchers } from './render/instance-batcher.js';
import { createPhysicsClient, workerGpuSupported } from './physics/client.js';
import { ROCK_COUNT, startChunkWorker } from './systems/terrain.js';
import { CAR } from './vehicle/config.js';
import { updateGpuGround, updateGpuRocks } from './tire/gpu-tires.js';
import { createTouchControls } from './ui/touch-controls.js';
import { count, reportError, sample, startOverlay, timed } from './perf.js';
import { AudioFeed, createFeedBuffer } from './audio/feed.js';
import { createAudio } from './audio/audio.js';

async function main() {
  const container = document.getElementById('app');
  const [render] = await Promise.all([createRenderer(container), RAPIER.init(), glyph.init()]);

  // The frame updates world matrices itself, before the instanced parts read them (see draw).
  render.scene.matrixWorldAutoUpdate = false;
  const world = createWorld();
  // The world from the panel's picker (red-rock canyon by default, or the dry river);
  // ?terrain=flat (tests), ?terrain=hills, ?terrain=ramp&slope=20 (a straight climb for hill-start
  // tests), or any world overrides it.
  let mode = worldMode();
  if (mode === 'ramp') mode = `ramp:${new URLSearchParams(location.search).get('slope') ?? 20}`;
  setTerrainWorld(mode);
  // The dry river's isometric views get a paler, less dusty haze than the canyon.
  if (mode === 'river') {
    render.scene.background.set('#e4e1d6');
    render.scene.fog.color.set('#e4e1d6');
  }
  // The snowfield: an overcast-bright winter haze, and light thrown back up off the snow.
  if (mode === 'snow') {
    render.scene.background.set('#e6ecf2');
    render.scene.fog.color.set('#e6ecf2');
    render.scene.traverse((o) => {
      if (o.isHemisphereLight) {
        o.color.set('#eef4ff');
        o.groundColor.set('#d5dee9');
      }
    });
    render.sun.color.set('#fffaf2');
  }
  const heightAt = createHeightField({ mode });
  // The tyres, compaction and spray treat the ground as snow in the snowfield.
  setSnowCover(heightAt.snow);
  const deformation = new GroundDeformation();
  // The ground near the car, drawn with its ruts: snow on the snowfield, soil elsewhere.
  const groundSurface = heightAt.snow ? new SnowSurface(render.scene, heightAt, deformation) : new GroundSurface(render.scene, heightAt, deformation);
  groundSurface.onMove = setGroundPatch;

  // Physics runs in a worker (with its own GPU device) for the GPU tyres when the browser has
  // WebGPU in workers; ?physics=main keeps it on this thread. Other tyre modes stay here.
  const params = new URLSearchParams(location.search);
  // The engine sound reads every physics step from here (audio/feed.js); ?sound=0 turns it off.
  const audioFeed = new AudioFeed(createFeedBuffer());
  const useWorker = CAR.softTires && CAR.gpuTires && params.get('physics') !== 'main' && (await workerGpuSupported());
  let remote = null;
  let physicsWorld = null;
  if (useWorker) {
    remote = createPhysicsClient({ terrain: mode, rocks: ROCK_COUNT, deformation, slowGpu: Number(params.get('slowgpu') ?? 0), audioFeed });
    try {
      await remote.start();
    } catch (error) {
      console.warn('Physics worker unavailable, running physics on the main thread:', error);
      remote.stop();
      remote = null;
    }
  }
  if (!remote) {
    physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    physicsWorld.timestep = 1 / 120;
    // The jointed car is a chain of light links under a heavy chassis; Rapier's default 4 solver
    // iterations leave it leaning and trembling at rest. 8 settles it level and still.
    physicsWorld.numSolverIterations = 8;
  }

  world.add(Time, Input, TerrainStreaming);
  world.add(Physics({ rapier: RAPIER, world: physicsWorld, remote, accumulator: 0, step: 1 / 120, stepMs: 0, simTime: 0, displayTime: 0 }));
  // Main-thread physics writes the audio feed itself; worker physics writes it in the worker.
  if (!remote) world.get(Physics).audioFeed = audioFeed;
  const audio = params.get('sound') === '0' ? null : createAudio({ feed: audioFeed });
  world.add(Render(render));
  const surfaceAt = (x, z) => heightAt(x, z) + deformation.at(x, z);
  world.add(HeightField({ heightAt, surfaceAt }));
  world.add(Deformation({ map: deformation }));
  // Powder snow hangs in the air longer than clumps of soil, and light shines through it.
  world.add(Soil({ particles: new SoilParticles(render.scene, heightAt.snow ? { drag: 3, powder: true } : undefined), carry: [0, 0, 0, 0], spin: [0, 0, 0, 0] }));
  world.add(
    Tracks({
      renderer: new TireTracks(render.scene, { segments: GROUND.trackLength, deformation }),
      contacts: [null, null, null, null],
    }),
  );

  // The car starts just above the ground at the origin (on the road or river bed, facing along it),
  // above the highest ground under it so no wheel starts inside a slab.
  const yaw = heightAt.roadHeading ? heightAt.roadHeading(0, 0) : 0;
  spawnCar(world, {
    position: { x: 0, y: footprint(heightAt, 0, 0, yaw).max + startHeight(), z: 0 },
    rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  });
  const panel = createTuningPanel(world, { heightAt });
  const touch = createTouchControls({ onRespawn: () => requestRespawn(world, heightAt), onCamera: () => toggleFollowCamera() });
  // Small screens start with the panel folded so the road stays visible.
  if (window.innerWidth < 700 || touch.isVisible()) panel.close();

  // The chunk worker first, so the initial load can hand it the rock sheets (dry river).
  startChunkWorker({ mode });
  streamTerrain(world, { force: true });

  // HUD text through Glyph.
  const hud = glyph.handle('hud', ThreeConfig);
  const inter = glyph.fontFace('/fonts/inter-latin.font.glb');
  await inter.load();
  // Speedometer, tachometer, and gear indicator.
  const gauges = createGauges({ hud, font: inter, scene: render.hudScene });

  // The perf card's two lines (P or the panel's switch shows it).
  const gpuName = render.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2 (no WebGPU)';
  const perfLines = (v) => {
    const tyres = v.controller.gpu ? 'GPU tyres' : v.controller.wheels ? 'Rapier soft tyres' : 'rigid wheels';
    return [`${tyres}  ·  ${gpuName}`, `physics ${world.get(Physics).stepMs.toFixed(1)} ms/step${remote ? ' (worker)' : ''}`];
  };

  attachKeyboard();
  attachZoom(render.renderer.domElement);

  let last = performance.now();
  // Physics can wait on the GPU (tyre readback), so it runs as its own async task and is never
  // overlapped: a new batch of steps starts only when the previous one is done, with all the time
  // that passed since (measured on the wall clock). An animation frame starts a batch when physics
  // is idle; a batch that took longer than a step chains straight into the next one, so slow steps
  // do not also idle until the next frame. Drawing happens synchronously in every animation frame, whatever physics is
  // doing: Safari shows a blank (white) canvas for frames where nothing is drawn inside the
  // animation-frame callback, which flickered whenever a physics batch outlasted a frame.
  let busy = false;
  let simLast = performance.now();
  const physicsStep = world.get(Physics).step;
  const NO_DRAW = new URLSearchParams(location.search).has('nodraw');
  const draw = () => {
    if (NO_DRAW) return;
    const { renderer, scene, activeCamera: camera, hudScene, hudCamera } = render;
    // World matrices first, then the instanced car parts copy theirs (see render/instance-batcher.js).
    scene.updateMatrixWorld();
    updateInstanceBatchers();
    renderer.clear();
    renderer.render(scene, camera);
    sample('scene.drawCalls', renderer.info.render.drawCalls);
    sample('scene.ktris', renderer.info.render.triangles / 1000);
    renderer.clearDepth();
    renderer.render(hudScene, hudCamera);
  };
  const simulate = async () => {
    busy = true;
    try {
      const now = performance.now();
      const delta = (now - simLast) / 1000;
      simLast = now;
      count('droppedSeconds', Math.max(0, delta - 0.1));
      // Queued rebuilds and respawns run here, never while physics awaits the GPU.
      applyPendingCarAction();
      readInput(world);
      await stepPhysics(world, Math.min(delta, 0.1));
    } catch (error) {
      console.error(error);
    } finally {
      busy = false;
      // A new task (not a microtask), so a chain of slow batches never starves the animation frame.
      if (!document.hidden && performance.now() - simLast >= physicsStep * 1000) setTimeout(() => busy || simulate(), 0);
    }
  };
  startOverlay();
  const frame = (now) => {
    const fStart = performance.now();
    sample('frame.interval', now - last);
    if (now - last > 50) count('longFrames');
    count('wallSeconds', Math.min((now - last) / 1000, 0.1));
    const time = world.get(Time);
    time.delta = Math.min((now - last) / 1000, 0.1);
    time.elapsed += time.delta;
    last = now;
    // Safari shows a white canvas for any animation frame that draws nothing, so an error in a
    // system must not skip the draw: it is logged (and counted in the ?perf overlay) instead.
    try {
      if (remote) {
        // The worker steps on its own clock; send it this frame's input and take its newest time.
        applyPendingCarAction();
        readInput(world);
        remote.tick(world.get(Input));
        const physics = world.get(Physics);
        physics.simTime = remote.simTime;
        physics.stepMs = remote.stepMs;
        syncRemoteSolver(world);
      } else if (!busy) simulate();

      timed('sys.syncBodies', () => syncBodies(world));
      timed('sys.streamTerrain', () => streamTerrain(world));
      timed('sys.syncViews', () => syncViews(world));
      timed('sys.syncWheels', () => syncWheels(world));
      timed('sys.syncAxles', () => syncAxles(world));
      timed('sys.syncSoftTires', () => syncSoftTires(world));
      timed('sys.syncBrakeLights', () => syncBrakeLights(world));
      timed('sys.updateTracks', () => updateTracks(world));
      timed('sys.updateSoil', () => updateSoil(world));
      timed('sys.groundSurface', () => updateGroundSurface(world, groundSurface));
      timed('sys.updateBushes', () => updateBushes(world));
      orbitCamera(readCameraKeys(), time.delta);
      timed('sys.followCamera', () => followCamera(world));
      const player = world.queryFirst(IsPlayer, Vehicle);
      if (player) {
        const canvas = render.renderer.domElement;
        gauges.layout(canvas.clientWidth, canvas.clientHeight, touch.isVisible());
        const vehicle = player.get(Vehicle);
        audio?.update(vehicle, world.get(Soil), render.activeCamera);
        gauges.update(vehicle, time.delta, { follow: isFollowCamera(), perf: CONTROLS.showPerf ? perfLines(vehicle) : null });
        { const v = player.get(Vehicle).body.linvel(); sample('speed.kmh', Math.hypot(v.x, v.z) * 3.6); }
      }
      timed('sys.glyph', () => glyph.shape());
    } catch (error) {
      count('frameErrors');
      reportError(error);
    }
    timed('draw', draw);
    sample('frame.js', performance.now() - fStart);
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
    audio,
    audioFeed,
    traits: { Vehicle, WheelRig, SteeringWheel, Input, Time, Physics, Tracks, Deformation, Soil, AxleRig, RockField },
  };
}

// The ground surface follows the car and picks up the new ruts.
function updateGroundSurface(world, groundSurface) {
  const car = world.queryFirst(IsPlayer, Vehicle);
  if (!car) return;
  const p = car.get(Vehicle).body.translation();
  groundSurface.update(p.x, p.z);
}

// Worker physics: the draw side keeps its own copy of the tyre solver's ground grid (for the
// track contacts) and of the nearby rocks (the tyre mesh keeps its tread out of them).
function syncRemoteSolver(world) {
  const vehicle = world.queryFirst(IsPlayer, Vehicle)?.get(Vehicle);
  const solver = vehicle?.controller.gpu?.solver;
  if (!solver) return;
  solver.setGround ??= () => {};
  solver.setRocks ??= (rocks) => (solver.rockList = rocks);
  const p = vehicle.body.translation();
  updateGpuGround(solver, world.get(HeightField).heightAt, p.x, p.z, world.get(Deformation).map);
  const last = solver.rockCentre;
  if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 3) {
    const rocks = [];
    world.query(RockField).forEach((e) => rocks.push(...e.get(RockField).rocks));
    updateGpuRocks(solver, rocks, p.x, p.z);
    solver.rockCentre = { x: p.x, z: p.z };
  }
}

main().catch((error) => {
  console.error(error);
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = String(error?.stack ?? error);
  document.body.append(pre);
});
