# Can TypeGPU run the physics on the GPU?

Date: 2026-09-26. All numbers were measured on this Mac (Apple GPU, Metal backend) in headless Chrome with `--enable-unsafe-webgpu`, with the game served by the Vite dev server.

## Short answer

Yes, for the **soft tyres**. It is not a switch you flip, though.

- Rapier runs on the CPU (WASM), and it cannot run on the GPU.
- TypeGPU does not ship a physics engine. It is a typed layer for writing WebGPU compute shaders in TypeScript.
- So "physics on the GPU" means writing our **own soft-tyre solver** as compute shaders and keeping Rapier for the chassis, suspension, and hubs.

The measurements say this works: the GPU is fast, and the round trip to JavaScript is short enough to couple the two solvers on every physics step.

## Where the time goes today

| Setup | Physics per step | Frame rate |
| --- | --- | --- |
| Rigid wheels (raycast car) | 0.14 ms | 84 fps |
| Soft tyres, default settings | 6.7 ms | 27 fps |
| Soft tyres, solver iterations 1 | 4.8 ms | 62 fps |
| Soft tyres, iterations 1, substeps 1 | 4.1 ms | 77 fps |
| Soft tyres, iterations 1, 20 × 6 mesh | 3.3 ms | 80 fps |

- Nearly all of the cost is Rapier's soft-body solver, at about 1–1.5 ms per tyre per step. The game runs 2 steps per frame (120 Hz).
- Rapier's SIMD build gave no speedup (3.86 vs 3.88 ms per step in Node), because the soft-body solver does not benefit from it.
- Cheaper settings help a lot (see the table), but they also make the tyre softer and coarser.

## GPU measurements

The test was a compute pass over 8,192 particles (4 tyres × 2,048), with 16 solver iterations per step.

| Mode | Time per step |
| --- | --- |
| GPU work only, queued | 0.06 ms |
| GPU work + read a result back to JS, then wait (synchronous coupling) | 0.15 ms |

- **The GPU is fast:** the GPU could solve tyres about 10× finer than today's (2,048 particles each instead of 192) in a fraction of a millisecond.
- **The round trip is short:** reading a small result back (about 0.15 ms) is short enough to exchange hub forces with Rapier on every step.

## Proposed design

1. **Rapier (CPU)** keeps the chassis, suspension, steering, axles, hubs, rocks, and terrain for the chassis.
2. **The GPU tyre solver (TypeGPU compute, XPBD)**, run every physics step:
   - Upload each hub's pose (small `writeBuffer`).
   - Run N substeps of the tyre solver. It handles the particles, the cord and sidewall constraints, a real **pressure force** from the enclosed volume (better than Rapier's volume target), bead pins to the hub pose, and ground and rock contact with friction.
   - Reduce the bead constraint forces to one force + torque per hub, and read back 4 × 32 bytes.
   - Apply those forces to the Rapier hubs, then run `world.step()`.
3. **Rendering:** the tyre mesh reads the particle buffer directly on the GPU through `@typegpu/three` and Three.js TSL. There is no copy to the CPU for drawing. TypeGPU's `threejs/compute-cloth` example uses this exact pattern.

### Collision on the GPU

- **Terrain:**
  - In flat mode, the ground is simply `y = 0`.
  - For hills, the GPU must compute the same height function as the CPU. `@typegpu/noise` has Perlin noise, and our terrain uses simplex noise today. We would switch both sides to the same noise, or upload the height grid of nearby chunks as a buffer (simple and exact).
- **Rocks:** upload the nearby rocks as convex shapes (plane sets or a small SDF per rock) and test particles against them. `@typegpu/sdf` has SDF helpers.

## Risks and costs

- **Size:** this is a real piece of work, a small custom solver. I expect several iterations: tyre on flat ground → coupling to the car → rocks → hills → tuning.
- **Contact quality:** friction and contact on rocks are ours to get right. Rapier does this for us today.
- **Coupling stability:** forces cross between the two solvers once per step. The tyre runs substeps internally, so this should be stable, but it must be proven.
- **The frame loop becomes async:** it waits for the readback 2 times per frame. The GPU work must be submitted before the frame's render work, so that the readback does not wait behind the render.
- **WebGPU is required** for soft tyres. The renderer already runs on WebGPU (Glyph needs it). Browsers without WebGPU would fall back to rigid wheels or to the Rapier soft tyres.

## Safari

- **TypeGPU in Safari:** TypeGPU is plain TypeScript on top of the browser's WebGPU API, so it runs wherever WebGPU runs.
- **Safari's WebGPU:** Safari has shipped WebGPU on by default since **Safari 26** (macOS Tahoe 26, iOS/iPadOS 26, visionOS 26). It maps directly onto Metal, and compute shaders are part of it. ([WebGPU on Wikipedia](https://en.wikipedia.org/wiki/WebGPU), [webgpu.com: all major browsers ship it](https://www.webgpu.com/news/webgpu-hits-critical-mass-all-major-browsers/))
- **This machine:** it has Safari 27.0 on macOS 27.0.
- **What I could not test:** I could not run Safari itself here, because Safari automation needs an admin to enable it. My GPU measurements come from Chrome on the same Metal GPU.
- **How to check yours:** the HUD's last line now shows **WebGPU** or **WebGL2 (no WebGPU)**. If it says WebGPU, TypeGPU compute will work in your Safari.
- **Safari differences to plan for:** device limits can be lower than Chrome's (for example, storage buffers per shader stage), and optional features (timestamp queries, `shader-f16`) may be missing. The solver should only use core WebGPU features and stay within the default limits.

## Other options

- **Cheaper Rapier settings (available now, no code):** solver iterations 1, substeps 1, 20 × 6 mesh gives about 3.3 ms per step and 80 fps. The tyres get softer and coarser.
- **Physics in a Web Worker:** the physics cost stays the same, but the main thread is free for rendering. With about 7 ms of physics per frame, that gives a steady 60 fps. It needs the render state to come through shared memory; the COOP/COEP headers are already set. This is medium work, and it helps any physics setup.

## Recommendation

1. Now: expose a **"Performance" preset** (the cheap settings above) so the game stays smooth while the GPU work happens.
2. Next: build the **GPU tyre solver** as a third tyre mode (`?tires=gpu`), first on flat ground in the tyre lab, then on the car. Keep the Rapier soft tyres as the reference to compare against.
3. Later, if needed: move the remaining Rapier work into a worker.
