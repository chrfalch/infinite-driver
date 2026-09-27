# GPU tyres: fewer round trips per second (design draft)

Status: **phase 1 (A1) is built**, and on by default (`GPU_TIRE.stepsPerTrip = 4`; `?trip=1` or the panel slider gives the old behaviour). See "Phase 1 results" at the end. The iPhone numbers from the `?bench` page are still to come. They decide whether phase 2 (the worker) comes next.

## Goal

- Physics stays at **120 Hz**, and the drawn motion stays smooth (the interpolation is already in).
- Cut the time physics spends waiting for the GPU. Today it is 4–5 ms of every 5 ms step, on the M4 and on the iPhone.
- Keep the GPU tyre model as it is: the same particles, constraints, contact, and friction.

## What the measurements say

| Measurement (M4 unless noted) | Result |
|---|---|
| In-game step, WebKit | 5.3 ms, of which 4.8 ms waiting for the GPU |
| In-game step, iPhone (Safari) | 5.2 ms, of which 4.6 ms waiting for the GPU |
| Same wait with 1 substep × 1 iteration | 4.6 ms (so the wait does **not** come from the solver's work) |
| `solver.step()` alone, rendering stopped | 1.3–1.5 ms (WebKit), 0.8–1.3 ms (Chromium) |
| Solver compute (from the substep/iteration sweep, Chromium) | about 0.3–0.8 ms for 4 × 8 |
| Bench, solver step on the **main thread** while the game renders | avg 1.3–2.5 ms, p95 3.5–6.5 ms |
| Bench, solver step in a **worker with its own GPU device** while the game renders | avg 1.14–1.25 ms, p95 1.5–1.8 ms |
| Bench, **4 steps per round trip**, main thread | 1.1–1.2 ms per step |
| Bench, 4 steps per round trip, worker | 0.6–0.84 ms per step |
| WebGPU in a worker (WebKit 26.6) | works; an empty round trip takes 0.4 ms |

What this means:
1. Each round trip costs a fixed amount that does not depend on the solver's work.
2. On the main thread the round trip also waits for two other things:
   - The frame's render work in the same GPU queue.
   - The frame's JavaScript: a resolved `mapAsync` cannot continue while a frame callback runs.

   That turns about 1.2 ms into 4–5 ms in the game.
3. Two independent levers follow:
   - **A. Fewer round trips:** several steps per trip.
   - **B. No contention:** physics in a worker with its own device.

   They combine.

## Option A: several physics steps per GPU round trip

### Today
Each step does this: write the 4 hub states, dispatch (4 substeps inside), copy the hub forces, `mapAsync`, wait, apply the forces, then `world.step()`. Inside a step the hub is **kinematic**: its pose is extrapolated from its velocity over the substeps (`hubPoint`). The tyre force on the hub is averaged over the substeps.

### Proposed
One dispatch runs **N steps** (N = the steps due in this batch, 1–4). The shader loops `for step in 0..N { for substep … }`. It writes one force/torque record per step into a **force log** (`N × tires × 2 × vec4`). One `mapAsync` reads the whole log. The CPU then runs N Rapier steps and applies `log[j]` before step j.

Across the N steps the GPU must move the hubs. The tyre force depends on the hub motion, and the hub motion depends on the tyre force, so this is the core of the design.

**Hub spin: integrate it on the GPU, with the same inputs as Rapier.** The spin about the axle is the stiff loop: the tyre acts on it like a stiff spring. This loop made pipelined mode unstable. The hub spins almost freely on its axle joint, so its spin rate follows from:
- the drive torque (from the drivetrain on the CPU; held constant over the batch, it changes slowly),
- the brake (a joint motor today; on the GPU a torque capped at the brake torque, which at most stops the spin),
- the tyre torque about the axle (summed in the shader over the step's substeps).

The shader integrates `ω += dt · (T_drive + T_brake + T_tyre) / I_axle` once per physics step, between the steps of a trip. That is the same rate at which Rapier and the GPU exchange forces today, so the loop is as stable as today. (As built, it is per step, not per substep. Per substep would need a workgroup reduction in every substep, and the tests showed no need for it.) Rapier then applies the same per-step torques and integrates the same spin. The two agree closely, and every batch starts from Rapier's hub state again.

**The other 5 degrees of freedom** (hub position, steer, and camber) are held by the suspension and the knuckle to a 1,500 kg chassis. Two levels:
- **A1 (first):** kinematic, as today, but over N steps instead of one: position + linvel·t, orientation + angvel·t. The error grows with t², so N ≤ 4 (33 ms). At batch start the linear velocity is already Rapier's newest.
- **A2 (if A1 is not good enough):** add the vertical hub dynamics. `v_y += dt · (F_tyre,y + F_susp,y) / m_hub`, where `F_susp` is the suspension force on the hub at batch start (the spring + damper force from Rapier's last step). This catches the tyre pushing the hub up on a bump inside the batch.

**Upload per batch:** 4 hub states (as today), plus `N`, plus per hub `T_drive`, `brakeTorque`, `I_axle`, and (A2) `m_hub` and `F_susp`. All small, and all fit into the existing `hubs` uniform (it has room) or a second small uniform. No new storage buffer, so the Safari limit of 8 storage buffers per stage stays safe.

**Readback:** the force log (N × 4 × 32 bytes ≤ 512 bytes), and on the last batch before a frame, the particle positions (as today).

**The rest stays the same:** ground grid, rocks, friction, pressure, drawing, `readbackHubs`, the track contact, and the interpolation.

### Expected gain
- Round trips per second: 120 → 60 at 60 fps (2 steps per batch), and fewer when steps are slow, because batches grow up to 4 steps.
- Bench on M4 (main thread): 1.3–2.0 → 1.1–1.2 ms per step. In the game the gain should be larger, because each round trip there costs 4–5 ms instead of 1.2 ms.
- On the iPhone: to be measured with `?bench` (the "4 steps/trip" rows).

### Risks
- **Hub drift inside a batch** (A1): at 4 steps, 33 ms of constant-velocity motion. On rough ground the tyre then sees the hub where it is not. Mitigation: A2, or N ≤ 2 when the chassis accelerates hard.
- **Brake modelled twice:** a joint motor in Rapier, a clamped torque on the GPU. They must match, or the spin jumps at each resync. Option: model the brake the same way in Rapier (clamped torque instead of the motor).
- **Engine coupling:** the engine rpm follows the wheel spin. Holding the drive torque for 4 steps adds 33 ms of lag in the drivetrain loop. This lag should be harmless, but it needs a test at full throttle in 1st gear.

## Option B: physics in a worker with its own GPU device

### Proposed
The Rapier world, the vehicle controller, the drivetrain, and the GPU tyre solver move into a module worker. The worker creates its own `GPUDevice`, so physics never queues behind the renderer. Its awaits never wait for the frame's JavaScript either. The main thread keeps rendering, input, HUD, camera, soil, and tracks drawing.

**State to the main thread:** a `SharedArrayBuffer` (COOP/COEP is already set) with a small ring of snapshots, one per step:
- chassis pose,
- per wheel: hub pose, steer, spin, suspension points (the A-arm and shock points `syncWheels` draws),
- drivetrain and HUD values (speed, rpm, gear, braking),
- tyre particle positions (4 × 400 × vec4 = 25 KB, the last step only),
- track contacts and pressed particles (or the worker runs `compactSoil` itself).

This fits the interpolation well: the main thread already draws at a display time between steps.

**Input and actions:** keys, touch, respawn, rebuild, and tuning changes go to the worker with `postMessage`.

**The terrain has to exist in the worker too.** Heights and rocks come from seeded functions, so the worker can build the same colliders. The deformation map (ruts) is written by the tyres and read by the terrain mesh, so it moves into shared memory.

### Expected gain
- Bench on M4: p95 per step 3.5–6.5 ms → 1.5–1.8 ms. It is steady whether the game renders or not.
- The main thread loses all physics JavaScript (Rapier ~0.5 ms per step, ~1 ms per frame).

### Risks and cost
- **Largest change of all options.** The main-thread code reads Rapier bodies in many places: `syncWheels`, `soil`, `vegetation`, `tracks`, `camera`, `gauges`, the tuning panel. Each needs to read the snapshot instead.
- **iOS:** WebGPU in workers works in WebKit 26.6 on macOS. The `?bench` page checks the iPhone.
- **Two GPU devices** share one GPU. Separate queues can overlap on Metal, but the GPU time is the same. The bench shows this works on the M4.
- **Debugging** across threads is harder. `window.__game` needs a proxy.

## Recommendation (to confirm with the iPhone numbers)

1. **Phase 1: option A1** in the current structure. It is contained to `gpu-tire-solver.js`, `soft-vehicle.stepTyres`, and `stepPhysics`. Behind a setting (`GPU_TIRE.stepsPerTrip`, 1 = today) so it can be compared directly.
2. **Validate A1 before moving on:**
   - scripted drives with N = 1, 2, 4: flat, canyon with rocks, full throttle in 1st, hard braking, standing still;
   - compare speed and yaw traces and the hub force traces, with thresholds;
   - check that nothing oscillates;
   - measure in-game step time in WebKit and on the iPhone.
3. **Phase 2: option B** if the iPhone still spends most of each step waiting. Or do it first, if `?bench` shows the worker helps much more than 4 steps per trip on the phone.
4. **A2** only if the phase 1 tests show hub drift on rough ground.

## Open questions for you

- Is a brake model change in Rapier (a clamped torque instead of the joint motor) acceptable, if it is needed to keep the two sides in step?
- Phase 2 moves the whole physics into a worker. Is that big change acceptable, if the numbers call for it?

## Phase 1 results (A1, built 2026-09-27)

What was built:
- `gpu-tire-solver.js`: the kernel loops over up to `MAX_STEPS` = 4 physics steps. It writes a force/torque record per step into `hubOut` (the force log) and moves each hub between steps. The spin is integrated from the drive torque, the brake (a torque that at most stops the spin relative to the knuckle), and the tyre's axial torque. Everything else moves at the batch's start velocity. The rotation is advanced exactly (axis-angle).
- `soft-vehicle.js`:
  - `hubBatchStates(dt)` adds the spin axis, inertia, drive torque, brake limit, and knuckle spin.
  - `stepTyresBatch(n, dt)` runs one dispatch for n steps.
  - `applyTyreForces(log, j)` applies record j.
- `stepPhysics`: the batch is split into trips of up to `stepsPerTrip` steps. The first step of a trip dispatches the GPU. Every step of the trip applies its record and runs Rapier. With `stepsPerTrip = 1`, or in pipelined mode, the old path runs unchanged.
- The Rapier brake is unchanged. The two brake models agree well enough in the tests below, so the brake change you allowed was not needed.

Measured (WebKit on the M4; `?slowgpu=8` adds 8 ms per round trip):

| Test | 1 step/trip | 4 steps/trip |
|---|---|---|
| Flat, driving: step total | 3.84 ms | 3.13 ms |
| Canyon, driving: step total | 4.96 ms (batch-1 build) | 3.04 ms |
| Flat, slow GPU: sim/real | 0.58 | **1.00** |
| Flat, slow GPU: per-frame motion error | 9.9 cm | 0.75 cm |
| Flat, speed trace over 14 s | 7 … 74 km/h | the same, within 1 km/h |

Stability (`scripts/stability.mjs`, flat ground): idle, throttle, hard brake, throttle + steer, handbrake turn, coast, reverse, stop. For every phase, trip=4 (with and without the slow GPU) matches trip=1:
- mean speed within about 1 km/h,
- vertical-velocity std 0.009–0.036 m/s in both,
- pitch/roll std within about 0.02 rad,
- wheel-spin wobble in the same range.

There was no NaN and no growing oscillation. On the canyon with rocks: no NaN, and the car stays upright. Runs on the canyon differ from run to run anyway: the batches depend on timing, so the car meets different ground.
