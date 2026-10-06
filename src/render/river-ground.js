// Prototype ground looks for the dry river's rock sheet, picked with ?ground=<look>:
//
//   facets  the flat-shaded, vertex-coloured sheet as before (render/rock-surface.js)
//   sand    weathered sandstone, smooth-shaded with a fine chipped relief, wind-blown sand in the hollows
//   cobbles water-polished bedrock, with packed, rounded river cobbles and gravel in the low ground
//   mud     cracked, curled silt in the low channel and hollows; the rock below the high-water line
//           stained darker, with dark streaks of desert varnish down steep faces
//   pbr     (default) photo-scanned CC0 textures (ambientCG: sandstone, sand), triplanar on the rock,
//           height-blended into sand by the same masks
//
// All are per pixel on the sheet's own 25 cm mesh: no change to its shape, so the tyres and the
// colliders feel the same ground. The masks come from per-vertex values the chunk worker adds
// (terrain/rock-sheet.js): 'ground' = (soil, rut, lift, dist) and 'aboveBed'. The relief is a bump
// (Mikkelsen's surface gradient from screen-space derivatives of a height in metres), so it only
// shades; the silhouettes stay the mesh's.
import { Color, MeshStandardNodeMaterial, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader } from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  dot,
  float,
  floor,
  fract,
  fwidth,
  max,
  mix,
  normalWorldGeometry,
  normalize,
  positionWorld,
  pow,
  sin,
  smoothstep,
  sqrt,
  texture,
  transformNormalToView,
  vec2,
  vec3,
} from 'three/tsl';
import { worldMode } from '../world.js';
import { SOIL_MIN } from '../terrain/riverbed.js';

const params = new URLSearchParams(globalThis.location?.search ?? '');
export const GROUND_LOOKS = ['facets', 'sand', 'cobbles', 'mud', 'pbr'];
// The photo look is the default; ?ground=facets shows the old flat-shaded sheet.
export const GROUND_LOOK = GROUND_LOOKS.includes(params.get('ground')) ? params.get('ground') : 'pbr';
// The photo look on the dry river: the ground outside the bed and the loose rocks get textures too.
// Fixed for the page load (false in the workers, which do not draw), so other worlds pay nothing.
export const RIVER_PBR = GROUND_LOOK === 'pbr' && worldMode() === 'river';

// ---- Noise (all on world xz in metres) -------------------------------------------------------

const hash = (ix, iz) => {
  const a = fract(ix.mul(0.1031));
  const b = fract(iz.mul(0.1031));
  const d = a.mul(b.add(33.33)).add(b.mul(a.add(33.33))).add(a.mul(a.add(33.33)));
  return fract(a.add(d).add(b.add(d)).mul(a.add(d)));
};
const noise = (p) => {
  const i = floor(p);
  const f = p.sub(i);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const a = mix(hash(i.x, i.y), hash(i.x.add(1), i.y), u.x);
  const b = mix(hash(i.x, i.y.add(1)), hash(i.x.add(1), i.y.add(1)), u.x);
  return mix(a, b, u.y);
};
// Fractal noise in [0, 1), `octaves` layers each twice as fine.
const fbm = (p, octaves = 4) => {
  let sum = float(0);
  let amp = 0.5;
  let norm = 0;
  let q = p;
  for (let k = 0; k < octaves; k++) {
    sum = sum.add(noise(q).mul(amp));
    norm += amp;
    amp *= 0.5;
    q = q.mul(2.03).add(vec2(17.1, 9.7));
  }
  return sum.div(norm);
};
// Cells of a jittered grid: x = distance to the nearest point, y = to the second nearest, z = the
// nearest cell's random. y - x is about the distance to the cell's edge.
const voronoi = Fn(([p]) => {
  const c = floor(p);
  const f = p.sub(c);
  const d1 = float(9).toVar();
  const d2 = float(9).toVar();
  const id = float(0).toVar();
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cell = c.add(vec2(i, j));
      const o = vec2(hash(cell.x, cell.y), hash(cell.x.add(17.3), cell.y.add(31.1)));
      const r = vec2(i, j).add(o.mul(0.85)).sub(f);
      const d = dot(r, r);
      If(d.lessThan(d1), () => {
        d2.assign(d1);
        d1.assign(d);
        id.assign(hash(cell.x.add(5.7), cell.y.add(9.3)));
      }).ElseIf(d.lessThan(d2), () => {
        d2.assign(d);
      });
    }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
});

// ---- Shading helpers ---------------------------------------------------------------------------

// The normal `n` (world, unit) tilted by the slope of height field `h` (m, per pixel): Mikkelsen,
// "Bump Mapping Unparametrized Surfaces on the GPU", in world space with unscaled derivatives, so
// a height in metres gives its true slope.
export const bump = (n, h) => {
  const sx = positionWorld.dFdx();
  const sy = positionWorld.dFdy();
  const r1 = sy.cross(n);
  const r2 = n.cross(sx);
  const det = dot(sx, r1);
  const grad = r1.mul(h.dFdx()).add(r2.mul(h.dFdy())).mul(det.sign());
  return normalize(n.mul(det.abs()).sub(grad));
};
// Fades fine detail out where it would shimmer: 1 while a `size` m feature spans a few pixels.
const detail = (size) => smoothstep(0.5, 0.15, fwidth(positionWorld.x).add(fwidth(positionWorld.z)).div(size));

// A colour node from an sRGB hex (shader colours are linear).
const hex = (h) => {
  const c = new Color(h);
  return vec3(c.r, c.g, c.b);
};
const grey = (c) => vec3(dot(c, vec3(0.3, 0.59, 0.11)));

// The per-vertex inputs.
const ground = attribute('ground', 'vec4');
const soil = ground.x; // m of soil in the bed's soil pockets (terrain/riverbed.js)
const rut = ground.y; // 0..1 the low channel
const lift = ground.z; // m of rock over the ground beneath (low in the creases)
const aboveBed = attribute('aboveBed', 'float'); // m over the bed floor
const tone = attribute('color', 'vec3'); // each boulder's tone, darker in the creases
const xz = positionWorld.xz;
const N = normalWorldGeometry;

// Weathered sandstone: the boulder's tone, mottled, faintly banded on steep faces, cut by thin
// dark cracks, with a fine chipped relief. `polish` (0..1) smooths it (water-worn).
function sandstone(polish = 0) {
  const mottle = fbm(xz.mul(0.9), 3);
  const grain = fbm(xz.mul(9), 3);
  const band = sin(positionWorld.y.mul(26).add(fbm(xz.mul(0.6), 2).mul(9))).mul(0.5).add(0.5);
  const steep = smoothstep(0.85, 0.55, N.y);
  // Joints: the edges of 0.7 m and 0.25 m cells, broken up so only some edges crack.
  const crackLine = (size, width, key) => {
    const v = voronoi(xz.div(size).add(key));
    return smoothstep(width, width * 0.3, v.y.sub(v.x)).mul(smoothstep(0.55, 0.7, noise(xz.div(size * 1.3).add(key))));
  };
  const cracks = max(crackLine(1.1, 0.035, 3), crackLine(0.35, 0.05, 11).mul(0.4).mul(detail(0.05))).mul(1 - polish * 0.7);
  const color = tone
    .mul(mottle.mul(0.35).add(0.82))
    .mul(grain.mul(0.18 * (1 - polish)).add(0.91 + 0.09 * polish))
    .mul(mix(float(1), band.mul(0.16).add(0.92), steep))
    .mul(cracks.mul(-0.45).add(1));
  const height = fbm(xz.mul(1.6), 3)
    .mul(0.04)
    .add(fbm(xz.mul(7), 3).mul(0.012 * (1 - polish)).mul(detail(0.15)))
    .sub(cracks.mul(0.012));
  return { color, height, roughness: float(0.92 - 0.25 * polish) };
}

// Where loose material settles: in the hollows and the creases between boulders, on flat ground,
// with a ragged edge. `bias` widens it.
function settle(bias = 0) {
  const flat = smoothstep(0.7, 0.9, N.y);
  const ragged = fbm(xz.mul(2.2), 3).sub(0.5).mul(0.06);
  const low = max(smoothstep(0.01, 0.05, soil.add(ragged).add(bias * 0.03)), smoothstep(0.1, 0.03, lift.add(ragged)));
  return low.mul(flat);
}

// ---- The looks ---------------------------------------------------------------------------------

function sandLook() {
  const rock = sandstone(0);
  // Pale sand with wind ripples (about 9 cm apart, wavering) and a sparkle of grains.
  const dir = xz.x.mul(0.8).add(xz.y.mul(0.6));
  const ripple = sin(dir.mul(70).add(fbm(xz.mul(1.5), 2).mul(12))).mul(0.5).add(0.5);
  const grains = noise(xz.mul(220));
  const sandColor = mix(hex('#c9a46a'), hex('#dcc08c'), fbm(xz.mul(0.7), 2))
    .mul(ripple.mul(0.08).add(0.95))
    .mul(grains.mul(0.12).add(0.94));
  // Sand fills from the bottom up: the rock's own relief decides where its edge runs.
  const amount = settle(0);
  const sand = smoothstep(0.4, 0.8, amount.add(rock.height.mul(-6)));
  // A thin dusting on the flat tops of the rock.
  const dust = smoothstep(0.85, 0.97, N.y).mul(fbm(xz.mul(3), 2)).mul(0.35);
  const color = mix(mix(rock.color, sandColor, dust), sandColor, sand);
  const height = mix(rock.height, ripple.mul(0.004).mul(detail(0.09)), sand);
  return { color, height, roughness: mix(rock.roughness, float(1), sand) };
}

function cobblesLook() {
  const rock = sandstone(1);
  // Cobbles about 10-15 cm and gravel about 3 cm, packed in grit.
  const cob = voronoi(xz.div(0.15));
  const edge = cob.y.sub(cob.x); // cell units
  // Each stone a rounded lump inside its cell (radius 0.3-0.5 cells), not filling it: grit shows
  // between, darker in the stone's own contact shadow.
  const radius = cob.z.mul(0.2).add(0.3);
  const round = cob.x.div(radius).oneMinus().max(0).min(edge.mul(4).min(1));
  const cobble = smoothstep(0, 0.12, round);
  const dome = sqrt(round).mul(0.04);
  const gravel = voronoi(xz.div(0.045));
  const pebble = smoothstep(0.06, 0.16, gravel.y.sub(gravel.x));
  const pick = (id) => {
    // Grey granite, white quartz, rusty ironstone, dark basalt, tan sandstone.
    let c = hex('#8f8a82');
    c = mix(c, hex('#d8d2c4'), smoothstep(0.2, 0.21, id));
    c = mix(c, hex('#9c6a45'), smoothstep(0.38, 0.39, id));
    c = mix(c, hex('#4e4a46'), smoothstep(0.55, 0.56, id));
    c = mix(c, hex('#c2a273'), smoothstep(0.72, 0.73, id));
    return c;
  };
  const speckle = noise(xz.mul(160)).mul(0.2).add(0.9);
  const grit = mix(hex('#a48c6a'), hex('#bba27c'), noise(xz.mul(40)));
  const small = mix(grit, pick(fract(gravel.z.mul(7.3))).mul(0.9), pebble.mul(0.8));
  const contact = smoothstep(0, 0.35, cob.x.sub(radius)).mul(0.35).add(0.65);
  const stoneColor = mix(small.mul(contact), pick(cob.z).mul(speckle).mul(sqrt(round).mul(0.35).add(0.75)), cobble);
  const stoneHeight = dome.mul(cobble).add(pebble.mul(0.008)).mul(detail(0.05));
  const amount = settle(0.1).add(smoothstep(0.3, 0.7, rut).mul(0.5)).min(1);
  const bed = smoothstep(0.35, 0.6, amount.add(rock.height.mul(-5)));
  // Polished rock is a little glossier; stones are wet-looking only by colour, not shine.
  return {
    color: mix(rock.color, stoneColor, bed),
    height: mix(rock.height.mul(0.6), stoneHeight, bed),
    roughness: mix(rock.roughness, mix(float(0.95), float(0.7), cobble), bed),
  };
}

function mudLook() {
  const rock = sandstone(0.3);
  // High-water line: below ~45 cm over the bed floor the rock is darker and greyer, with a ragged,
  // fairly sharp edge; dark streaks of desert varnish run down steep faces.
  const line = aboveBed.add(fbm(xz.mul(0.8), 2).sub(0.5).mul(0.15));
  const wet = smoothstep(0.62, 0.55, line);
  const streak = smoothstep(0.55, 0.8, noise(vec2(xz.x.add(xz.y).mul(3), positionWorld.y.mul(0.35))));
  const varnish = streak.mul(smoothstep(0.8, 0.45, N.y));
  const rockColor = mix(rock.color, grey(rock.color).mul(vec3(0.95, 0.92, 0.88)), wet.mul(0.5))
    .mul(wet.mul(-0.3).add(1))
    .mul(varnish.mul(-0.45).add(1));
  // Mud plates about 30 cm, cracked deep and dark, their edges curled up and lighter; finer hairline
  // cracks within.
  const plate = voronoi(xz.div(0.32));
  const edge = plate.y.sub(plate.x);
  const crack = smoothstep(0.1, 0.04, edge.add(noise(xz.mul(9)).mul(0.05)));
  const curl = smoothstep(0.25, 0.04, edge);
  const fine = voronoi(xz.div(0.09).add(plate.z.mul(10)));
  const hair = smoothstep(0.05, 0.015, fine.y.sub(fine.x)).mul(0.5).mul(detail(0.03));
  const silt = mix(hex('#a39580'), hex('#b8aa92'), plate.z);
  const mudColor = mix(silt.mul(curl.mul(0.12).add(1)).mul(hair.mul(-0.25).add(1)), hex('#4a3d31'), crack);
  const mudHeight = curl.mul(0.006).sub(crack.mul(0.015)).sub(hair.mul(0.002)).mul(detail(0.08));
  const amount = settle(-0.2).mul(0.6).add(smoothstep(0.45, 0.8, rut)).min(1);
  const mud = smoothstep(0.4, 0.6, amount.add(rock.height.mul(-5)));
  return {
    color: mix(rockColor, mudColor, mud),
    height: mix(rock.height, mudHeight, mud),
    roughness: mix(rock.roughness, mix(float(0.9), float(1), crack), mud),
  };
}

// ---- Photo textures ----------------------------------------------------------------------------

const loader = new TextureLoader();
function load(name, srgb) {
  // No page (unit tests, workers): an empty texture, so materials still build.
  const t = typeof document === 'undefined' ? new Texture() : loader.load(`${import.meta.env?.BASE_URL ?? '/'}textures/river/${name}.jpg`);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = SRGBColorSpace;
  return t;
}
// Each set: colour, normal (OpenGL convention) and 'arh' (ambient occlusion, roughness, height).
function textureSet(name) {
  return { color: load(`${name}-color`, true), normal: load(`${name}-normal`, false), arh: load(`${name}-arh`, false) };
}

// A texture set mapped from three sides (triplanar), one tile per `size` m, on a surface with world
// normal `N`: the three projections blended by the normal, the normal maps by Golus's whiteout
// blend. Returns the colour, the 'arh' texel and the normal.
function triplanar(set, size, N) {
  const p = positionWorld.div(size);
  const w0 = pow(abs(N), vec3(4));
  const w = w0.div(w0.x.add(w0.y).add(w0.z));
  const s = N.sign();
  const uvX = vec2(p.z.mul(s.x), p.y);
  const uvY = vec2(p.x.mul(s.y), p.z);
  const uvZ = vec2(p.x.mul(s.z.negate()), p.y);
  const tri = (tex) => texture(tex, uvX).mul(w.x).add(texture(tex, uvY).mul(w.y)).add(texture(tex, uvZ).mul(w.z));
  const tnX = unpack(set.normal, uvX).mul(vec3(s.x, 1, 1));
  const tnY = unpack(set.normal, uvY).mul(vec3(s.y, 1, 1));
  const tnZ = unpack(set.normal, uvZ).mul(vec3(s.z.negate(), 1, 1));
  const nX = vec3(tnX.xy.add(N.zy), abs(tnX.z).mul(N.x));
  const nY = vec3(tnY.xy.add(N.xz), abs(tnY.z).mul(N.y));
  const nZ = vec3(tnZ.xy.add(N.xy), abs(tnZ.z).mul(N.z));
  const normal = normalize(nX.zyx.mul(w.x).add(nY.xzy.mul(w.y)).add(nZ.mul(w.z)));
  return { color: tri(set.color).rgb, arh: set.arh ? tri(set.arh) : null, normal };
}
const unpack = (tex, uv) => texture(tex, uv).xyz.mul(2).sub(1);
let rockSet = null;
const rockTextures = () => (rockSet ??= textureSet('rock'));
let soilSet = null;
const soilTextures = () => (soilSet ??= textureSet('soil'));
// The soil pockets' colour at world `p` (xz): the soil texture projected from above, a tile per
// 1.6 m, warmed a little (the tyre tracks in the pockets use it too).
let soilColorMap = null;
// (Only the colour map: the tyre tracks in every world use it, without the rest of the set.)
export const soilColor = (p) => texture((soilColorMap ??= soilSet?.color ?? load('soil-color', true)), p.div(1.6)).rgb.mul(vec3(1.08, 1.0, 0.9));
// Slow patches of tone over the textured bed, so the repeats do not show.
export const groundPatches = (p) => fbm(p.mul(0.35), 3).mul(0.25).add(0.88);

function pbrLook() {
  const soilTex = soilTextures();
  // Rock: triplanar, one texture tile per 2.5 m.
  const rock = triplanar(rockTextures(), 2.5, N);
  const rockN = rock.normal;
  const rockArh = rock.arh;
  // The texture's orange sandstone, nudged toward each boulder's own tone (yellower, varied).
  const toneShift = tone.div(max(grey(tone).x, 0.05)).mul(0.5).add(0.5);
  const rockTexColor = rock.color;
  const rockColor = mix(grey(rockTexColor).mul(tone).mul(2.7), rockTexColor.mul(toneShift).mul(vec3(1.0, 1.08, 1.0)), 0.3);

  // Soil (ambientCG Ground109, dry dirt with grit): projected straight down, a tile per 1.6 m, with
  // slow patches of tone so the repeats do not show.
  const planar = (set, size) => {
    const uv = xz.div(size);
    const tn = unpack(set.normal, uv);
    return { color: texture(set.color, uv).rgb, arh: texture(set.arh, uv), n: normalize(vec3(tn.x.add(N.x), abs(tn.z).mul(N.y), tn.y.negate().add(N.z))) };
  };
  const dirt = planar(soilTex, 1.6);
  const patches = groundPatches(xz);
  // Soil where the soil pockets are (the same depth the tyres go by: soft ground over SOIL_MIN),
  // its edge moved a centimetre either way by the two textures' height maps, so it runs ragged.
  const edge = soil.sub(SOIL_MIN).add(dirt.arh.b.sub(rockArh.b).mul(0.012));
  const soilW = smoothstep(-0.004, 0.004, edge);
  const color = mix(rockColor, soilColor(xz), soilW).mul(patches);
  const n = normalize(mix(rockN, dirt.n, soilW));
  const arh = mix(rockArh, dirt.arh, soilW);
  return { color: color.mul(arh.r.mul(0.5).add(0.5)), normal: n, roughness: arh.g };
}

// Cheap detail for the ground outside the bed (the terrain mesh and the ground patch near the car,
// both shaded by render/terrain-mesh.js groundShading): one forest-floor texture (ambientCG
// Ground078: soil, leaf litter, bark) projected from above. Its colour, divided by its own mean
// colour, scales the vertex colour, so the world's palette (litter, bank sand, soil) stays and the
// texture only adds the small-scale detail. Two scales (2.5 m, and 6.1 m turned) are averaged so
// the tile does not repeat visibly. Three texture reads per pixel.
const FOREST_MEAN = hex('#977248'); // the texture's mean colour
let forest = null;
const forestSet = () => (forest ??= { color: load('forest-color', true), normal: load('forest-normal', false) });
export function forestFloorColor(color, steep) {
  const set = forestSet();
  const uvA = xz.div(2.5);
  const uvB = vec2(xz.x.mul(0.8).sub(xz.y.mul(0.6)), xz.x.mul(0.6).add(xz.y.mul(0.8))).div(6.1);
  const ratio = texture(set.color, uvA).rgb.add(texture(set.color, uvB).rgb).mul(0.5).div(FOREST_MEAN);
  // Not on steep faces (they show rock strata there).
  return color.mul(mix(vec3(1), ratio, steep.oneMinus().mul(0.85)));
}
// The world normal `n` with the texture's normal map (at the 2.5 m scale) blended in.
export function forestFloorNormal(n) {
  const tn = texture(forestSet().normal, xz.div(2.5)).xyz.mul(2).sub(1);
  return normalize(vec3(tn.x.add(n.x), abs(tn.z).mul(n.y), tn.y.negate().add(n.z)));
}

// The loose rocks and pebbles with the photo look: the same sandstone texture from three sides, one
// tile per `size` m, as detail over their own colours (vertex or instance colour, which three
// multiplies in): the texture divided by its mean colour, so each rock keeps its tint. Their faces
// stay hard facets (the normal from screen-space derivatives), with the normal map on each face.
const ROCK_MEAN = hex('#7a5338'); // Rock029's mean colour
//
// `bedMatch`: the rocks' 'bed' attribute (0, or a brightness) makes some of them take the bed rock's
// colour, so they look broken off it; the others keep their own, paler colours for contrast.
export const BED_ROCK = '#8f6b4d'; // about how the bed's textured rock looks
export function rockDetailMaterial({ size, bedMatch = false, roughness = 0.9 }) {
  const material = new MeshStandardNodeMaterial({ roughness, metalness: 0, vertexColors: !bedMatch });
  const face = normalize(positionWorld.dFdx().cross(positionWorld.dFdy()));
  const toCamera = cameraPosition.sub(positionWorld);
  const n = face.mul(dot(face, toCamera).sign());
  const rock = triplanar(rockTextures(), size, n);
  const detail = mix(vec3(1), rock.color.div(ROCK_MEAN), 0.85);
  if (bedMatch) {
    const bed = attribute('bed', 'float');
    material.colorNode = detail.mul(mix(attribute('color', 'vec3'), hex(BED_ROCK).mul(bed), bed.sign()));
  } else material.colorNode = detail;
  material.roughnessNode = rock.arh.g;
  material.normalNode = transformNormalToView(rock.normal);
  return material;
}

// The rock sheet's material for a look (null for the default, flat-shaded one).
export function riverGroundMaterial(look = GROUND_LOOK) {
  const build = { sand: sandLook, cobbles: cobblesLook, mud: mudLook, pbr: pbrLook }[look];
  if (!build) return null;
  const material = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const out = build();
  material.colorNode = out.color;
  material.roughnessNode = out.roughness;
  material.userData.worldNormal = out.normal ?? bump(N, out.height);
  material.normalNode = transformNormalToView(material.userData.worldNormal);
  return material;
}
