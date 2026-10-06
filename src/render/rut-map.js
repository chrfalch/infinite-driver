// The ruts near the car for vertex shaders: the ground patch (render/ground-surface.js) keeps the
// ground deformation in a texture, `n` x `n` cells of `cell` m from world (origin.x, origin.y).
// Other meshes on the ground (the dry river's rock sheet, the tyre tracks) follow it from there.
// On snow the snow surface (render/snow-surface.js) keeps the whole height there instead, ruts and
// berms included (`absolute`).
import { int, ivec2, mix, step, textureLoad } from 'three/tsl';

// The texture's value at world (x, z), between the cells (the deformation, m, negative in a rut; or
// on snow the height), or `outside` beyond the patch.
export function rutAt({ deform, origin, n, cell }, x, z, outside = 0) {
  const gx = x.sub(origin.x).div(cell);
  const gz = z.sub(origin.y).div(cell);
  const inside = step(0, gx).mul(step(gx, n - 1)).mul(step(0, gz)).mul(step(gz, n - 1));
  const ix = gx.floor().clamp(0, n - 2);
  const iz = gz.floor().clamp(0, n - 2);
  const fx = gx.sub(ix).clamp(0, 1);
  const fz = gz.sub(iz).clamp(0, 1);
  const at = (dx, dz) => textureLoad(deform, ivec2(int(ix).add(dx), int(iz).add(dz))).x;
  const a = at(0, 0).add(at(1, 0).sub(at(0, 0)).mul(fx));
  const b = at(0, 1).add(at(1, 1).sub(at(0, 1)).mul(fx));
  return mix(outside, a.add(b.sub(a).mul(fz)), inside);
}
