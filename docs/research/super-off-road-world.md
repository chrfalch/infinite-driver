# Research: a stadium world after *Super Off Road*

Goal: a new world in the spirit of Leland's *Ivan "Ironman" Stewart's Super Off Road* (1989): a
compact dirt circuit inside a stadium, seen from a fixed high three-quarter view, with tabletop
jumps, whoops, switchback lanes between striped barrier walls, and mud and water holes.

Answer: **it fits, and two big pieces already exist.** The camera's fixed isometric mode (C off,
35.3° down the diagonal) *is* the Super Off Road view, and the town already builds kickers,
tabletops, rollers and moguls in the height function. The new parts are a **closed track** (every
world so far is an open, endless road) and, if we want the arcade loop, **laps and a timer**.

## What makes Super Off Road feel like itself

| SOR element | Here |
|---|---|
| One screen, fixed 3/4 view, the whole track visible | Camera with follow off, zoomed out to frame the arena (a per-world default view) |
| Short loop (~20–30 s a lap), 4 trucks side by side | ~600–800 m loop, 10–12 m wide, so a lap is ~30–40 s at 60–80 km/h |
| Dirt with a darker racing line | Soil with tracks on (ruts build up lap after lap — this game already does that, SOR never did) |
| Tabletops, double jumps, whoops | Town's kicker/tabletop/roller shapes, put on the track's centre line by distance along it |
| Water holes and mud | A puddle in a shallow dip under the town's water sheet; mud as soft, draggy ground |
| Low red-and-white striped barrier walls, rounded at the corners, separating lanes | Fixed colliders (box/capsule segments) along the lane edges, drawn as instanced striped panels |
| Lanes snaking back and forth in switchbacks, all on one floor | A layout of straights joined by rounded 90° corners and 180° hairpins |
| Dirt mounds, pyramid tabletops, washboard patches (the ribbed strips) | Features in `heightAt` by arc length; washboard as short-pitch ripples |
| Raised ramps that cross over a lower lane (*Blaster*, *Fandango*) | Hard part: a heightfield has no underpass (see below) |
| Blue flags at the corners, checkered start gantry, sponsor banners, stands in a corner | Props and backdrop |
| Stadium, crowd, floodlights | Grandstands round the arena, night with floodlights (or a dusk hour) |
| Nitro and money-bag pickups on the track, upgrades, 3 AI trucks | Out of scope at first (later phases) |

## How a world plugs in today (short)

One deterministic `heightAt(x, z)` per world (`src/terrain/height.js`), used on the main thread,
the physics worker and the chunk worker. Hooks on it: `sample` (colours, plants), `roadDistance` /
`roadHeading` (spawn, respawn, minimap), `waterLevel` (water sheet, spawn). Per-world hard-coding
lives in `world.js` (picker), `render/terrain-mesh.js` (colours/shader flags), `render/backdrop.js`,
`render/time-of-day.js`, `ui/minimap.js`, `terrain/rocks.js`, `terrain/vegetation.js`, and props
via `terrain/props.js` + `physics/props.js` (the sunny town's cones/crates are the model).

## The main design question: endless game, closed track

Three ways to square it:

1. **One arena at the origin (recommended to start).** Inside: the circuit. Outside: grandstand
   terraces rising steeply in `heightAt` (the car can't climb out), then nothing more to stream.
   Chunks keep working as now; the world is just finite. Closest to the arcade game.
2. **Arenas on a lattice.** A stadium every ~400 m, linked by dirt roads through car parks. Keeps
   "endless", but the joins are a lot of work for little SOR feel.
3. **Endless SOR road.** An open winding dirt course (like the canyon) dressed with SOR features.
   Easiest, but loses the loop, which is the point of SOR.

Go with 1. Later, a **layout seed** can generate a new arena layout (the "endless" angle: a fresh
track every time, à la SOR's track packs).

## Proposed design

**Arena:** about 180 × 120 m of floor (3 × 2 chunks), level at y = 0. Grandstands start 6–8 m
outside the outer barrier: a 2 m concrete wall, then terraces at ~35° up to ~15 m.

**Track as data, not noise.** Unlike the other worlds, the track is a hand-authored closed
Catmull-Rom spline (~20–30 control points) with per-point width and bank, plus a list of features
by arc length `s`:

```js
{ kind: 'tabletop', s: 140, length: 18, height: 1.6 }
{ kind: 'double',   s: 260, gap: 9, height: 1.4 }
{ kind: 'whoops',   s: 330, length: 30, count: 7, height: 0.45 }
{ kind: 'puddle',   s: 410, length: 14, depth: 0.35 }
{ kind: 'mud',      s: 470, length: 20 }
{ kind: 'crossing', s: 520 }   // where the loop crosses itself
```

`heightAt` finds the nearest point on the spline (bucket grid of segments, 8 m cells, so a lookup
is a handful of segment tests — the tyre grid samples ~16k points per refresh), then builds the
cross-section from distance `d` and `s`:
- `|d| < halfWidth`: track floor + feature profile at `s` + bank (outer edge raised on bends).
- Outside the lane (behind the barrier): level dirt with mounds — the "dead" ground between lanes.
- At a crossing, take the lower of the two profiles and keep features ≥ 25 m away.

**Barriers:** the screenshots make it clear these are thin walls, not berms: lanes sit a few metres
apart with only a striped rail between them. So walls are **fixed colliders** generated from the
layout (offset curves at ±halfWidth, cut into ~2 m segments), drawn as instanced red/white panels
on posts. Heightfield berms would launch the car; real walls stop it and let it scrape along, as in
SOR. Openings in the walls where lanes cross or a ramp drops in.

**Layout shape:** SOR tracks are grids of straights with rounded corners and hairpins, not smooth
splines. Author them as a list of straight runs and corner radii (8–12 m hairpins, 15–25 m sweepers)
on a ~12 m lane pitch; the spline helper just rounds the corners.

**Crossovers:** a single `heightAt` can't do a lane passing *under* another. Options, best first:
(a) a **bridge**: the high lane is a separate mesh + trimesh collider, the ground below stays at
floor level (needs `heightAt` to stop modelling the ramp top, and tyres to see the bridge — the GPU
tyre ground grid reads `heightAt` only, so this is real work); (b) a **jump across**: the upper
lane is a kicker that flies over the lower lane to a landing ramp (pure heightfield, very SOR, easy);
(c) a flat X crossing. Start with (b)/(c), do (a) only if we want *Blaster*-style long raised ramps.

Hooks: `roadDistance`/`roadHeading` from the spline (respawn puts you back on the line facing the
racing direction), `sample` returns `{ road, lane, puddle, mud, s, lap-sector }`, `waterLevel =
-0.05` (the arena floor is at 0, so the town's one water sheet shows only in the puddles — it works
unchanged here because the floor is flat).

**Surfaces / physics:**
- Track: graded dirt, softness ~0.45, gravel low (0.2) — loose, slidey, ruts build with laps.
- Puddles: visual water already works; the car needs **drag** in water (none today — the town
  river is visual only). Reuse the snow solver's "deep loose snow drag" path keyed on depth under
  `waterLevel`, plus spray from `soil-particles`.
- Mud: high softness + the same drag + lower grip in `sample().mud` zones, darker wet colour.

**Look:** SOR's palette — rust/tan dirt with darker wheel-worn patches, red/white rails, blue
grandstands with a crowd (instanced billboards, coloured noise is enough from this distance),
floodlight towers at the corners, banners. Night with floodlight shadows, or a 19:30 dusk to
avoid a new lighting rig at first. Default camera: follow off, high, zoomed to fit the arena.

**Laps (phase 2):** start/finish gantry (reuse the dry river's gantry mark), sectors by `s`
(must pass every sector in order to count a lap, so cutting across the infield doesn't count),
HUD with lap, current and best time (kept in `localStorage`), a ghost of the best lap.

## Limits that shape it

- **Jumps and landings:** the town's tabletops (1.7 m, ~24° lip) are known to land well with this
  car; keep the stadium ones in that range. Doubles need the gap matched to the speed you can
  carry out of the turn before — tune by driving.
- **Barrier hits:** the walls must not catch a wheel and flip the car. Rounded (capsule) wall
  colliders, low friction, and tune by driving into them at speed.
- **GPU tyre rock limit (48)** doesn't matter: no rocks on the track.
- **Ground mesh is 1 m**, tyres feel 12.5 cm: whoops at 0.45 m high over ~4 m spacing are well
  above that, fine.

## Work plan

1. `terrain/stadium.js`: spline + segment buckets, cross-section, features, hooks. Register
   `?terrain=stadium` in `height.js` and `WORLDS`. Tests: seamless chunks, track closed, spawn on
   the line, jump profiles within limits, crossing level.
2. Colours and shader flag in `terrain-mesh.js` (dirt, racing line, berms, infield, mud), minimap
   palette, time of day, backdrop (stands instead of mountains).
3. Barriers (colliders + striped meshes), corner flags, start gantry, banners, floodlights, grandstands.
4. Water drag + mud zones in the tyre ground lookup.
5. Default stadium camera.
6. Laps, timer, best lap, ghost.
7. Later: layout seeds / more layouts, nitro pickups, AI trucks.

Steps 1–3 give a drivable, good-looking SOR arena; 4–6 make it play like it.
