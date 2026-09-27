# Car game: performance report

Date: 2026-09-26. The measurements come from an instrumented copy of `~/Developer/html-page`. The original project is not changed.

## How I measured

- I added a profiler (`src/perf.js`). It records the time of each system in each frame and of each part of a physics step. Open the game with `?perf` to see an overlay.
- `scripts/perf-profile.mjs` drives the car for 14 s on a fixed input script, then prints avg / p50 / p95 / max values.
- Browsers: headless **WebKit 26.6** (the same engine as iPhone Safari) and headless Chromium, both with WebGPU, on the M4. The viewport is an iPhone-size 430x932 at DPR 3. The canvas is 860x1864 because the game caps DPR at 2.
- Slow devices: I used CPU throttling (Chromium only). I also added `?slowgpu=8`, which adds 8 ms of wait to each physics step. That gives about 12-13 ms per step, the same as the value your iPhone showed.
- Isolation tests: `scripts/rtt.mjs` (GPU round trip against solver work), `scripts/calls.mjs` (draw calls for each scene part), `scripts/stream.mjs` (terrain streaming), and `scripts/micro.mjs` (terrain height sampling).

## Update: real iPhone data (about 15 s, `car-perf.tuft.host/?perf`)

| | iPhone (Safari engine) | M4 headless WebKit |
|---|---|---|
| step.total avg / p95 / max | 5.17 / 6.25 / 11.1 ms | 5.27 / 6.19 / 36.0 ms |
| step.gpuWait | 4.57 / 5.69 / 10.5 ms | 4.78 / 5.70 / 35.2 ms |
| step.rapier | 0.53 ms | 0.44 ms |
| frame.js | 4.69 / 5.74 / 7.0 ms | 5.10 ms |
| draw (CPU) | 2.40 ms | 2.97 ms |
| updateTracks | 1.04 ms | 1.25 ms |
| draw calls, triangles | 272, 585k | 275, 585k |
| batch.steps avg / max | 2 / 4 | 2.1 / 10 |
| sim/real | 0.98 (0.32 s dropped) | 1.00 |
| tracks.segM max | **1.3 m** (at least one track break) | 1.07 m |

- In this sample the iPhone is about as fast as the M4 in headless WebKit. **The 12.4 ms/step from your first screenshot did not show up here.** That HUD value is a running average, so it may come from a slower period: a different browser (Safari against the in-app browser), zoomed out, a hot phone, or Low Power Mode. I cannot tell which one from the data I have.
- Physics on the phone is again almost all GPU wait (4.57 of 5.17 ms). The GPU round trip is still the main cost.
- Even at 5 ms per step the contact point jumped 1.3 m once, so the track broke at least once in 15 s.

## Correction: driving test

My first scripted drive hit a tree at x ≈ 61 m after about 7 s. The car then stood still for the rest of the run. The draw, physics and GPU-wait numbers do not change much with speed, but the track jump numbers were too low. I ran the tests again on `?terrain=flat&rocks=0`, where the car reaches 74 km/h (WebKit, M4):

| Test | step.total | batch steps avg / max | batch.ms avg | sim/real | tracks.segM p95 / max |
|---|---|---|---|---|---|
| no extra wait | 4.63 ms | 2.0 / 4 | 9 | 1.00 | 0.47 / 0.63 m |
| `slowgpu=3` (~8 ms per step) | 7.78 ms | 9.4 / 12 | 74 | **0.98** | 1.75 / **1.99 m** |
| `slowgpu=8` (~14 ms per step) | 14.24 ms | 12 / 12 | 171 | 0.56 | 1.29 / 1.71 m |

At about 8 ms per step physics still keeps up (sim/real 0.98), but the batches grow to about 10 steps (74 ms). The track contact then jumps up to 2 m, so **the tracks break before the game falls into slow motion**. The batch size grows sharply when a step costs close to 8.3 ms (1/120 s), because each batch must then cover more time. On flat ground `updateTracks` costs only 0.12 ms, which confirms that the canyon `heightAt` is its main cost.

## Key numbers (M4)

| | WebKit | Chromium |
|---|---|---|
| Physics step, total | 5.27 ms | 3.99 ms |
| … of which waiting for the GPU tyre solver | 4.78 ms | 3.74 ms |
| … Rapier `world.step()` | 0.44 ms | 0.21 ms |
| … vehicle JS | 0.04 ms | 0.03 ms |
| Frame JS (all systems + draw submit) | 5.10 ms | 3.58 ms |
| `draw()` CPU | 2.97 ms | 2.11 ms |
| `updateTracks` | 1.25 ms | 1.04 ms |
| Draw calls per frame (incl. shadow pass) | ~275 | – |
| Triangles per frame | ~585k | ~590k |

Physics runs at 120 Hz. At 5.3 ms per step, physics takes about 630 ms of every second, even on the M4. On the iPhone you saw 12.4 ms per step. At that speed physics can do at most about 80 steps per second, but the game needs 120.

## Finding 1: each physics step waits for a GPU round trip. This is the main problem.

Each of the 120 steps per second sends the tyre solver to the GPU. The step then waits (`mapAsync`) for the hub forces before Rapier can step.

The wait does **not** depend on the amount of solver work:

| Solver setting | in-game GPU wait (WebKit) | in-game GPU wait (Chromium) |
|---|---|---|
| 4 substeps x 8 iterations (default) | 4.78 ms | 3.76 ms |
| 2 x 4 | 4.61 ms | 3.49 ms |
| 1 x 1 | 4.64 ms | 3.29 ms |
| Mesh 24x6 instead of 40x10 | – | 3.50 ms |

With rendering stopped, one `solver.step()` takes 1.3-1.5 ms (WebKit) or 0.8-1.3 ms (Chromium). An empty copy+map takes about 0.5 ms. In the game the wait grows to 4-5 ms. The dispatch goes into the same GPU queue as the frame's render work, so it must wait for that work to finish first. Evidence: with `?nodraw` the wait drops from 4.78 to 3.18 ms (WebKit), and with `?dpr=1` it drops to 3.66 ms.

Result: on a slow GPU, the fixed cost per step decides how fast physics can run. The "performance" preset (fewer substeps and iterations) makes almost no difference on the M4. I could not verify this on the iPhone.

## Finding 2: why the tracks break and the physics seems to lag (reproduced)

With `?slowgpu=8` (about 13.6 ms per step, like the iPhone):

- Each physics batch runs the maximum 12 steps and takes **163 ms**, so physics results arrive about every 10 frames.
- sim/real = **0.59**. The 0.1 s clamps (`pendingDelta` in `main.js` and the accumulator in `stepPhysics`) threw away **5.8 s of 14.1 s**. The game runs in slow motion, and the rate changes when the load changes.
- `updateTracks` reads the tyre particle positions (`solver.positions`). These are read back only on the **last step of each batch**, so the contact point jumps once per batch. The jump distance was p95 **1.17 m** and max **1.32 m** at only 48 km/h. `MAX_GAP = 1.2` m in `render/tracks.js` treats a jump longer than that as "airborne", so the track breaks. That is the gap in your screenshot. At higher speed the jumps are longer, which is why fast driving looks worse.

## Finding 3: render load

- Draw calls: in the main pass, **116 of 148** draw calls are the buggy (group with 116 meshes, ~105k triangles). The rest are terrain chunks, rocks, and vegetation, which are already instanced. With shadows, the total is about 275 per frame.
- About 585k triangles per frame, drawn twice (the shadow pass and the main pass) into a 2048 PCF-soft shadow map, at 1.6 megapixels (DPR 2).
- Rendering also slows physics, because physics shares the GPU queue with it (see Finding 1).
- `?noshadow`: draw calls 275 → 152, `draw()` CPU 2.97 → 2.18 ms (WebKit).

## Finding 4: CPU work in each frame

- `updateTracks` takes 1.0-1.25 ms per frame on the M4. About **0.65 ms** of that is 1,600 calls to the canyon `heightAt` (0.79 µs each), one for every tyre particle. The deformation lookup costs only 0.04 µs.
- CPU x4 throttling (Chromium): frame JS 3.6 → 7.1 ms, and `updateTracks` p95 went up to 3.7 ms.

## Finding 5: terrain streaming hitches

After a teleport to new ground (the worst case):
- One streaming job per frame still costs up to **~10 ms** on the M4 (p95 ~5 ms).
- The first `draw()` of new chunks shows spikes of **60-176 ms**. This is probably geometry upload or pipeline setup. I did not isolate the cause.
- When you drive normally you enter a new 64 m chunk about every 4 s at 60 km/h, so smaller versions of these spikes are likely. This may explain the glitches when you drive fast or zoom out on the Mac.

## Possible improvements, ranked by effect on slow devices

### A. Fewer GPU round trips per second (largest effect; needs design work)

1. **Physics at 60 Hz on slow devices, with double the GPU substeps.** The tyre substep dt stays the same, but there are half as many round trips. The jointed car (8 solver iterations) must be tested for stability at 1/60 s. Effort: medium.
2. **Fix the pipelined mode** (it exists, `GPU_TIRE.pipelined`, but is unstable). It uses the forces from the previous step, so the main thread does not wait. It is unstable because the force is one step late on a stiff spring. A possible fix: send the force together with its stiffness (dF/dx, dF/dv) and correct it on the CPU for how far the hub moved: `F ≈ F_gpu + K·Δx + C·Δv`. Effort: medium to high.
3. **Run several steps per submit.** Move the hub integration into the shader: the GPU integrates the hub as a rigid body for N steps. It gets the joint and suspension force from Rapier as a constant input for the batch. You get 1 round trip for every N steps. Effort: high.
4. **Adaptive fallback.** Measure the step cost. When 120 × step cost is more than about 60% of a second, switch to (1), or to Rapier soft tyres or rigid wheels. Effort: low once (1) exists.

### B. Stop the visible glitches (cheap; do these first)

5. **Tracks from the hub, not from the stale readback.** Use the contact offset in the tyre's local space from the last readback, and move it with the current hub transform, which changes every step. Or read back the positions (25 KB) every step. The contact then moves every frame and never jumps 1.2 m. Also scale `MAX_GAP` with speed × frame time. Effort: low.
6. **Constant time scale when physics cannot keep up.** At the moment the clamps throw away a varying amount of time, so the game speed changes. Pick one: (a) limit the steps in each batch by a time budget and slow down smoothly, or (b) drop to 60 Hz (item 1). Also show "sim/real" in the HUD. Effort: low.
7. **Interpolate the drawn car between physics states.** Keep the previous and current body poses and draw at `alpha = accumulator / step`. Motion then looks smooth even when a batch spans several frames. Effort: low to medium.

### C. Less render work (also shortens the GPU wait for physics)

8. **Merge the buggy's static meshes by material.** For example tube chassis, engine, and body panels become a few merged meshes, and only the moving parts (wheels, axles, steering) stay separate. This removes about 100 draw calls. `render/merge-geometry.js` already exists. Effort: low to medium.
9. **Mobile quality level:** DPR 1.25-1.5 instead of 2 (or dynamic resolution from frame time), a 1024 shadow map, `PCFShadowMap` instead of soft, and a shadow update every 2nd frame. Effort: low.
10. **Terrain LOD:** far chunks at 32x32 or 16x16 instead of 64x64. Also cull chunks that are outside the view, or use a radius of 1 in the top-down view. Effort: medium.

### D. Less CPU work in each frame

11. **Cheaper contact tests in `updateTracks`.** Sample the ground grid that the GPU solver already has (`solver.groundCache.heights`) with bilinear lookup instead of `heightAt`. Or test only the tread particles (the outer ring, about 1/10 of the particles). Better still, let the shader output the contact centroid and depth for each tyre with the hub forces. Saves about 0.65 ms per frame on the M4, and more on the phone. Effort: low.
12. **Move terrain generation to a Web Worker** (chunk heights, rocks, plants, convex hulls). Pre-warm new chunk meshes with `renderer.compileAsync` before they come into view. Effort: medium.

## Suggested order

1. Items 5, 6, 11, 9: cheap, and they remove the visible track breaks and speed changes.
2. Item 8 (car draw calls), then item 1 (60 Hz on slow devices) with item 4 (adaptive switch).
3. Item 2 or 3 if the tyre solver must run at full rate on phones.

## To measure on the real iPhone

Open **https://car-perf.tuft.host/?perf** (the instrumented copy) and drive for 20-30 s, then take a screenshot of the overlay at the bottom left. Tap the overlay to reset it. The key lines are `step.gpuWait`, `step.total`, `frame.js`, `draw`, `batch.steps`, and `sim/real`. These show how much of the 12.4 ms is GPU wait on the phone, and so which fix to do first.
