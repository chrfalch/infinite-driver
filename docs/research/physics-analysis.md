# Physics analysis: tests, bugs, and suggestions

Date: 2026-09-26. The analysis had three parts:

- **Code review** of all physics code.
- **Vehicle dynamics tests** for all three tyre modes: rigid and Rapier soft in Node, GPU in the browser.
- **Performance profile** in headless Chrome on this Mac's GPU (WebGPU).

No game code was changed during the analysis. The test scripts are in `scratch/review-*`, `scratch/dyn-*`, and `scratch/perf-*`.

## Summary

- **Largest realism problem: the soft tyres.**
  - **GPU tyre forces do not balance.** Two internal forces of the GPU tyre (the shape memory and the damping) never reach the hub. So the tyre can push the car with no drive, or brake it harder than the brakes allow. It also has almost no cornering stiffness.
  - **Too much energy loss.** Both soft tyre types lose far more energy than real tyres. This caps top speed at 60–80 km/h instead of about 160.
- **Largest gameplay bug: rigid-mode brakes.** In rigid-wheel mode the brakes barely work while the car is in gear: 147 m from 100 km/h, compared with 43 m in neutral.
- **Largest performance costs:**
  - Shadow rendering: 2.9 ms per frame. The car is 230 separate meshes.
  - The GPU-tyre readback wait: 1.9 ms per frame, which blocks the main thread.
  - A full rewrite of the tyre tracks: up to 3.3 ms per frame once 6,000 segments exist.
  - Terrain chunk building: 15–26 ms spikes.
- **Rapier soft tyres** run at about 8 fps. The simulation falls behind real time.

## 1. Bugs, verified

| # | Bug | Evidence | Fix |
|---|---|---|---|
| B1 | **Rigid mode: brakes are ignored while the clutch is in.** Rapier's raycast car ignores `brake` on any wheel that has engine force, and the clutch is almost always engaged. The handbrake has the same bug. | 100→0 km/h takes 147 m (0.30 g) in gear and 43 m (0.81 g) in neutral. | When a wheel brakes, send 0 engine force, or open the clutch while braking. |
| B2 | **GPU tyre: the shape-memory reaction is missing.** Every particle is pulled toward the moulded shape, but only the bead correction becomes hub force and torque. This breaks Newton's third law. | With the hub held at 4 cm squash, only 4.1 kN of the 10.9 kN ground force reached the hub. At `shapeStiffness` 0.3 the car was pushed forward by 5.8 kN in neutral. | Add `−m·corr/dt²` and its torque to `hubForce`/`hubTorque`, exactly as for the bead. |
| B3 | **GPU tyre: damping acts on absolute velocity**, not velocity relative to the hub. | At 20 m/s, −775 N of drag per tyre (about 3.1 kN for the car), about 5× air drag plus rolling resistance. | Damp `v − (v_hub + ω_hub × r)`. |
| B4 | **GPU tyre: pressure creates a spin torque that grows with ω** (about +1.4 kN·m at 20 rad/s). Today the missing shape reaction hides it. | Measured in a CPU port of the kernel. The root cause is not isolated yet. | Investigate the explicit pressure step against the Jacobi projection, together with B2. |
| B5 | **Respawn or rebuild can run while physics awaits the GPU.** It then destroys buffers and bodies that are still in use. | Inferred from reading the code. It can cause a failed `mapAsync` or Rapier calls on removed handles. | Queue respawns and rebuilds, and apply them at the start of the next frame. |
| B6 | **The gearbox can engage a gear against the direction of motion** (for example reverse at 13 m/s forward). | Measured. Two Q presses at speed go 1 → N → R. | Reject a gear change whose direction is opposite to the motion, or that would over-rev. |
| B7 | **The GPU tyres see rocks smaller than Rapier does.** The noisy rock meshes are not convex, and intersecting their face planes gives a smaller solid. | 59% of rock vertices lie outside the GPU shape. The worst gap is 67% of the rock's size. | Upload the planes of the convex hull, the same shape Rapier uses. |
| B8 | **The rolling-resistance force points along the full 3D velocity.** It is not reset below 0.01 m/s. | At rest it lifts the rigid car by 318 N, and it damps vertical motion. | Apply it only along the forward ground velocity, and reset forces every step. |

## 2. Vehicle dynamics results

Unless noted, the tests use solid axles, hard ground, and a 120 Hz step. The reference is a 1.8 t short-wheelbase 4x4 or buggy.

| Test | Rigid | Rapier soft | GPU | Real |
|---|---|---|---|---|
| 0–50 km/h | 3.9 s | 8.2 s | 4.5 s | 4–5 s |
| Top speed | 160 km/h | **60 km/h** | **80 km/h** | 150–170 |
| Braking 100→0 | **147 m** (bug B1) | 41.5 m, 0.77 g | 32 m, **1.25 g** (above the brake limit) | 38–45 m |
| Dive / squat | 4.0° / 3.6° | 7.4° / 4.6° | **11° / 6.2°** | 2–4° / 1–3° |
| Coast 50→30 km/h, neutral | 24 s | **3.5 s** | 12 s | 20–25 s |
| Engine braking in gear | **0.28 g** | **0.38 g** | – | 0.05–0.10 g |
| Skidpad maximum lateral grip | 1.22 g | 0.54 g | **0.45 g** at 19° body slip | 0.7–0.85 g |
| Roll gradient | **0.8 deg/g** (too stiff) | 13.3 deg/g | **17.9 deg/g** | 2–7 deg/g |
| Step steer, yaw overshoot | 0% | 30% | 256% (tiny steady-state yaw) | 5–20% |
| Heave / pitch frequency | 1.2 / 1.2 Hz | 1.2 / 1.1 Hz | 0.8 / 1.2 Hz (pitch barely damped) | 1.0–1.5 Hz |
| Tyre vertical stiffness | – | 117–131 kN/m | 51–66 kN/m | 200–300 kN/m |
| Tyre cornering stiffness | 0.23 W/deg | 0.034 W/deg | **0.007 W/deg** | 0.12–0.2 W/deg |
| Rolling resistance | 0.018 | **0.04 → 0.25** (rises with speed) | 0.01 → 0.12 | 0.01–0.05 |
| Step size 60/120/240 Hz | stable within 2% | **ride height changes 12 cm**; 0–50 km/h from >15 s to 5.9 s | – | – |
| 1.5 m drop, 55 km/h full-lock slalom, 58 km/h handbrake | no NaN | no NaN | no NaN | – |

**Other findings:**
- **GPU car at rest:** it sits 3.6° nose-down with 1.4° of roll. Only 8 cm of front bump travel is left, and the left tyres carry unbalanced forces. The fix for B2 and B3 will probably change this.
- **Solid axles roll too much:** `springSpan = 0.5 × track` gives a quarter of the independent roll stiffness, and there is no anti-roll bar.
- **Rigid car barely rolls:** Rapier applies the side forces near the height of the centre of mass.
- **Wrong wheel radius:** the drivetrain uses the outer radius 0.46 m, but the real rolling radius is 0.42–0.43 m. Shift speeds and slip readouts are 6–9% off.
- **Soft car mass:** 2,092 kg total (the hubs and axles add mass), not 1,800.

## 3. Performance (GPU tyres, softness 0.15, about 86 fps)

| Cost | ms per frame | Note |
|---|---|---|
| Render (scene + shadows) | **2.85** | Shadows off: 1.42. There are 294 meshes, 230 of them in the car, and 742 draw calls. |
| GPU tyre readback wait | **1.87** | Submit takes 0.03 ms and the wait 1.35 ms per step. Under 4× CPU throttle it rises to 8.4 ms per frame, and 41% of frames are skipped. |
| Tyre tracks rewrite | 0.5 → **3.3** | A full rewrite and a 2.9 MB upload per new segment once 6,000 segments exist. |
| GPU ground grid resample | 0.69 | Resampled on every frame on soft ground, using string-keyed map lookups. |
| Tyre normals | 0.37 | – |
| Rapier step | 0.24 | – |
| Terrain chunk streaming | **15–26 ms spikes** | Every chunk crossing builds meshes and rebuilds about 70 rock hulls each time. |

- **Rapier soft tyres:** 10.3 ms per step, so the loop runs 12 steps per frame at 7.9 fps. The simulation falls about 24% behind real time.
- **Memory:** the JS heap is flat (about 140 MB). Deformation tiles are never freed (64 KB each).

## 4. Recommended plan

### Step 1: correctness (highest value)
1. **B1** – rigid brakes (a small change).
2. **B2 + B3 + B4** – balance the GPU tyre forces: add the shape-memory reaction, use relative damping, and check the pressure spin torque. Then re-tune the GPU tyre for cornering stiffness (`shapeStiffness` about 0.3, `bendStiffness` 0.5, `shearStiffness` 1.0 already give 5× more). Target: about 0.1 W/deg of cornering stiffness, a rolling resistance of about 0.015, and braking at or below the brake limit.
3. **B5, B6, B7, B8** – respawn safety, gear engagement guard, convex-hull rocks, rolling-resistance direction.

### Step 2: feel
4. **Engine braking:** `exhaustBrake` down to about 20, and `coastDownshiftRpm` down to about 2,000, for 0.06–0.1 g. The 5 s stop from 50 km/h that you asked for earlier comes mostly from this setting, so the target needs your decision.
5. **Roll:** raise the solid-axle `springSpan` to about 0.8 × track, or add an anti-roll term (target 5–8 deg/g). For the rigid car, add a roll torque about the chassis.
6. **Anti-dive and anti-squat** from the link geometry, or stiffer pitch damping, to cut 11° of dive to about 4°.
7. **Rapier soft tyres:** `damping` 0.3, `shapeMemory` 40, `sidewallStiffness` 60. This doubles cornering force and cuts rolling resistance by about a third. Set the explicit rolling resistance to 0 in the soft modes (the tyres already lose energy).
8. **Measured rolling radius** in the drivetrain and slip logic, and a chassis mass of about 1,508 kg so the soft car totals 1,800 kg.
9. **Realism additions:** Ackermann steering geometry, and the propshaft torque reaction (a beam axle lifts one wheel under power).

### Step 3: performance (a total of about 4–8 ms per frame)
10. **Pipelined GPU tyres:** submit step N+1 with the forces from step N, using a ring of staging buffers, so the main thread never waits (about −1.9 ms, and −8 ms on slow devices). The cost is one step (8 ms) of force latency.
11. **Tracks:** write only the new segments, and compute the fade in the shader (up to −3.2 ms and −2.9 MB of upload per frame).
12. **Shadows and draw calls:** merge the static car parts by material, take small parts out of the shadow pass, and tighten the shadow frustum (about −1.4 ms).
13. **Terrain:** spread chunk and collider building over frames, cache the rock hulls, and try heightfield colliders (removes the 15–26 ms spikes).
14. **GPU ground grid:** resample only after about 1 m of movement, upload only the changed area, and use numeric tile keys (about −0.6 ms).
15. **Rapier soft mode:** cap the steps per frame at about 4, or switch on the performance preset automatically when the step cost is too high (8 → about 25 fps).
16. **Minor:** compute the tyre normals less often or on the GPU, skip bounding spheres, and avoid per-step allocations.

## 5. Status after the fixes (2026-09-26)

Commits `4418db3` to `7a8bb4f`, plus the performance commit `6b8c27a`. All 40 tests pass.

| Item | Before | After |
|---|---|---|
| Rigid braking in gear | 0.30 g | 0.94–0.96 g |
| GPU tyre free-spin drag | up to 580 N·m | 0 |
| GPU tyre rolling resistance (rig) | 0.14–0.57, rising with speed | 0.008–0.04 |
| GPU tyre peak longitudinal force | 1.35 W (above μ) | 1.15 W |
| GPU braking in the car | 1.25 g (above the brake limit) | 0.73 g |
| GPU cornering stiffness (rig) | 0.007 W/deg | 0.04 W/deg |
| GPU car at rest: hub forces vs weight | 20 310 vs 20 052 N | 17 188 vs 17 187 N |
| GPU car at rest: pitch / roll | −3.6° / 1.4° | −0.6° / 0.17° |
| GPU car at rest: jitter (linear / angular RMS) | 22 mm/s / 7.2 mrad/s | 2.8 mm/s / 2.1 mrad/s |
| Solid-axle roll gradient | 13–18 deg/g | about 5 deg/g |
| Rigid roll gradient | 0.8 deg/g | 3.4 deg/g |
| Total mass of the soft car | 2 092 kg | 1 800 kg |
| Render | 2.85–3.2 ms | 1.6 ms |
| Tracks at 6 000 segments | 3.3 ms | 0.03 ms |
| Terrain chunk-crossing spike | 16–17 ms | 1.75 ms |
| Rapier soft mode | 7.9 fps | 54 fps |

**Rest lean and jitter (fixed):**
- **Roll 1.7°:** not a tyre effect. With simple vertical springs in place of the GPU tyres, the lean stayed. The cause was Rapier's solver: the solid axle's carrier (inertia 2) sits between the chassis (1 508 kg) and the roll hinge, and 4 solver iterations did not converge. The carrier inertia is now 200 (it turns with the chassis, so this is physically harmless) and the world uses 8 solver iterations. The step cost did not change (1.86 ms).
- **Pitch −2.5°:** the front axle carries 57 % of the load with the same springs as the rear. Springs and dampers are now rated per axle for their static load.
- **Jitter:** the tread contact is now critically damped and integrated implicitly, so it does not bounce between substeps. The car also spawns just above its ride height.

**Still open:**
- **GPU cornering stiffness:** 0.04 W/deg, against 0.1–0.2 for a real tyre. The contact patch does not yet hold the side deflection across substeps.
- **Pipelined GPU readback:** it is implemented but off. With one step of force latency, the wheel-spin coupling goes unstable.
- **Rapier soft tyres:** too much grip (up to 1.6 g) after the retune.
