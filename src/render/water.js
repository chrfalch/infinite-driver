// The water (the town's river and ponds, the stadium's water holes): one sheet at the water level
// that travels with the car, so the water shows wherever the ground dips below it. Clear teal, with
// small moving ripples that catch the sun; the bed shows through, darker where it is deeper (the
// terrain's colours, render/terrain-mesh.js). Near the car the waves the cars make (render/
// water-waves.js) bend its normals, and churned water shows white foam.
import { DataTexture, FloatType, Mesh, MeshStandardNodeMaterial, NearestFilter, PlaneGeometry, RGBAFormat } from 'three/webgpu';
import { float, int, ivec2, mix, normalize, positionWorld, sin, smoothstep, step, textureLoad, time, transformNormalToView, uniform, vec2, vec3 } from 'three/tsl';
import { WaterWaves } from './water-waves.js';

const SIZE = 330; // m, about the streamed terrain (2 chunks each way of the car's)

// The waves' texture at world (x, z), between the cells: (height, foam, dh/dx, dh/dz), 0 outside.
function wavesAt(texture, origin, n, cell, x, z) {
  const gx = x.sub(origin.x).div(cell).sub(0.5);
  const gz = z.sub(origin.y).div(cell).sub(0.5);
  const inside = step(0, gx).mul(step(gx, n - 1)).mul(step(0, gz)).mul(step(gz, n - 1));
  const ix = gx.floor().clamp(0, n - 2);
  const iz = gz.floor().clamp(0, n - 2);
  const fx = gx.sub(ix).clamp(0, 1);
  const fz = gz.sub(iz).clamp(0, 1);
  const at = (dx, dz) => textureLoad(texture, ivec2(int(ix).add(dx), int(iz).add(dz)));
  const a = mix(at(0, 0), at(1, 0), fx);
  const b = mix(at(0, 1), at(1, 1), fx);
  return mix(a, b, fz).mul(inside);
}

export function createWater(scene, level, depthAt) {
  const waves = depthAt ? new WaterWaves(depthAt) : null;
  const material = new MeshStandardNodeMaterial({ transparent: true, roughness: 0.1, metalness: 0, depthWrite: false });
  const x = positionWorld.x;
  const z = positionWorld.z;
  const a = sin(x.mul(0.9).add(z.mul(0.4)).add(time.mul(1.6)));
  const b = sin(x.mul(-0.5).add(z.mul(1.1)).add(time.mul(1.2)));
  const c = sin(x.mul(2.3).add(z.mul(1.7)).sub(time.mul(2.4)));
  let slopeX = a.mul(0.07).add(c.mul(0.04));
  let slopeZ = b.mul(0.07).sub(c.mul(0.03));
  let color = mix(vec3(0.13, 0.42, 0.5), vec3(0.28, 0.6, 0.65), a.mul(b).mul(0.5).add(0.5).mul(0.5));
  let texture = null;
  let origin = null;
  if (waves) {
    texture = new DataTexture(waves.texData, waves.n, waves.n, RGBAFormat, FloatType);
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.needsUpdate = true;
    origin = uniform(vec2(0, 0));
    const w = wavesAt(texture, origin, waves.n, waves.cell, x, z);
    // The waves' slopes are steep next to a wheel; keep the normal from folding over.
    slopeX = slopeX.add(w.z.clamp(-1.5, 1.5));
    slopeZ = slopeZ.add(w.w.clamp(-1.5, 1.5));
    // Foam in streaks and bubbles rather than a flat white wash; crests a little lighter.
    const grain = sin(x.mul(7.3).add(z.mul(3.1)).add(c)).mul(sin(z.mul(6.1).sub(x.mul(2.7)).add(a))).mul(0.5).add(0.5);
    const foam = smoothstep(0.08, 0.8, w.y.mul(float(0.3).add(grain.mul(1.1)))).mul(0.85);
    color = color.add(w.x.clamp(0, 0.3).mul(0.6));
    color = mix(color, vec3(0.9, 0.95, 0.96), foam);
    material.opacityNode = mix(float(0.8), float(0.97), foam);
    material.roughnessNode = mix(float(0.1), float(0.6), foam);
  } else {
    material.opacity = 0.8;
  }
  material.normalNode = transformNormalToView(normalize(vec3(slopeX.negate(), 1, slopeZ.negate())));
  material.colorNode = color;
  const mesh = new Mesh(new PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), material);
  mesh.name = 'water';
  mesh.position.y = level;
  mesh.receiveShadow = true;
  scene.add(mesh);
  let version = -1;
  return {
    mesh,
    level,
    waves,
    // Keep the sheet and the waves centred on the car, and step the waves.
    update(x, z, dt) {
      mesh.position.x = x;
      mesh.position.z = z;
      if (!waves) return;
      waves.follow(x, z);
      waves.update(dt);
      if (waves.version !== version) {
        version = waves.version;
        origin.value.set(waves.origin.x, waves.origin.y);
        texture.needsUpdate = true;
      }
    },
    // The water's surface height at (x, z), waves included.
    surfaceAt(x, z) {
      return level + (waves ? waves.heightAt(x, z) : 0);
    },
  };
}
