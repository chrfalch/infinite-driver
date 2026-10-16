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
  View,
  WheelRig,
} from './ecs/traits.js';
import { createRenderer } from './render/scene.js';
import { createGauges } from './ui/gauges.js';
import { createMinimap, forwardOf } from './ui/minimap.js';
import { LIVERIES } from './render/trophy-body.js';
import { attachZoom, followCamera, isCockpitCamera, isFollowCamera, orbitCamera, toggleCockpitCamera, toggleFollowCamera } from './systems/camera.js';
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
import { worldMode } from './world.js';
import { setGroundPatch, setTerrainWorld } from './render/terrain-mesh.js';
import { SNOW_PATCH_N, SnowSurface } from './render/snow-surface.js';
import { createDaylight } from './render/daylight.js';
import { startHour } from './render/time-of-day.js';
import { createWater } from './render/water.js';
import { createWaterSpray } from './render/water-spray.js';
import { updateWater } from './systems/water.js';
import { createHeightCache } from './terrain/height-cache.js';
import { setBuildingCutaway } from './render/building-mesh.js';
import { loadTownKit } from './render/town-kit-mesh.js';
import { loadYardKit } from './render/yard-kit-mesh.js';
import { createPropsView } from './render/props-mesh.js';
import { createTrackMarkersView } from './render/track-markers-mesh.js';
import { createPropPhysics } from './physics/props.js';
import { createBarrierPhysics } from './physics/barriers.js';
import { createStadiumView } from './render/stadium-mesh.js';
import { GroundSurface, PATCH_N } from './render/ground-surface.js';
import { showRutsOnSheet } from './render/rock-surface.js';
import { DEFORM_CELL } from './terrain/deformation.js';
import { applyPendingCarAction, footprint, requestDespawn, requestRebuild, requestRespawn, requestRespawnAt, spawnCar, startHeight } from './vehicle/spawn.js';
import { createTuningPanel } from './tuning/panel.js';
import { loadPanelOpen, panelStartsOpen, savePanelOpen } from './tuning/panel-state.js';
import { updateInstanceBatchers } from './render/instance-batcher.js';
import { warmInstancedMeshes } from './render/instance-pool.js';
import { createPhysicsClient, workerGpuSupported } from './physics/client.js';
import { ROCK_COUNT, connectSnowTiles, loadTerrain, startChunkWorker } from './systems/terrain.js';
import { playerTires } from './vehicle/config.js';
import { configuredRivals, gridSlot } from './vehicle/cars.js';
import { createCourse, gridSpot } from './ai/course.js';
import { createDriver } from './ai/driver.js';
import { updateDrivers } from './systems/ai.js';
import { HOLD, createRace } from './systems/race.js';
import { createRaceHud } from './ui/race-hud.js';
import { updateGpuGround, updateGpuRocks } from './tire/gpu-tires.js';
import { createTouchControls } from './ui/touch-controls.js';
import { count, reportError, sample, startOverlay, timed } from './perf.js';
import { AudioFeed, createFeedBuffer } from './audio/feed.js';
import { createAudio } from './audio/audio.js';
import { takeEarlyContext } from './audio/early-context.js';

// The game, loaded by start.js once a world is picked; `loading` is the loading screen
// (ui/loading.js), up until the drive is ready.
export async function main(loading) {
  const container = document.getElementById('app');
  const params = new URLSearchParams(location.search);
  // The engine sound reads every physics step from here (audio/feed.js); ?sound=0 turns it off.
  // Its recordings load and decode alongside everything else; it starts only as the loading screen
  // goes (armed then), not on taps while loading: on the context the world pick started, if any.
  const audioFeed = new AudioFeed(createFeedBuffer());
  const earlyContext = takeEarlyContext();
  const audio = params.get('sound') === '0' ? null : createAudio({ feed: audioFeed, armed: !loading, context: earlyContext });
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
  const [render] = await Promise.all([createRenderer(container), glyph.init()]);
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
  if (heightAt.town) {
    loading?.set('world', 0.3, 'Building the town');
    await Promise.all([loadTownKit(), loadYardKit()]);
  }
  // The town's river and ponds, and the stadium's water holes: their waves, and the spray the cars
  // throw up in them.
  const water = heightAt.waterLevel !== undefined ? createWater(render.scene, heightAt.waterLevel, (x, z) => heightAt.waterLevel - heightAt(x, z)) : null;
  const waterSpray = water ? createWaterSpray(render.scene, { low: render.quality === 'low' }) : null;
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

  // The other cars (?rivals=rigid,gpu: each its own tyre model; three on the stadium by default;
  // see vehicle/cars.js).
  const rivals = configuredRivals(location.search, mode);
  // The AI drivers' pace (a share of the course's speed profile) and, for tuning, the cornering and
  // braking the profile allows (m/s², see speedProfile).
  const aiPace = Number(params.get('aipace') ?? 1);
  const aiGrip = { ...(params.get('ailateral') && { lateral: Number(params.get('ailateral')) }), ...(params.get('aibraking') && { braking: Number(params.get('aibraking')) }) };
  // Physics runs in a worker (with its own GPU device) for the GPU tyres when the browser has
  // WebGPU in workers; ?physics=main keeps it on this thread. Other tyre modes for the player's
  // car stay here, and so does everything when another car runs Rapier's soft tyres (the worker
  // has GPU tyres and rigid wheels only).
  const useWorker =
    playerTires() === 'gpu' && rivals.every((r) => r.tires !== 'soft') && params.get('physics') !== 'main' && (await workerGpuSupported());
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
  // Rapier is loaded here only for physics on this thread: the worker has its own, and the page
  // then never downloads this copy (about 4 MB of script with its wasm inlined).
  let RAPIER = null;
  if (!remote) {
    RAPIER = (await import('@dimforge/rapier3d-compat')).default;
    await RAPIER.init();
    physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    physicsWorld.timestep = 1 / 120;
    // The jointed car is a chain of light links under a heavy chassis; Rapier's default 4 solver
    // iterations leave it leaning and trembling at rest. 8 settles it level and still.
    physicsWorld.numSolverIterations = 8;
  }

  loading?.set('physics', 1, 'Bolting the car together');
  await loading?.pause();

  // The sunny town's crates, cones and yard props: drawn here, simulated where the physics runs.
  const propsView = heightAt.town ? createPropsView(render.scene, heightAt) : null;
  const propPhysics = heightAt.town && physicsWorld ? createPropPhysics(RAPIER, physicsWorld, heightAt) : null;
  // The dry river's course markers: flags, chevron boards, tyre stacks and the start gantry.
  const trackMarkers = heightAt.beds ? createTrackMarkersView(render.scene, heightAt) : null;
  // The stadium's rails, wall, gantry and stands: drawn here, the walls simulated where the physics runs.
  if (heightAt.barriers) {
    createStadiumView(render.scene, heightAt);
    if (physicsWorld) createBarrierPhysics(RAPIER, physicsWorld, heightAt);
  }

  world.add(Time, Input, TerrainStreaming);
  world.get(Input).headlights = night;
  daylight.onDarkChange = (dark) => (world.get(Input).headlights = dark);
  world.add(Physics({ rapier: RAPIER, world: physicsWorld, remote, accumulator: 0, step: 1 / 120, stepMs: 0, simTime: 0, displayTime: 0 }));
  // Main-thread physics writes the audio feed itself; worker physics writes it in the worker.
  if (!remote) world.get(Physics).audioFeed = audioFeed;
  world.add(Render(render));
  const surfaceAt = (x, z) => heightAt(x, z) + deformation.at(x, z);
  world.add(HeightField({ heightAt, surfaceAt }));
  // Water drops in flight look for the ground every frame: from a coarse cache.
  if (water) water.groundAt = createHeightCache(heightAt, { cell: 0.5, bits: 8 });
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
  // The tracks' floor follows the ruts near the car (render/rut-map.js). Four wheels per car, each
  // car in its own slot (Vehicle.slot); cars added later beyond these leave no tracks.
  world.add(
    Tracks({
      renderer: new TireTracks(render.scene, { wheels: 4 * (1 + rivals.length), segments: GROUND.trackLength, deformation, ruts, snow: !!heightAt.snow }),
      contacts: [null, null, null, null],
    }),
  );

  // The car starts just above the ground at the origin (on the road or river bed, facing along it),
  // above the highest ground under it so no wheel starts inside a slab.
  const startYaw = heightAt.roadHeading ? heightAt.roadHeading(0, 0) : 0;
  const startPose = (x, z, tires, yaw = startYaw) => ({
    position: { x, y: footprint(heightAt, x, z, yaw).max + startHeight(tires), z },
    rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  });
  // On a course (the stadium) the cars start two abreast on a grid along it, and the others are
  // driven by AI drivers (?ai=0 leaves them standing); elsewhere they line up behind the player's.
  const course = createCourse(heightAt);
  const spot = (n) => (course && rivals.length ? gridSpot(course, n) : { ...gridSlot(0, 0, startYaw, n), yaw: startYaw });
  const ai = course && params.get('ai') !== '0';
  // With other cars, every car waits on the grid for a 3-2-1 countdown (?countdown=0 skips it);
  // the game can be paused anywhere (systems/race.js).
  const race = createRace({ countdown: rivals.length > 0 && params.get('countdown') !== '0' });
  const first = spot(0);
  spawnCar(world, startPose(first.x, first.z, playerTires(), first.yaw));
  rivals.forEach((rival, i) => {
    const { x, z, yaw } = spot(i + 1);
    // A spread of pace through the field (?aipace= scales it).
    const driver = ai ? createDriver(course, { ...aiGrip, pace: aiPace * (1 - 0.03 * (i % 4)), seed: i + 1 }) : null;
    spawnCar(world, { ...startPose(x, z, rival.tires, yaw), tires: rival.tires, livery: rival.livery, player: false, driver, slot: i + 1 });
  });
  const panel = createTuningPanel(world, { heightAt });
  const touch = createTouchControls({ onRespawn: () => requestRespawn(world, heightAt), onCamera: () => toggleFollowCamera(), onCockpit: () => toggleCockpitCamera(), cockpit: isCockpitCamera() });
  // The panel opens as the player last left it (small screens start folded the first time).
  if (!panelStartsOpen(loadPanelOpen(), window.innerWidth < 700 || touch.isVisible())) panel.close();
  panel.onOpenClose((changed) => {
    if (changed === panel) savePanelOpen(!panel._closed);
  });

  loading?.set('car', 1, 'Raising the terrain');
  await loading?.pause();

  // The chunk worker first, so the initial load can hand it the rock sheets (dry river).
  startChunkWorker({ mode });
  connectSnowTiles(groundSurface.tiles);
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
  // The countdown's numbers (with a beep each) and the pause button; paused, the engines fade out.
  const raceHud = createRaceHud(race, { onPause: (paused) => audio?.setPaused(paused), onCount: (label) => audio?.beep(label === 'GO!') });
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
    if (render.dof.enabled) render.dof.render(camera, render.focusDistance);
    else renderer.render(scene, camera);
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
      holdPlayer();
      await stepPhysics(world, Math.min(delta, 0.1));
    } catch (error) {
      console.error(error);
    } finally {
      busy = false;
      // A new task (not a microtask), so a chain of slow batches never starves the animation frame.
      if (!document.hidden && !race.paused && performance.now() - simLast >= physicsStep * 1000) setTimeout(() => busy || race.paused || simulate(), 0);
    }
  };
  // On the grid until the countdown ends: the player's car on the handbrake (it can still steer and
  // the throttle still opens, for a launch on 'GO!'), the AI cars likewise.
  const holdPlayer = () => {
    if (race.held()) Object.assign(world.get(Input), { throttle: 0, brake: 0, handbrake: true });
  };
  const holdDrivers = () =>
    world.query(Vehicle).forEach((car) => {
      const vehicle = car.get(Vehicle);
      if (vehicle.driver) vehicle.input = { ...HOLD };
    });
  startOverlay();
  const frame = (now) => {
    const fStart = performance.now();
    sample('frame.interval', now - last);
    if (now - last > 50) count('longFrames');
    count('wallSeconds', Math.min((now - last) / 1000, 0.1));
    const time = world.get(Time);
    // Paused, the world's clock stands still (physics, AI, particles); the camera still turns.
    const realDelta = Math.min((now - last) / 1000, 0.1);
    race.update(realDelta);
    time.delta = race.paused ? 0 : realDelta;
    time.elapsed += time.delta;
    last = now;
    // Safari shows a white canvas for any animation frame that draws nothing, so an error in a
    // system must not skip the draw: it is logged (and counted in the ?perf overlay) instead.
    try {
      // The AI drivers set their cars' inputs for this frame's physics.
      if (race.held()) holdDrivers();
      else timed('sys.ai', () => updateDrivers(world));
      if (remote) {
        // The worker steps on its own clock; send it this frame's input and take its newest time.
        // Paused, it gets no ticks and so does not step.
        if (!race.paused) {
          applyPendingCarAction();
          readInput(world);
          holdPlayer();
          remote.tick(world.get(Input), otherInputs(world));
        }
        const physics = world.get(Physics);
        physics.simTime = remote.simTime;
        physics.stepMs = remote.stepMs;
        timed('sys.remoteSolver', () => syncRemoteSolver(world));
      } else if (!busy && !race.paused) simulate();

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
      orbitCamera(readCameraKeys(), realDelta);
      raceHud.update();
      timed('sys.followCamera', () => followCamera(world, realDelta));
      const player = world.queryFirst(IsPlayer, Vehicle);
      if (player && trackMarkers) {
        const p = player.get(Vehicle).body.translation();
        timed('sys.trackMarkers', () => trackMarkers.update(p.x, p.z));
      }
      if (player && water) {
        const p = player.get(Vehicle).body.translation();
        timed('sys.water', () => {
          updateWater(world, water, waterSpray, render.activeCamera, daylight.dark);
          water.update(p.x, p.z, time.delta);
        });
      }
      if (player && heightAt.town) {
        const p = player.get(Vehicle).body.translation();
        setBuildingCutaway(isCockpitCamera() ? null : p, render.activeCamera);
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
        if (minimap) timed('sys.minimap', () => minimap.update(vehicle.body.translation(), vehicle.body.rotation(), otherCars(world)));
        audio?.update(vehicle, world.get(Soil), render.activeCamera);
        if (audio) {
          const others = [];
          world.query(Vehicle).forEach((car) => car.has(IsPlayer) || others.push(car.get(Vehicle)));
          audio.updateRivals(vehicle, others, render.activeCamera);
        }
        gauges.update(vehicle, time.delta, { follow: isFollowCamera() && !isCockpitCamera(), perf: CONTROLS.showPerf ? perfLines(vehicle) : null, throttleLock: world.get(Input).throttleLock, headlights: world.get(Input).headlights });
        { const v = player.get(Vehicle).body.linvel(); sample('speed.kmh', Math.hypot(v.x, v.z) * 3.6); }
      }
      timed('sys.glyph', () => glyph.shape());
    } catch (error) {
      count('frameErrors');
      reportError(error);
    }
    timed('draw', draw);
    warmInstancedMeshes();
    sample('frame.js', performance.now() - fStart);
    loading?.frame(now);
  };
  render.renderer.setAnimationLoop(frame);

  // The drive starts as soon as everything is in. The sound starts with it on the context the
  // world pick started (browsers start sound only from a gesture); without one (a world from the
  // URL or the panel's reload), on the first tap or key press. M turns it on and off.
  // The countdown starts with it.
  const startSound = () => {
    audio?.arm();
    if (earlyContext) audio?.unlock();
    race.start();
  };
  if (loading) loading.finish({ sound: soundLoaded, start: startSound });
  else race.start();

  // Handy for debugging from the console.
  window.__game = {
    world,
    RAPIER,
    render,
    get car() {
      return world.queryFirst(IsPlayer, Vehicle);
    },
    // Every car's entity, the player's among them.
    get cars() {
      const cars = [];
      world.query(Vehicle).forEach((car) => cars.push(car));
      return cars;
    },
    // The course the AI drivers drive (null in worlds without one).
    course,
    // The countdown and the pause: race.phase, race.paused; pause(true/false) as the button does.
    race,
    pause: (paused = true) => raceHud.setPaused(paused),
    // Another car at (x, z) facing `yaw`, on tyre model `tires` (see TIRE_MODES); drive it by setting
    // its Vehicle's `input` ({ throttle, brake, steer, handbrake }), or give it an AI driver
    // (`ai: true`, or options for createDriver; on a course). Returns its entity.
    addCar: ({ x, z, yaw = 0, tires = 'rigid', livery = 'red', input = null, ai: aiOptions = null }) =>
      spawnCar(world, {
        position: { x, y: footprint(heightAt, x, z, yaw).max + startHeight(tires), z },
        rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
        tires,
        livery,
        input,
        driver: aiOptions && course ? createDriver(course, aiOptions === true ? {} : aiOptions) : null,
        player: false,
      }),
    // Takes a car out (at the start of the next frame).
    removeCar: (car) => requestDespawn(world, car),
    respawnAt: (x, z, yaw, options) => requestRespawnAt(world, heightAt, x, z, yaw, options),
    // Rebuilds every car in place, as a settings change does.
    rebuild: () => requestRebuild(world),
    heightAt,
    // The ground (or snow) patch around the car, with its ruts.
    groundSurface,
    // The water's waves and spray (worlds with water).
    water,
    waterSpray,
    audio,
    audioFeed,
    minimap,
    traits: { Vehicle, View, IsPlayer, WheelRig, SteeringWheel, Input, Time, Physics, Tracks, Deformation, Soil, AxleRig, RockField },
  };
}

// The ground surface follows the car and picks up the new ruts.
function updateGroundSurface(world, groundSurface) {
  const car = world.queryFirst(IsPlayer, Vehicle);
  if (!car) return;
  const p = car.get(Vehicle).body.translation();
  groundSurface.update(p.x, p.z);
}

// Worker physics: the draw side keeps its own copy of each GPU car's tyre solver ground grid (for
// the track contacts) and of the nearby rocks (the tyre mesh keeps its tread out of them).
function syncRemoteSolver(world) {
  let rocks = null;
  world.query(Vehicle).forEach((car) => {
    const vehicle = car.get(Vehicle);
    const solver = vehicle.controller.gpu?.solver;
    if (!solver) return;
    solver.setGround ??= () => {};
    solver.setRocks ??= (list) => (solver.rockList = list);
    const p = vehicle.body.translation();
    updateGpuGround(solver, world.get(HeightField).heightAt, p.x, p.z, world.get(Deformation).map);
    const last = solver.rockCentre;
    if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 3) {
      if (!rocks) {
        rocks = [];
        world.query(RockField).forEach((e) => rocks.push(...e.get(RockField).rocks));
        const { heightAt } = world.get(HeightField);
        if (heightAt.barrierRocks) rocks.push(...heightAt.barrierRocks);
      }
      updateGpuRocks(solver, rocks, p.x, p.z);
      solver.rockCentre = { x: p.x, z: p.z };
    }
  });
}

// The other cars for the minimap: where each is, which way it faces, its paint.
function otherCars(world) {
  const cars = [];
  world.query(Vehicle, View).forEach((car) => {
    if (car.has(IsPlayer)) return;
    const { body } = car.get(Vehicle);
    const p = body.translation();
    const f = forwardOf(body.rotation());
    const livery = LIVERIES[car.get(View).object.userData.spec?.livery] ?? LIVERIES.red;
    cars.push({ x: p.x, z: p.z, fx: f.x, fz: f.z, colour: livery.base });
  });
  return cars;
}

// The other cars' drivers for the worker: [id, input] for each car with an input of its own.
function otherInputs(world) {
  const inputs = [];
  world.query(Vehicle).forEach((car) => {
    const { id, input } = car.get(Vehicle);
    if (input && !car.has(IsPlayer)) inputs.push([id, { ...input }]);
  });
  return inputs;
}
