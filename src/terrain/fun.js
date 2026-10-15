// The sunny town's fun places, for the minimap (ui/minimap.js): stunt parks, street jumps and
// river gap jumps in a square of the world, as { kind: 'park' | 'jump' | 'gap', x, z }.
//
// funPlaces() returns a stepper, so the river gaps (found by walking the streets) can be looked
// for a little per frame: step(budgetMs) works until the budget runs out and returns the places
// once all are found (null until then).
import { JUMP_SPACING, streetJumpAt } from './town.js';
import { crossing, streetPoint } from './buildings.js';

export function funPlaces(heightAt, cx, cz, half, now = () => performance.now()) {
  if (!heightAt.town) return { step: () => [] };
  const places = [];
  const corners = [[cx - half, cz - half], [cx + half, cz - half], [cx - half, cz + half], [cx + half, cz + half]];
  const inside = (x, z) => Math.abs(x - cx) <= half && Math.abs(z - cz) <= half;
  const range = (f, spacing, pad = 0) => {
    const a = corners.map(([x, z]) => f.across(x, z));
    return [Math.floor((Math.min(...a) - pad) / spacing), Math.floor((Math.max(...a) + pad) / spacing)];
  };
  const [f0, f1] = heightAt.streetFamilies;

  // Stunt parks: the middle of each park block.
  const { sizeX, sizeZ, isPark } = heightAt.blocks;
  const [i0, i1] = range(f0, sizeX);
  const [j0, j1] = range(f1, sizeZ);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      if (!isPark(i, j)) continue;
      const c = crossing(heightAt, (i + 0.5) * sizeX, (j + 0.5) * sizeZ);
      if (c && inside(c.x, c.z) && heightAt.sample(c.x, c.z).park > 0.9) places.push({ kind: 'park', x: c.x, z: c.z });
    }
  }

  // Street jumps, and the streets to walk for river gaps.
  const walks = [];
  heightAt.streetFamilies.forEach((f, fi) => {
    const [k0, k1] = range(f, f.spacing).map((k, n) => k + n);
    const ts = corners.map(([x, z]) => (f.alongX ? x : z));
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    for (let k = k0; k <= k1; k++) {
      for (let m = Math.floor(t0 / JUMP_SPACING); m <= Math.floor(t1 / JUMP_SPACING); m++) {
        const jump = streetJumpAt(fi, k, m);
        const p = jump && streetPoint(f, k, jump.t0);
        if (p && inside(p.x, p.z) && heightAt.sample(p.x, p.z).jump > 0.8) places.push({ kind: 'jump', x: p.x, z: p.z });
      }
      walks.push({ f, k, t: t0, t1 });
    }
  });

  // River gaps: the kicker's lip, found by walking each street in 5 m steps.
  let w = 0;
  let found = null;
  return {
    step(budgetMs = 2) {
      if (found) return found;
      const start = now();
      while (w < walks.length) {
        const walk = walks[w];
        for (; walk.t <= walk.t1; walk.t += 5) {
          const p = streetPoint(walk.f, walk.k, walk.t);
          if (!p || !inside(p.x, p.z)) continue;
          if (heightAt.sample(p.x, p.z).gapLift > 2.4 && !places.some((q) => q.kind === 'gap' && Math.hypot(q.x - p.x, q.z - p.z) < 40)) places.push({ kind: 'gap', x: p.x, z: p.z });
          if (now() - start > budgetMs) return null;
        }
        w++;
      }
      found = places;
      return found;
    },
  };
}
