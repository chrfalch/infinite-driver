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
import { attachZoom, followCamera, isFollowCamera, toggleFollowCamera } from './systems/camera.js';
import { updateHud } from './systems/hud.js';
import { attachKeyboard, readInput } from './systems/input.js';
import { stepPhysics, syncBodies } from './systems/physics.js';
import { streamTerrain } from './systems/terrain.js';
import { syncAxles, syncBrakeLights, syncSoftTires, syncViews, syncWheels } from './systems/views.js';
import { updateTracks } from './systems/tracks.js';
import { updateSoil } from './systems/soil.js';
import { updateBushes } from './systems/vegetation.js';
import { SoilParticles } from './render/soil-particles.js';
import { TireTracks } from './render/tracks.js';
import { GROUND } from './tire/config.js';
import { GroundDeformation } from './terrain/deformation.js';
import { createHeightField } from './terrain/height.js';
import { createRealHeightField } from './terrain/real.js';
import { resolvePlace } from './geo/place.js';
import { createWater } from './render/water.js';
import { createPhotoTiles } from './render/photo-tiles.js';
import { createCity } from './city/city.js';
import { createFacadeBaker, facadeTarget } from './render/facade-bake.js';
import { initRoofs } from './render/roofs.js';
import { setFacadeFocus } from './render/facade.js';
import { applyPendingCarAction, requestRespawn, requestRespawnAt, spawnCar, startHeight } from './vehicle/spawn.js';
import { createTuningPanel } from './tuning/panel.js';
import { createTouchControls } from './ui/touch-controls.js';

async function main() {
  const container = document.getElementById('app');
  const [render] = await Promise.all([createRenderer(container), RAPIER.init(), glyph.init()]);

  const world = createWorld();
  // Red-rock canyon with gravel roads by default; ?terrain=flat (tests) or ?terrain=hills.
  // ?place=oslo (or latitude,longitude, or an address) drives on real terrain with satellite imagery.
  const params = new URLSearchParams(location.search);
  const mode = params.get('terrain') ?? 'canyon';
  const place = params.get('place') ? await resolvePlace(params.get('place')) : null;
  const heightAt = place ? createRealHeightField(place) : createHeightField({ mode });
  // The elevation tiles under the start must be there before the car and the first chunks.
  if (place) await heightAt.load(-200, -200, 200, 200);
  // Real places are an OSM city by default: buildings and roads on satellite imagery.
  // ?tiles=google draws Google's photorealistic 3D tiles instead (needs VITE_GOOGLE_MAPS_KEY; the
  // buildings are not solid there); ?tiles=off shows the bare terrain and imagery.
  const googleKey = import.meta.env.VITE_GOOGLE_MAPS_KEY;
  const tilesMode = params.get('tiles') ?? 'city';
  if (place && googleKey && tilesMode === 'google') heightAt.real.photoTiles = true;
  // ?facades=google: real facade photos from Google's 3D tiles baked onto the buildings near the car.
  const facades =
    place && tilesMode === 'city' && googleKey && params.get('facades') === 'google'
      ? createFacadeBaker({ key: googleKey, place, renderer: render.renderer, heightAt })
      : null;
  const city =
    place && tilesMode === 'city' ? createCity({ projection: heightAt.real.projection, heightAt, scene: render.scene, facades }) : null;
  if (city) {
    // Pitched roofs need the straight skeleton module (flat roofs if it fails to load).
    if (facades) await initRoofs().catch((error) => console.warn('pitched roofs off', error));
    heightAt.real.city = city;
    // ?ground=photo: satellite imagery under the OSM city instead of the procedural ground.
    heightAt.real.groundPhoto = params.get('ground') === 'photo';
    await city.load(-200, -200, 200, 200);
  }
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
  const touch = createTouchControls({ onRespawn: () => requestRespawn(world, heightAt), onCamera: () => toggleFollowCamera() });
  // Small screens start with the panel folded so the road stays visible.
  if (window.innerWidth < 700 || touch.isVisible()) panel.close();

  streamTerrain(world, { force: true });
  const photoTiles = heightAt.real?.photoTiles ? createPhotoTiles({ key: googleKey, place, scene: render.scene, renderer: render.renderer, heightAt }) : null;
  // The 3D tiles have their own water.
  const water = place && !photoTiles ? createWater(render.scene) : null;

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
    'W / Up  accelerate (hold)    S / Down  brake, reverse    A D  steer    Q E  shift    L  low range    Space  handbrake    R  respawn    C  follow camera';
  const TOUCH_HINT = 'Hold the up button to drive, down to brake    Pinch to zoom';
  // On real terrain: where the car is (latitude, longitude).
  const whereText = (vehicle) => {
    if (!place) return '';
    const p = vehicle.body.translation();
    const { lat, lon } = heightAt.real.projection.toLonLat(p.x, p.z);
    return `    ${place.name.split(',')[0]}  ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  };
  world.spawn(
    HudLabel({
      text: hintText,
      format: (v) => (touch.isVisible() ? TOUCH_HINT : KEY_HINT) + (isFollowCamera() ? '    [follow camera on]' : '') + whereText(v),
    }),
  );

  attachKeyboard();
  attachZoom(render.renderer.domElement);

  let last = performance.now();
  // Physics can wait on the GPU (tyre readback), so it runs as its own async task and is never
  // overlapped: a new batch of steps starts only when the previous one is done, with all the time
  // that passed since. Drawing happens synchronously in every animation frame, whatever physics is
  // doing: Safari shows a blank (white) canvas for frames where nothing is drawn inside the
  // animation-frame callback, which flickered whenever a physics batch outlasted a frame.
  let busy = false;
  let pendingDelta = 0;
  const draw = () => {
    const { renderer, scene, activeCamera: camera, hudScene, hudCamera } = render;
    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.render(hudScene, hudCamera);
  };
  const simulate = async (delta) => {
    busy = true;
    try {
      // Queued rebuilds and respawns run here, never while physics awaits the GPU.
      applyPendingCarAction();
      readInput(world);
      await stepPhysics(world, delta);
    } catch (error) {
      console.error(error);
    } finally {
      busy = false;
    }
  };
  const frame = (now) => {
    const time = world.get(Time);
    time.delta = Math.min((now - last) / 1000, 0.1);
    time.elapsed += time.delta;
    last = now;
    pendingDelta = Math.min(pendingDelta + time.delta, 0.1);
    if (!busy) {
      simulate(pendingDelta);
      pendingDelta = 0;
    }

    syncBodies(world);
    streamTerrain(world);
    syncViews(world);
    syncWheels(world);
    syncAxles(world);
    syncSoftTires(world);
    syncBrakeLights(world);
    updateTracks(world);
    updateSoil(world);
    updateBushes(world);
    followCamera(world);
    if (water) water.follow(render.activeCamera);
    updateHud(world);
    const player = world.queryFirst(IsPlayer, Vehicle);
    if (photoTiles && player) photoTiles.update(render.activeCamera, player.get(Vehicle).body.translation());
    if (city && player) {
      const p = player.get(Vehicle).body.translation();
      city.update(world.get(Physics), p);
      setFacadeFocus(p);
    }
    if (player) {
      const canvas = render.renderer.domElement;
      gauges.layout(canvas.clientWidth, canvas.clientHeight, touch.isVisible());
      gauges.update(player.get(Vehicle), time.delta);
    }
    glyph.shape();
    draw();
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
    photoTiles,
    city,
    facades,
    facadeTarget,
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
