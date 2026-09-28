# Research: a second world, "Dry River"

Goal: a new world next to the canyon on `main`. A dry, rocky river bed that climbs gently, with
trees on both banks (the reference is a Land Cruiser on a yellow sandstone trail among eucalypts).
It must be fun and calm to drive: not too rocky, not too steep.

Answer: **yes, it fits well.** The game already has a world switch (`?terrain=canyon|hills|flat`).
The canyon is one height function plus some optional hooks. A new world is mostly one new file,
plus a colour palette, a rock colour and a tree shape.

## How a world works today

Everything comes from one seeded function, `heightAt(x, z)` (`src/terrain/height.js`). Physics
colliders, the GPU tyre ground grid, tracks, soil, rocks, plants and the ground mesh all use it, in
three places: the main thread, the physics worker and the chunk worker. Each gets only the mode
string (`createHeightField({ mode })`), so a new world works in all three at once.

The canyon adds optional hooks on the function. The other code checks for them:

| Hook | Used by | What it does |
|---|---|---|
| `heightAt.sample(x, z)` | ground colours, plants | h, road mask, rut, distance to road, rock |
| `heightAt.roadDistance` | rocks, respawn | keeps rocks off the road, respawns on it |
| `heightAt.roadHeading` | start, respawn | car faces along the road |
| `heightAt.canyon` | rocks | red rocks, no rocks on cliffs |

Hard-coded canyon parts: `canyonColor` and the road shader in `render/terrain-mesh.js`, red rocks in
`render/rock-mesh.js`, juniper bushes and trees in `render/vegetation-mesh.js`, red mesas and the
sky in `render/backdrop.js`, fog colour in `render/scene.js`.

## Limits that shape the design

1. **GPU tyres see at most 48 rocks** (`MAX_ROCKS`), picked within 14 m of the car. The canyon
   has 70 rocks per 64 m chunk, and the roads are kept clear. A bed full of loose rocks would
   pass 48 quickly, and far rocks would drop out.
2. **The tyres feel the ground at 12.5 cm** (129 x 129 grid over 16 m, straight from `heightAt`).
   But the ground mesh and the chassis collider use a **1 m grid**. So bumps smaller than ~1 m
   are felt but not seen. The existing gravel gets around this: the shader draws the same stones.
3. The hill start from standstill fails above ~17° now. The other agent is fixing that. Keeping
   the track at 3–8° avoids it anyway.

So the rocky feel should come mostly from the **height function** (bedrock slabs, low ledges,
cobble humps at 1 m or larger), plus **fewer, larger rock hulls** near the track, plus the gravel.

## Proposed design

**Layout:** one long river bed that winds and never ends, like a canyon road, but with one family
of curves only (no crossings). It climbs slowly: about **3–6° on average**, some short **8–10°**
pitches at ledges, and no side tilt over ~8°.

**Cross-section (from the centre line):**
- **0–4 m, the bed:** dry sand and gravel, yellow-orange. Shallow low channel. Gravel on.
- **Bedrock slabs:** sandstone plates that stick up 5–25 cm, with rounded edges, 2–6 m wide.
  Made in the height function with cell noise, so tyres and chassis feel them. Some make small
  steps across the bed (10–20 cm, a fun bump, not a wall).
- **4–7 m, banks:** rise 0.5–1.5 m, with scattered cobbles (rock hulls, 20–60 cm).
- **7–25 m, the forest:** eucalyptus trees (tall, pale trunks, thin open crowns), dry grass, some
  bushes. Tree trunks are solid, as now.
- **Further out:** low hills and a sandstone ridge on the horizon (like the photo).

**Rocks:** about 25–35 per chunk, mostly on the banks and the bed edges. A few in the bed to steer
around. No big boulders in the line. That keeps the count near the car under 48.

**Look:** yellow and orange sandstone (not the canyon's red), darker orange wet-looking channels,
grey-green trees, blue sky with a cooler horizon.

**Respawn and start:** set `roadDistance` and `roadHeading` to the bed centre line, so the existing
respawn code puts the car in the bed, facing upstream.

## Work plan

1. `terrain/riverbed.js`: the height function with `sample`, `roadDistance`, `roadHeading`,
   `slab` and `bank` values. Register it as `?terrain=river` in `height.js`. Unit tests: seamless
   chunks, slope limits along the bed (max 10°), respawn point on the bed.
2. Colours: a `riverColor` palette and a bed shader branch (sand, slabs, channel). This needs a
   world value in the shader. A per-vertex attribute is the simplest.
3. Rocks: a density rule per world, and yellow-grey sandstone rocks.
4. Vegetation: an eucalyptus tree shape, and plant rules for the banks.
5. Backdrop and fog: a palette per world (sandstone ridge, blue sky).
6. Panel: a world picker (it reloads the page, like the tyre switch).
7. Test drive in the browser: slope and bump profile along the bed, GPU rock count, frame time.
   Then deploy to a preview URL for the iPhone.

Steps 1 and 7 are the core. With only step 1, the world already drives, with canyon colours.

## Decisions

- A world picker in the panel (it saves the choice and reloads). `?terrain=` still overrides it.
- The canyon stays the default world.
- The bed goes up and down (about 15 m over 4 km), not one endless climb.
