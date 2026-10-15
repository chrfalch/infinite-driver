import { relation, trait } from 'koota';

// World traits (global state).
// Callback traits are stored by reference, so systems can mutate them in place.
export const Time = trait(() => ({ delta: 0, elapsed: 0 }));
export const Input = trait(() => ({ engineOn: false, throttle: 0, throttleLock: null, brake: 0, steer: 0, handbrake: false, headlights: false }));
// simTime: seconds simulated so far; displayTime: the (slightly earlier) time the car is drawn at.
export const Physics = trait(() => ({ rapier: null, world: null, accumulator: 0, step: 1 / 120, stepMs: 0, simTime: 0, displayTime: 0 }));
export const Render = trait(() => ({ renderer: null, scene: null, camera: null, sun: null, hemi: null, daylight: null, hudScene: null, hudCamera: null }));
// heightAt: the generated terrain; surfaceAt: terrain plus ruts and berms (see Deformation).
export const HeightField = trait(() => ({ heightAt: null, surfaceAt: null }));
export const Deformation = trait(() => ({ map: null }));
// Tyre contact per wheel of the player's car this frame ({ x, z, depth } or null), found by the
// track system (every car's are in its Vehicle's `groundContacts`).
export const Tracks = trait(() => ({ renderer: null, contacts: [null, null, null, null] }));
export const Soil = trait(() => ({ particles: null, fines: null, carry: [0, 0, 0, 0], spin: [0, 0, 0, 0] }));
export const TerrainStreaming = trait({ radius: 2, colliderRadius: 1 });

// Entity traits.
export const Transform = trait(() => ({
  position: { x: 0, y: 0, z: 0 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
}));
export const View = trait(() => ({ object: null }));
export const RigidBody = trait(() => ({ body: null }));
// tires: the car's tyre model ('gpu', 'soft' or 'rigid', see TIRE_MODES in vehicle/config.js).
// input: the driver's pedals and steering for a car other than the player's (the player's come
// from the world's Input); null holds it still. id: the car's id (the worker's, with worker physics).
// slot: its place in the shared tyre-track mesh (see Tracks).
export const Vehicle = trait(() => ({ controller: null, body: null, drivetrain: null, steer: 0, speed: 0, tires: 'gpu', input: null, id: 0, slot: 0 }));
export const IsPlayer = trait();
export const CameraTarget = trait();
export const TerrainChunk = trait(() => ({ cx: 0, cz: 0, collider: null, heights: null }));
export const WheelRig = trait(() => ({ rig: null }));
// A soft tyre's world-space mesh: from a Rapier soft body, or tyre `index` of a GPU solver.
export const SoftTireView = trait(() => ({ soft: null, gpu: null, index: 0, object: null }));
export const SteeringWheel = trait(() => ({ object: null }));
export const AxleRig = trait(() => ({ rig: null }));
export const RockField = trait(() => ({ rocks: [], colliders: [] }));

// A wheel belongs to a vehicle and knows its index in the Rapier controller.
export const WheelOf = relation({ exclusive: true, store: { index: 0 } });
