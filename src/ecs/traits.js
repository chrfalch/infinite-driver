import { relation, trait } from 'koota';

// World traits (global state).
// Callback traits are stored by reference, so systems can mutate them in place.
export const Time = trait(() => ({ delta: 0, elapsed: 0 }));
export const Input = trait(() => ({ engineOn: false, throttle: 0, brake: 0, steer: 0, handbrake: false }));
export const Physics = trait(() => ({ rapier: null, world: null, accumulator: 0, step: 1 / 120, stepMs: 0 }));
export const Render = trait(() => ({ renderer: null, scene: null, camera: null, sun: null, hudScene: null, hudCamera: null }));
// heightAt: the generated terrain; surfaceAt: terrain plus ruts and berms (see Deformation).
export const HeightField = trait(() => ({ heightAt: null, surfaceAt: null }));
export const Deformation = trait(() => ({ map: null }));
export const Tracks = trait(() => ({ renderer: null }));
export const TerrainStreaming = trait({ radius: 2, colliderRadius: 1 });

// Entity traits.
export const Transform = trait(() => ({
  position: { x: 0, y: 0, z: 0 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
}));
export const View = trait(() => ({ object: null }));
export const RigidBody = trait(() => ({ body: null }));
export const Vehicle = trait(() => ({ controller: null, body: null, steer: 0, speed: 0 }));
export const IsPlayer = trait();
export const CameraTarget = trait();
export const TerrainChunk = trait(() => ({ cx: 0, cz: 0, collider: null, heights: null }));
export const WheelRig = trait(() => ({ rig: null }));
// A soft tyre's world-space mesh: from a Rapier soft body, or tyre `index` of a GPU solver.
export const SoftTireView = trait(() => ({ soft: null, gpu: null, index: 0, object: null }));
export const SteeringWheel = trait(() => ({ object: null }));
export const RockField = trait(() => ({ rocks: [], colliders: [] }));
export const HudLabel = trait(() => ({ text: null, format: null }));

// A wheel belongs to a vehicle and knows its index in the Rapier controller.
export const WheelOf = relation({ exclusive: true, store: { index: 0 } });
