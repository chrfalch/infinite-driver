# Drift: performance audit (2026-10-15)

This audit measures `main` at `b84de50` (AI drivers merged). It follows up on `docs/perf-report.md` (2026-09-26). Most of that report's fixes have landed: the physics worker, instanced car parts, the chunk worker, interpolation, and up to 4 steps per GPU round trip. Since then the game has gained the trophy body, the sunny town, the stadium, depth of field, rival cars with AI, and rival engine sounds. This audit covers what those additions cost.

## Update: items 2 and 3 fixed (same day)

- **Particles (§2):** grains now find the ground in a cache of terrain heights (`terrain/height-cache.js`, a lazily filled 12.5 cm grid with bilinear lookup), with the live ruts added from the deformation map. Colours are written once, when a grain is thrown, and only the live part of the pools is uploaded. `fines.update()` with 7.9k grains takes 0.64 ms, down from 5.8 ms. With the same scripted drive in WebKit:

  | World | `updateSoil` avg before → after | frame.js avg before → after |
  |---|---|---|
  | Canyon | 1.95 → 0.41 ms | 6.5 → 4.8 ms |
  | Dry river | 3.54 → 0.19 ms | 8.6 → 5.0 ms |
  | Sunny town | 1.80 → 0.21 ms | 7.5 → 5.6 ms |
  | Stadium | 4.04 → 0.52 ms | 7.8 → 4.3 ms |
  | Stadium + 7 rivals | 5.18 → 0.72 ms | 19.9 → 16.6 ms |

- **Rebuild stall (§3):** the cause was **not** the car's materials. Each rebuild made new head- and tail-light `SpotLight`s, and three's `LightsNode` cache key includes the lights' ids, so **every lit material in the scene** (terrain, particles, tracks, …) built its node graph again. The player's car now reuses the same three spot lights. The tyres' node materials (and their shadow-pass variants), the only per-car materials left, go back to a pool and are reused by the next car's tyres. The first draw after a rebuild went from about 430 ms to about 9 ms. The longest frame went from about 520 to about 95 ms; what is left is building the car's geometry.

## Update: item 4 fixed, and the finding corrected

Measured directly, §4 was wrong about the cause. **Uploading the deformation texture costs about 0.1 ms**, and the rut refill costs 0.06–0.44 ms. Neither is worth reworking. The snowfield's spikes came from the **snow patch recentre: 25 ms in WebKit every 4 m driven**. Each recentre sampled the procedural snow (`snowAt` twice per cell, plus `roadSide`) for about 12k new 12.5 cm cells.

The fix: the chunk worker now samples the snow fields in 16 m tiles ahead of the car (`terrain/snow-tiles.js`). A recentre copies cells from those tiles and samples only the cells whose tile is not ready yet, such as right after a teleport. One recentre now takes 2.7 ms instead of 25 ms. On the scripted snowfield drive, the max of `sys.groundSurface` went from 27 to 4 ms, frames over 50 ms from 21 to 0, and sim/real from 0.94 to 1.00.



- Headless **WebKit** (iPhone Safari's engine) on the M4, WebGPU, with an iPhone-size viewport of 430×932 @3. The canvas is 860×1864 because DPR is capped at 2. The game runs with `?perf&sound=0`.
- Each run uses the same scripted drive as `scripts/perf-profile.mjs`: 14 s of throttle with two turns, measured after a 3 s settle.
- CPU attribution comes from Chromium's CPU profiler. Absolute numbers from headless Chromium are **not used**: on this box it was GPU-starved (20 fps, sim/real 0.4–0.7, varying from run to run). WebKit was steady.
- The machine was shared with other sessions (load average 3–5 on 10 cores). Treat ±10 % as noise.
- The scripts are in `scratch/audit/` (gitignored): `profile.mjs`, `gpu.mjs`, `calls.mjs`, `soil.mjs`, `toggles.mjs`, `rebuild.mjs`, `cpuprof.mjs`.

## Overview (WebKit, ms per frame unless noted)

| World | frame.js avg / p95 | draw (CPU) | updateSoil avg / p95 | physics step | draw calls | tris / frame | sim/real | frames > 50 ms |
|---|---|---|---|---|---|---|---|---|
| Canyon | 6.5 / 8.9 | 3.3 | 2.0 / 3.4 | 1.6 | 253 | 1.30 M | 1.00 | 0 |
| Dry river | 8.6 / 17.4 | 3.6 | 3.5 / **11.9** | 1.9 | 337 | 1.57 M | 0.99 | 2 |
| Snowfield | 5.6 / 13.3 | 3.3 (max **64**) | 0.4 / 0.7 | 1.7 | 225 | 1.20 M | **0.94** | **21** |
| Sunny town | 7.5 / 15.0 | 3.9 | 1.8 / 9.4 | 2.4 | 264 | 2.21 M | 1.00 | 0 |
| Stadium | 7.8 / 9.5 | 2.7 | 4.0 / 5.8 | 1.8 | 210 | 1.16 M | 1.00 | 0 |
| **Stadium + 7 rivals** | **19.9 / 22.4** | **12.0** | 5.2 / 6.3 | 3.9 | **1215** | **5.13 M** | 1.00 | 0 (avg frame **21.6 ms ≈ 46 fps**) |

GPU frame cost was measured with the animation loop stopped: each frame is rendered, then the script waits for `onSubmittedWorkDone`. All figures are at 860×1864.

| | DoF on | DoF off | DPR 1 |
|---|---|---|---|
| Canyon | 10.9 ms | 8.1 ms | 6.1 ms |
| Sunny town | 11.6 ms | 9.3 ms | 7.1 ms |
| Stadium + 7 rivals | 19.4 ms | – | 18.8 ms |

**Physics is no longer the bottleneck.** The worker steps in 1.6–2.4 ms, with a GPU wait of 1.1–1.4 ms (down from 4.8 ms on the main thread in September), and sim/real holds at 1.00 everywhere except the snowfield. The cost has moved to the main thread and the GPU: particles, rival cars, and per-frame uploads.

---

## 1. Rival cars do not scale (largest effect)

Each car adds about **100 draw calls** and **270k triangles**. The shadow pass doubles both, so each car costs about 0.55 M tris per frame. With 8 cars on the stadium:

- Draw calls go from 210 to 1215, triangles from 1.2 M to 5.1 M, and `draw()` CPU time from 2.7 to 12 ms.
- The frame takes 20 ms of JS, so the game runs at about 46 fps **on the M4**. On the GPU the frame takes 19 ms back to back.
- In Chromium's CPU profile, **44 % of the main thread is `writeBuffer` called from `updateBinding`**: three's per-object uniform uploads, one set per object per pass. This cost grows with the object count, not the triangle count.

Fixes:
- **A LOD for rivals:** beyond about 15–20 m, swap in a proxy (merged body, cage as one mesh, 4 wheels): roughly 5–10 draws instead of 100.
- **Small car parts do not cast shadows** (bolts, links, thin tubes, the dragster engine internals). A rival casts its shadow from one proxy box or hull.
- **Share instanced batchers across cars:** one InstancedMesh per part type for the whole field, instead of one per car.
- Merge static parts by material (`render/merge-geometry.js` already exists).

## 2. Soil and dust particles: the largest main-thread system with one car

`updateSoil` costs 2–5 ms on average, with a p95 of up to 12 ms (dry river, town). Spinning wheels against a wall keep the pools full: 7.8k fines plus about 160 clumps. On the stadium, isolated:

| `fines.update()` with 7.8k grains (6.7k in flight) | 5.4 ms |
|---|---|
| same, ground query replaced by a constant | 1.2 ms |

**About 80 % of the time is the ground query**: `surfaceAt()` = the procedural `heightAt` + `deformation.at`, called for every in-flight particle on every frame. One `heightAt` call costs 0.4 µs (canyon), 0.7 µs (stadium), 1.2 µs (town) or 2.4 µs (dry river). In the 8-car profile, about 10 % of the main thread was the stadium's `sample` / `nearestOn` called from `soil-particles.update`.

Fixes (low effort):
- Look the ground up in a cached grid around the car with a bilinear lookup. `GroundSurface` / the GPU solver's ground cache already hold one. Particles outside the grid fall back to `heightAt`.
- Fines live for less than a second. Give each grain its ground height when it is emitted and test against that, or skip the ground test until the grain falls.
- Write `instanceColor` once when a particle is emitted, not every frame, and skip the tumble quaternion for fines.
- Lower the fines cap (8000) on the `low` quality level.

## 3. Hitches when changing settings, respawning far away, or streaming

| Action | Worst frame |
|---|---|
| Any tuning-panel change (`rebuild()`), measured 3 times in a row | **~500 ms freeze every time** |
| Shadow toggle (material variants change) | 350–450 ms |
| Teleport / respawn 2 km away | 470 ms draw, then 220–266 ms frame gaps for a few seconds |
| Headlights, camera toggle, respawn in place | none (< 8 ms) |

- **Rebuild:** the CPU profile is almost entirely three's TSL `NodeBuilder` (`build`, `analyze`, `getNodeType`, `_getChildren`). The program count stays at 123 across repeated rebuilds, so the shaders are identical and only the **new material instances** are built again. Reusing the car's materials across rebuilds (cached by livery or config) should remove most of the freeze.
- **Teleport:** this is the September report's finding 5 and it is still open. Pre-warm new chunk materials with `renderer.compileAsync`, and share one material per chunk type.
- In normal town driving, `streamTerrain` peaks at 4.6 ms (kit buildings, p95 2.5 ms).

## 4. Ground / snow deformation texture rebuilt every frame

`GroundSurface.update` and `SnowSurface.update` refill the **whole** 385×385 patch from the deformation map and set `needsUpdate` on the whole texture whenever `deformation.version` changes. That is every frame while a tyre digs. The ground patch is 148k floats (~590 KB of upload per frame); the snow patch is RG floats plus a 148k-cell loop. On the snowfield this is 0.9 ms on average with a **27 ms** max at recentre, alongside 21 frames over 50 ms and sim/real 0.94.

Fix: use `deformation.changedSince(version)`, which already exists for the worker, to refill and upload only the dirty rectangle.

## 5. GPU load and triangle budget

- Triangles per frame have **doubled since September**: 585 k → 1.2–2.2 M. Most of it is the car (270 k tris, drawn twice with the shadow pass), plus the buildings in the town.
- Depth of field adds **2.3–2.8 ms of GPU per frame** on the M4, about 30 %. At DPR 1 the frame drops from about 8 to 6 ms, so the GPU is largely fill-bound at 860×1864.
- For a phone, scaling the M4 numbers puts a full-quality frame (DPR 2, DoF, shadows) above 16 ms. This is an estimate, not a measurement; it needs a real iPhone run on `?perf`.
- Suggestions: turn DoF off on `low` (or render it at half resolution); go back to letting `auto` pick `low` on phones once the tube shimmer is handled another way (for example by fading thin tubes with distance); keep a shadow budget for the car.

## 6. Smaller items

- **Main-thread ground grids for GPU cars:** `syncRemoteSolver → updateGpuGround` refills each GPU car's ground grid on the main thread. With 4 GPU cars this was about 5 % of the main thread, and `?perf` does not show it.
- **Gaps in `?perf`:** `syncRemoteSolver`, `audio.update` / `updateRivals`, `gauges`, and props/water are not wrapped in `timed()`. On the 8-car stadium, frame.js minus the timed systems is about 1.5 ms that `?perf` does not show.
- **Bundle:** the game chunk is 6.3 MB (2.2 MB gzip) and the physics worker 5.3 MB. Both embed Rapier's wasm. Audio is 9.5 MB and models 6.1 MB. This only matters for the first load over the tunnel on a phone.
- **Physics with 8 cars:** 3.9 ms per step, batch p95 11.6 ms. That is about 46 % of real time at 120 Hz, which is fine on the M4. On a phone this is the next limit after rendering.

## Suggested order

| # | Change | Effort | Expected effect |
|---|---|---|---|
| 1 | Particle ground lookup from a cached grid (and colours written once) | low | −2 to −5 ms main thread while wheels spin |
| 2 | Reuse car materials on rebuild | low–med | settings changes stop freezing for 0.5 s |
| 3 | Dirty-rect deformation uploads | low–med | removes ~0.6–1.2 MB/frame of uploads; snow spikes |
| 4 | DoF off / half-res on `low`; revisit `auto` → `low` on phones | low | −25–30 % GPU per frame |
| 5 | Rival LOD + no shadows from small parts + shared batchers | medium | 8-car frame from ~20 ms toward ~8 ms |
| 6 | `compileAsync` pre-warm for streamed chunks / teleports | medium | removes the 200–470 ms teleport hitches |
| 7 | Fill the `?perf` gaps, then one real-iPhone run per world | low | confirms the phone numbers this audit estimates |
