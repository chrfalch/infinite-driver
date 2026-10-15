// The stadium's gravel, per pixel: loose stones on the rust dirt, so the arena floor reads as a
// gravel track from the chase camera and not as smooth paint. Two sizes of stone (pebbles about
// 15-30 cm, grit about 6-12 cm), each a sun-lit dome with its own tone and a darker ring round it
// where it sits in the dirt, over a fine speckle of sand. `loose` (0..1, per vertex) is how much
// loose gravel lies there: little in the worn lanes, more on the edges and mounds, none under water.
//
// Each layer fades to its average look where its stones get smaller than a few pixels, so the far
// ground does not shimmer and keeps the same tone. These stones are only drawn: the tyres roll over
// terrain/gravel.js's finer stones, which gravelShade draws up close.
import { Fn, If, float, fract, fwidth, int, max, mix, normalize, positionWorld, smoothstep, sqrt, uint, vec2, vec3 } from 'three/tsl';

const SUN = normalize(vec3(-35, 45, -25)); // as terrain/gravel.js
const SQUASH = 0.6; // dome height / radius

function hashCell(n, seed) {
  let h = uint(int(n.x)).mul(uint(73856093)).bitXor(uint(int(n.y)).mul(uint(19349663))).bitXor(uint(seed));
  h = h.bitXor(h.shiftRight(uint(16))).mul(uint(0x45d9f3b));
  h = h.bitXor(h.shiftRight(uint(16))).mul(uint(0x45d9f3b));
  return h.bitXor(h.shiftRight(uint(16)));
}
const bits = (h, shift) => float(h.shiftRight(uint(shift)).bitAnd(uint(1023))).div(1023);

// One layer of stones on a grid of `cell` m, a stone in a cell with chance `fill` (0..1, per pixel).
// Returns the ground colour over `dirt` there.
function stoneLayer(p, dirt, cell, seed, fill, size) {
  const c = p.div(cell).floor();
  const best = float(-1).toVar(); // the highest dome over the pixel (m), or the nearest ring
  const light = float(0).toVar();
  const tone = vec3(0).toVar();
  const ring = float(0).toVar();
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const n = c.add(vec2(dx, dz));
      const h = hashCell(n, seed);
      const present = bits(h, 0).lessThan(fill);
      const ox = bits(h, 10).mul(0.6).add(0.2);
      const oz = bits(h, 20).mul(0.6).add(0.2);
      const k = fract(ox.mul(13.7).add(oz.mul(7.3)));
      const r = k.mul(size[1] - size[0]).add(size[0]).mul(cell);
      const d = p.sub(n.add(vec2(ox, oz)).mul(cell));
      const dd = d.dot(d);
      const top = sqrt(max(r.mul(r).sub(dd), 0));
      // The ring of shade round the stone (out to 1.35 r) where it beds into the dirt.
      const shade = smoothstep(r.mul(1.35), r, sqrt(dd)).mul(0.35);
      If(present, () => {
        ring.assign(max(ring, shade));
        If(top.mul(SQUASH).greaterThan(best), () => {
          best.assign(top.mul(SQUASH));
          light.assign(max(normalize(vec3(d.x, top.div(SQUASH), d.y)).dot(SUN), 0));
          // Grey, beige and pale ochre stones, light or dark, some taking on the dirt's colour.
          const grey = fract(ox.mul(5.1).add(oz.mul(11.9)));
          const pale = mix(vec3(0.56, 0.53, 0.5), vec3(0.68, 0.57, 0.44), grey);
          const stained = mix(pale, dirt.mul(1.35), fract(ox.mul(3.3).add(oz.mul(17.1))).mul(0.75));
          tone.assign(stained.mul(k.mul(0.45).add(0.75)));
        });
      });
    }
  }
  const lit = tone.mul(light.mul(0.7).add(0.45));
  const ground = dirt.mul(float(1).sub(ring));
  return mix(ground, lit, best.greaterThan(0).select(float(1), float(0)));
}

// How much of a layer of `cell` m stones shows at this pixel's footprint: all of it down to about
// 4 px a cell, none below about 1.5 px.
const shown = (cell) => smoothstep(0.65, 0.25, fwidth(positionWorld.x).div(cell));

// The stadium ground's colour from the dirt colour (the vertex colour) and `loose`.
export const stadiumGravel = Fn(([dirt, loose]) => {
  const p = positionWorld.xz;
  const out = dirt.toVar();
  // Sand: a fine speckle of lighter and darker grains (4 cm).
  // (The fades are worked out first: derivatives are not allowed in the branches below.)
  const showSand = shown(0.04).toVar();
  const showGrit = shown(0.11).toVar();
  const showPebbles = shown(0.3).toVar();
  const sand = mix(float(0.88), float(1.12), bits(hashCell(p.div(0.04).floor(), 911), 3));
  out.assign(out.mul(mix(float(1), sand, showSand)));
  const pebbles = loose.mul(0.55).add(0.08);
  const grit = loose.mul(0.5).add(0.3);
  // The stones; far off, the average of each layer: the dirt a little paler and greyer.
  const average = (cover) => mix(out, mix(out, vec3(0.6, 0.55, 0.5), 0.35), cover);
  If(showGrit.greaterThan(0.001), () => {
    out.assign(mix(average(grit.mul(0.25)), stoneLayer(p, out, 0.11, 0x5a17, grit, [0.22, 0.38]), showGrit));
  }).Else(() => {
    out.assign(average(grit.mul(0.25)));
  });
  If(showPebbles.greaterThan(0.001), () => {
    out.assign(mix(average(pebbles.mul(0.3)), stoneLayer(p, out, 0.3, 0x2b9d, pebbles, [0.2, 0.42]), showPebbles));
  }).Else(() => {
    out.assign(average(pebbles.mul(0.3)));
  });
  return out;
});
