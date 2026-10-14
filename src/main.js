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
import { createMinimap } from './ui/minimap.js';
import { attachZoom, followCamera, isFollowCamera, orbitCamera, toggleFollowCamera } from './systems/camera.js';
import { attachKeyboard, readCameraKeys, readInput } from './systems/input.js';
import { CONTROLS } from './controls.js';
import { stepPhysics } from './systems/physics.js';
import { syncBodies } from './systems/draw-sync.js';
import { streamTerrain } from './systems/terrain.js';
import { syncAntenna, syncAxles, syncLights, syncEngine, syncSoftTires, syncViews, syncWheels } from './systems/views.js';
import { updateTracks } from './systems/tracks.js';
import { updateSoil } from './systems/soil.js';
import { updateBushes } from './systems/vegetation.js';
import { SoilParticles, createFineParticles } from './render/soil-particles.js';
import { TireTracks } from './render/tracks.js';
import { GROUND, setPavedRoads, setSnowCover } from './tire/config.js';
import { GroundDeformation } from './terrain/deformation.js';
import { createHeightField } from './terrain/height.js';
import { WORLDS, switchWorld, worldMode } from './world.js';
import { setGroundPatch, setTerrainWorld } from './render/terrain-mesh.js';
import { SNOW_PATCH_N, SnowSurface } from './render/snow-surface.js';
import { createDaylight } from './render/daylight.js';
import { startHour } from './render/time-of-day.js';
import { createWater } from './render/water.js';
import { setBuildingCutaway } from './render/building-mesh.js';
import { loadTownKit } from './render/town-kit-mesh.js';
import { createPropsView } from './render/props-mesh.js';
import { createTrackMarkersView } from './render/track-markers-mesh.js';
import { createPropPhysics } from './physics/props.js';
import { GroundSurface, PATCH_N } from './render/ground-surface.js';
import { showRutsOnSheet } from './render/rock-surface.js';
import { DEFORM_CELL } from './terrain/deformation.js';
import { applyPendingCarAction, footprint, requestRespawn, requestRespawnAt, spawnCar, startHeight } from './vehicle/spawn.js';
import { createTuningPanel } from './tuning/panel.js';
import { loadPanelOpen, panelStartsOpen, savePanelOpen } from './tuning/panel-state.js';
import { updateInstanceBatchers } from './render/instance-batcher.js';
import { createPhysicsClient, workerGpuSupported } from './physics/client.js';
import { ROCK_COUNT, loadTerrain, startChunkWorker } from './systems/terrain.js';
import { CAR } from './vehicle/config.js';
import { updateGpuGround, updateGpuRocks } from './tire/gpu-tires.js';
import { createTouchControls } from './ui/touch-controls.js';
import { createLoadingScreen } from './ui/loading.js';
import { count, reportError, sample, startOverlay, timed } from './perf.js';
import { AudioFeed, createFeedBuffer } from './audio/feed.js';
import { createAudio } from './audio/audio.js';
import { AUDIO } from './audio/config.js';

// The loading screen, until the drive is ready (ui/loading.js).
const loading = createLoadingScreen();

async function main() {
  const container = document.getElementById('app');
  const params = new URLSearchParams(location.search);
  // The world picker on the loading screen (the panel has one too).
  loading?.levels(WORLDS, worldMode(), (mode) => (location.href = switchWorld(mode)));
  // The engine sound reads every physics step from here (audio/feed.js); ?sound=0 turns it off.
  // Its recordings load and decode alongside everything else; it starts only as the loading screen
  // goes (armed then), not on taps while loading.
  const audioFeed = new AudioFeed(createFeedBuffer());
  const audio = params.get('sound') === '0' ? null : createAudio({ feed: audioFeed, armed: !loading });
  const soundLoaded = audio
    ? audio.preload((done, total) => {
        loading?.set('sound', total ? done / total : 0);
        loading?.note('sound', total ? `sounds ${done}/${total}` : 'sounds…');
      })
    : Promise.resolve();
  soundLoaded.then(() => {
    loading?.set('sound', 1);
    loading?.note('sound', null);
  });

  loading?.set('gpu', 0.1, 'Waking up the GPU');
  const [render] = await Promise.all([createRenderer(container), RAPIER.init(), glyph.init()]);
  loading?.set('gpu', 1, 'Surveying the land');
  await loading?.pause();

  // The frame updates world matrices itself, before the instanced parts read them (see draw).
  render.scene.matrixWorldAutoUpdate = false;
  const world = createWorld();
  // The world from the panel's picker (red-rock canyon by default, or the dry river);
  // ?terrain=flat (tests), ?terrain=hills, ?terrain=ramp&slope=20 (a straight climb for hill-start
  // tests), or any world overrides it.
  let mode = worldMode();
  if (mode === 'ramp') mode = `ramp:${new URLSearchParams(location.search).get('slope') ?? 20}`;
  setTerrainWorld(mode);
  // The light, sky and haze for the time of day (the panel's slider, ?time=18.5; render/time-of-day.js).
  // After dark the headlights come on, and the town's windows light up.
  const daylight = createDaylight(render, mode);
  render.daylight = daylight;
  daylight.set(startHour(mode));
  const night = daylight.dark > 0.5;
  const heightAt = createHeightField({ mode });
  // The sunny town's buildings are models: loaded before its first chunk is built.
  if (heightAt.buildingKit) {
    loading?.set('world', 0.3, 'Building the town');
    await loadTownKit();
  }
  // The town's river and ponds.
  const water = heightAt.waterLevel !== undefined ? createWater(render.scene, heightAt.waterLevel) : null;
  // The tyres, compaction and spray treat the ground as snow in the snowfield.
  setSnowCover(heightAt.snow);
  setPavedRoads(heightAt.paved);
  const deformation = new GroundDeformation();
  // The ground near the car, drawn with its ruts: snow on the snowfield, soil elsewhere.
  const groundSurface = heightAt.snow ? new SnowSurface(render.scene, heightAt, deformation) : new GroundSurface(render.scene, heightAt, deformation);
  groundSurface.onMove = setGroundPatch;
  // The dry river's rock sheet shows the ruts in its soil pockets from the same texture.
  const ruts = heightAt.snow
    ? { origin: groundSurface.origin, n: SNOW_PATCH_N, cell: DEFORM_CELL, absolute: true, read: (ix, iz) => groundSurface.heightNode(ix, iz) }
    : { deform: groundSurface.deform, origin: groundSurface.origin, n: PATCH_N, cell: DEFORM_CELL };
  if (heightAt.rockAt) showRutsOnSheet(ruts);

  loading?.set('world', 1, 'Starting the physics');
  await loading?.pause();

  // Physics runs in a worker (with its own GPU device) for the GPU tyres when the browser has
  // WebGPU in workers; ?physics=main keeps it on this thread. Other tyre modes stay here.
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

  loading?.set('physics', 1, 'Bolting the car together');
  await loading?.pause();

  // The sunny town's loose crates and cones: drawn here, simulated where the physics runs.
  const propsView = heightAt.buildingKit ? createPropsView(render.scene, heightAt) : null;
  const propPhysics = heightAt.buildingKit && physicsWorld ? createPropPhysics(RAPIER, physicsWorld, heightAt) : null;
  // The dry river's course markers: flags, chevron boards, tyre stacks and the start gantry.
  const trackMarkers = heightAt.beds ? createTrackMarkersView(render.scene, heightAt) : null;

  world.add(Time, Input, TerrainStreaming);
  world.get(Input).headlights = night;
  daylight.onDarkChange = (dark) => (world.get(Input).headlights = dark);
  world.add(Physics({ rapier: RAPIER, world: physicsWorld, remote, accumulator: 0, step: 1 / 120, stepMs: 0, simTime: 0, displayTime: 0 }));
  // Main-thread physics writes the audio feed itself; worker physics writes it in the worker.
  if (!remote) world.get(Physics).audioFeed = audioFeed;
  world.add(Render(render));
  const surfaceAt = (x, z) => heightAt(x, z) + deformation.at(x, z);
  world.add(HeightField({ heightAt, surfaceAt }));
  world.add(Deformation({ map: deformation }));
  // Powder snow hangs in the air longer than clumps of soil, and light shines through it.
  // Sand and dust grains on soil (not on snow: the powder spray is already fine).
  world.add(
    Soil({
      particles: new SoilParticles(render.scene, heightAt.snow ? { drag: 3, powder: true } : undefined),
      fines: heightAt.snow ? null : createFineParticles(render.scene),
      carry: [0, 0, 0, 0],
      spin: [0, 0, 0, 0],
    }),
  );
  // The tracks' floor follows the ruts near the car (render/rut-map.js).
  world.add(
    Tracks({
      renderer: new TireTracks(render.scene, { segments: GROUND.trackLength, deformation, ruts, snow: !!heightAt.snow }),
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
  // The panel opens as the player last left it (small screens start folded the first time).
  if (!panelStartsOpen(loadPanelOpen(), window.innerWidth < 700 || touch.isVisible())) panel.close();
  panel.onOpenClose((changed) => {
    if (changed === panel) savePanelOpen(!panel._closed);
  });

  loading?.set('car', 1, 'Raising the terrain');
  await loading?.pause();

  // The chunk worker first, so the initial load can hand it the rock sheets (dry river).
  startChunkWorker({ mode });
  await loadTerrain(world, {
    onProgress: (done, total) => {
      loading?.set('terrain', total ? done / total : 1);
      loading?.note('terrain', `terrain ${done}/${total}`);
    },
    pause: loading?.pause,
  });
  loading?.note('terrain', null);
  loading?.set('hud', 0.2, 'Painting the gauges');

  // HUD text through Glyph.
  const hud = glyph.handle('hud', ThreeConfig);
  const inter = glyph.fontFace('/fonts/inter-latin.font.glb');
  await inter.load();
  // Speedometer, tachometer, and gear indicator.
  const gauges = createGauges({ hud, font: inter, scene: render.hudScene });
  // Round map of the ground around the car, bottom left (?map=0 hides it).
  const minimap = params.get('map') === '0' ? null : createMinimap(heightAt);
  loading?.set('hud', 1, 'Warming up the engine');

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
      timed('sys.syncLights', () => syncLights(world));
      timed('sys.syncAntenna', () => syncAntenna(world));
      timed('sys.syncEngine', () => syncEngine(world));
      timed('sys.updateTracks', () => updateTracks(world));
      timed('sys.updateSoil', () => updateSoil(world));
      timed('sys.groundSurface', () => updateGroundSurface(world, groundSurface));
      timed('sys.updateBushes', () => updateBushes(world));
      orbitCamera(readCameraKeys(), time.delta);
      timed('sys.followCamera', () => followCamera(world));
      const player = world.queryFirst(IsPlayer, Vehicle);
      if (player && trackMarkers) {
        const p = player.get(Vehicle).body.translation();
        timed('sys.trackMarkers', () => trackMarkers.update(p.x, p.z));
      }
      if (player && heightAt.town) {
        const p = player.get(Vehicle).body.translation();
        water?.update(p.x, p.z);
        setBuildingCutaway(p, render.activeCamera);
        if (propsView) {
          propPhysics?.update(p.x, p.z);
          propsView.update(p.x, p.z);
          if (remote) for (const poses of remote.propPoses.splice(0)) propsView.apply(poses);
          else propsView.apply(propPhysics.moved());
        }
      }
      if (player) {
        const canvas = render.renderer.domElement;
        gauges.layout(canvas.clientWidth, canvas.clientHeight, touch.isVisible(), minimap?.root.offsetWidth ?? 0);
        const vehicle = player.get(Vehicle);
        if (minimap) timed('sys.minimap', () => minimap.update(vehicle.body.translation(), vehicle.body.rotation()));
        audio?.update(vehicle, world.get(Soil), render.activeCamera);
        gauges.update(vehicle, time.delta, { follow: isFollowCamera(), perf: CONTROLS.showPerf ? perfLines(vehicle) : null, throttleLock: world.get(Input).throttleLock, headlights: world.get(Input).headlights });
        { const v = player.get(Vehicle).body.linvel(); sample('speed.kmh', Math.hypot(v.x, v.z) * 3.6); }
      }
      timed('sys.glyph', () => glyph.shape());
    } catch (error) {
      count('frameErrors');
      reportError(error);
    }
    timed('draw', draw);
    sample('frame.js', performance.now() - fStart);
    loading?.frame(now);
  };
  render.renderer.setAnimationLoop(frame);

  // The drive starts on a tap or key press once everything is in, so the sound (which browsers
  // start only from such a gesture) starts with it; no need if the sound is off. Browsers driven
  // by a script skip the prompt. Gestures start the sound from then on (M turns it on later).
  const soundToStart = () => !!audio && audio.state === 'off' && AUDIO.enabled && !navigator.webdriver;
  const startSound = (gesture) => {
    audio?.arm();
    if (gesture) audio?.unlock();
  };
  loading?.finish({ sound: soundLoaded, prompt: soundToStart, start: startSound });

  // Handy for debugging from the console.
  window.__game = {
    world,
    RAPIER,
    render,
    get car() {
      return world.queryFirst(IsPlayer, Vehicle);
    },
    respawnAt: (x, z, yaw, options) => requestRespawnAt(world, heightAt, x, z, yaw, options),
    heightAt,
    audio,
    audioFeed,
    minimap,
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
  loading?.remove();
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = String(error?.stack ?? error);
  document.body.append(pre);
});
