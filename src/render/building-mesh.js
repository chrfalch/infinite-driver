// The dark town's buildings (terrain/buildings.js), all of a chunk's merged into one
// flat-shaded mesh: a body with windows drawn per pixel from a facade attribute, and a roof (gable,
// hip, flat with a cornice and a rooftop block, a copper dome, or a spire).
//
// Any building between the camera and the car is cut away around the line of sight (a dithered
// hole), so the car stays in view among tall buildings.
import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardNodeMaterial, Vector3 } from 'three/webgpu';
import { attribute, cross, dot, float, floor, fract, hash, length, mix, positionWorld, screenCoordinate, smoothstep, step, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { GLASS_WALLS, ROOFS, WALLS } from '../terrain/buildings.js';

const FLOOR = 3.2; // m per storey (as terrain/buildings.js)
const BAY = 2.6; // m, about, per window bay
// Facade kinds (third component of the facade attribute).
const PLAIN = 0;
const WINDOWS = 1;
const GLASS = 2;

// ---- Mesh data ------------------------------------------------------------------------------

class Builder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.colors = [];
    this.facade = [];
  }
  // One triangle, wound to face away from `centre` (every part is convex).
  tri(a, b, c, color, fa, fb, fc, centre) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len;
    ny /= len;
    nz /= len;
    const mx = (a[0] + b[0] + c[0]) / 3 - centre[0];
    const my = (a[1] + b[1] + c[1]) / 3 - centre[1];
    const mz = (a[2] + b[2] + c[2]) / 3 - centre[2];
    if (nx * mx + ny * my + nz * mz < 0) {
      [b, c] = [c, b];
      [fb, fc] = [fc, fb];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const [p, f] of [[a, fa], [b, fb], [c, fc]]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(nx, ny, nz);
      this.colors.push(color.r, color.g, color.b);
      this.facade.push(f[0], f[1], f[2]);
    }
  }
  quad(a, b, c, d, color, fa, fb, fc, fd, centre) {
    this.tri(a, b, c, color, fa, fb, fc, centre);
    this.tri(a, c, d, color, fa, fc, fd, centre);
  }
}

const tmp = new Color();
const wallColor = new Color();
const roofColor = new Color();
const FLAT_ROOF = new Color('#a7a39a');
const COPPER = new Color('#4f9a62'); // green copper (or sky blue, below)
const BLUE_DOME = new Color('#5aa9d6');
const ROOFTOP = new Color('#c9c5bc');
const pickColor = (list, t, out) => out.set(list[Math.floor(t * list.length) % list.length]);

// Draws one building into `out`.
function addBuilding(out, b) {
  const { x, z, ux, uz, nx, nz } = b;
  // Local (a along the street, y, c away from it) to world.
  const P = (a, y, c) => [x + ux * a + nx * c, y, z + uz * a + nz * c];
  const hw = b.w / 2;
  const hd = b.d / 2;
  const eaves = b.ground + b.height;
  pickColor(b.glass ? GLASS_WALLS : WALLS, b.wall, wallColor).offsetHSL(0, 0, (b.extra - 0.5) * 0.06);
  pickColor(ROOFS, b.roofColor, roofColor);
  const plain = [0, 0, PLAIN];

  // A box from y0 to y1 over a local rectangle; walls carry window coordinates when `kind` has them.
  const box = (a0, c0, ha, hc, y0, y1, color, kind, top) => {
    const centre = P(a0, (y0 + y1) / 2, c0);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sa, sc]) => [a0 + sa * ha, c0 + sc * hc]);
    for (let k = 0; k < 4; k++) {
      const [a1, c1] = corners[k];
      const [a2, c2] = corners[(k + 1) % 4];
      const len = Math.hypot(a2 - a1, c2 - c1);
      // A whole number of window bays across the wall.
      const bays = Math.max(1, Math.round(len / BAY));
      const v0 = y0 - b.ground;
      const v1 = y1 - b.ground;
      out.quad(
        P(a1, y0, c1), P(a2, y0, c2), P(a2, y1, c2), P(a1, y1, c1), color,
        [0, v0, kind], [bays, v0, kind], [bays, v1, kind], [0, v1, kind],
        centre,
      );
    }
    if (top) {
      const t = corners.map(([a, c]) => P(a, y1, c));
      out.quad(t[0], t[1], t[2], t[3], top, plain, plain, plain, plain, centre);
    }
    // Closed underneath too: the shadow pass draws back faces, and an open box lets sunlight
    // through (a bright seam in the shadow under a cornice).
    const u = corners.map(([a, c]) => P(a, y0, c));
    out.quad(u[0], u[1], u[2], u[3], color, plain, plain, plain, plain, centre);
  };

  // The body.
  box(0, 0, hw, hd, b.base, eaves, wallColor, b.glass ? GLASS : WINDOWS, tmp.copy(wallColor).multiplyScalar(0.8));

  if (b.roof === 'flat') {
    // A cornice a little proud of the walls, the roof inside it, and a block for the stairs and
    // machinery on top.
    box(0, 0, hw + 0.25, hd + 0.25, eaves, eaves + 0.55, tmp.copy(wallColor).multiplyScalar(0.82), PLAIN, FLAT_ROOF);
    if (b.extra < 0.7) {
      const sa = (b.extra - 0.35) * hw;
      box(sa, -hd * 0.2, hw * 0.3, hd * 0.3, eaves + 0.55, eaves + 2.8, ROOFTOP, PLAIN, FLAT_ROOF);
    }
  } else if (b.roof === 'gable') {
    // Ridge along the street, eaves overhanging the walls.
    const o = 0.45;
    const rise = (hd + o) * 0.85;
    const centre = P(0, eaves + rise / 3, 0);
    for (const s of [-1, 1]) {
      out.quad(P(-hw - o, eaves, s * (hd + o)), P(hw + o, eaves, s * (hd + o)), P(hw + o, eaves + rise, 0), P(-hw - o, eaves + rise, 0), roofColor, plain, plain, plain, plain, centre);
      // Gable end (wall colour).
      out.tri(P(s * hw, eaves, -hd), P(s * hw, eaves, hd), P(s * hw, eaves + rise * (hd / (hd + o)), 0), wallColor, plain, plain, plain, centre);
    }
    if (b.extra < 0.5) box(hw * 0.45, hd * 0.35, 0.35, 0.35, eaves, eaves + rise + 0.8, tmp.set('#8c5a46'), PLAIN, tmp);
  } else if (b.roof === 'hip') {
    // Four slopes up to a ridge along the longer side.
    const o = 0.4;
    const along = hw >= hd;
    const ha = hw + o;
    const hc = hd + o;
    const rise = Math.min(ha, hc) * 0.75;
    const ridge = Math.max(0.01, Math.abs(ha - hc));
    const r0 = along ? P(-ridge, eaves + rise, 0) : P(0, eaves + rise, -ridge);
    const r1 = along ? P(ridge, eaves + rise, 0) : P(0, eaves + rise, ridge);
    const c = [P(-ha, eaves, -hc), P(ha, eaves, -hc), P(ha, eaves, hc), P(-ha, eaves, hc)];
    const centre = P(0, eaves + rise / 3, 0);
    if (along) {
      out.quad(c[0], c[1], r1, r0, roofColor, plain, plain, plain, plain, centre);
      out.quad(c[2], c[3], r0, r1, roofColor, plain, plain, plain, plain, centre);
      out.tri(c[1], c[2], r1, roofColor, plain, plain, plain, centre);
      out.tri(c[3], c[0], r0, roofColor, plain, plain, plain, centre);
    } else {
      out.quad(c[1], c[2], r1, r0, roofColor, plain, plain, plain, plain, centre);
      out.quad(c[3], c[0], r0, r1, roofColor, plain, plain, plain, plain, centre);
      out.tri(c[0], c[1], r0, roofColor, plain, plain, plain, centre);
      out.tri(c[2], c[3], r1, roofColor, plain, plain, plain, centre);
    }
  } else if (b.roof === 'dome') {
    // A drum, then a ribbed copper dome with a small lantern.
    box(0, 0, hw + 0.2, hd + 0.2, eaves, eaves + 0.5, tmp.copy(wallColor).multiplyScalar(0.82), PLAIN, FLAT_ROOF);
    const radius = Math.min(hw, hd) * 0.85;
    const y0 = eaves + 0.5;
    const segments = 12;
    const rings = 5;
    const centre = P(0, y0, 0);
    const at = (i, k) => {
      const t = (i / segments) * Math.PI * 2;
      const phi = (k / rings) * (Math.PI / 2);
      return P(Math.cos(t) * Math.cos(phi) * radius, y0 + Math.sin(phi) * radius * 1.1, Math.sin(t) * Math.cos(phi) * radius);
    };
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < segments; i++) {
        const color = tmp.copy(b.extra < 0.5 ? COPPER : BLUE_DOME).multiplyScalar(i % 2 ? 0.92 : 1);
        if (k === rings - 1) out.tri(at(i, k), at(i + 1, k), at(0, rings), color, plain, plain, plain, centre);
        else out.quad(at(i, k), at(i + 1, k), at(i + 1, k + 1), at(i, k + 1), color, plain, plain, plain, plain, centre);
      }
    }
    box(0, 0, 0.5, 0.5, y0 + radius * 1.05, y0 + radius * 1.1 + 1.6, tmp.set('#e9e4d6'), PLAIN, COPPER);
  } else if (b.roof === 'spire') {
    // A belfry stage, then a tall pointed spire.
    box(0, 0, hw + 0.2, hd + 0.2, eaves, eaves + 0.5, tmp.copy(wallColor).multiplyScalar(0.82), PLAIN, FLAT_ROOF);
    const y0 = eaves + 0.5;
    box(0, 0, hw * 0.7, hd * 0.7, y0, y0 + 4, wallColor, WINDOWS, null);
    const top = P(0, y0 + 4 + b.w * 1.2, 0);
    const c = [P(-hw * 0.78, y0 + 4, -hd * 0.78), P(hw * 0.78, y0 + 4, -hd * 0.78), P(hw * 0.78, y0 + 4, hd * 0.78), P(-hw * 0.78, y0 + 4, hd * 0.78)];
    const centre = P(0, y0 + 5, 0);
    for (let k = 0; k < 4; k++) out.tri(c[k], c[(k + 1) % 4], top, roofColor, plain, plain, plain, centre);
  }
}

// The buildings among a chunk's rocks as vertex data (plain arrays, so a worker can build it).
export function buildingsMeshData(rocks) {
  const out = new Builder();
  // (The sunny town's kit buildings are drawn from their models, see render/town-kit-mesh.js.)
  for (const rock of rocks) if (rock.building && !rock.building.kit) addBuilding(out, rock.building);
  if (!out.positions.length) return null;
  return {
    positions: new Float32Array(out.positions),
    normals: new Float32Array(out.normals),
    colors: new Float32Array(out.colors),
    facade: new Float32Array(out.facade),
  };
}

// ---- Material -------------------------------------------------------------------------------

const facade = attribute('facade', 'vec3');
const baseColor = attribute('color', 'vec3');
const bay = facade.x;
const v = facade.y;
const kind = facade.z;
const storey = v.div(FLOOR);
const cellU = fract(bay);
const cellV = fract(storey);
const upper = step(1, storey);
const box = (lo, hi, t, edge = 0.02) => smoothstep(lo - edge, lo + edge, t).mul(smoothstep(hi + edge, hi - edge, t));
// Upper storeys: a window in the middle of each bay; the ground floor: wide shop windows.
const upperWindow = box(0.24, 0.76, cellU).mul(box(0.3, 0.82, cellV));
const shopWindow = box(0.1, 0.9, cellU).mul(box(0.08, 0.72, cellV));
const punched = mix(shopWindow, upperWindow, upper).mul(step(0, v));
// Glass towers: a curtain wall of tall panes between thin mullions and floor bands.
const curtain = box(0.05, 0.95, cellU, 0.01).mul(box(0.14, 0.97, cellV, 0.01)).mul(step(0, v));
const isWindows = step(0.5, kind).mul(step(kind, 1.5));
const isGlass = step(1.5, kind);
const pane = punched.mul(isWindows).add(curtain.mul(isGlass));
// Each pane reflects the sky a little differently; a few have their blinds down.
const paneId = hash(floor(bay).add(floor(storey).mul(57.3)).add(positionWorld.x.floor().mul(0.13)));
const glassTone = mix(vec3(0.17, 0.24, 0.32), vec3(0.52, 0.66, 0.78), paneId.mul(0.8));
const glassColor = mix(glassTone, vec3(0.86, 0.82, 0.7), step(0.9, paneId).mul(0.6));
// Ledges between the storeys of plain walls, and a darker plinth below the ground.
const ledge = step(cellV, 0.06).mul(upper).mul(isWindows).mul(0.12);
const plinth = step(v, 0).mul(0.25);
const wall = baseColor.mul(float(1).sub(ledge).sub(plinth));

// The cutaway: fragments near the line from the car toward the camera, on the camera's side of
// the car, are dropped in a dither pattern that thins out toward the hole's edge.
const carPosition = uniform(new Vector3(0, -1000, 0));
const toCamera = uniform(new Vector3(0, 1, 0));
const rel = positionWorld.sub(carPosition);
const along = dot(rel, toCamera);
const across = length(cross(rel, toCamera));
const hole = smoothstep(8, 4.5, across).mul(smoothstep(1.5, 4, along));
const dither = hash(vec2(screenCoordinate.x.floor(), screenCoordinate.y.floor()).dot(vec2(1, 113.7)));

export const buildingMaterial = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
buildingMaterial.colorNode = vec4(mix(wall, glassColor, pane), 1);
buildingMaterial.roughnessNode = mix(float(0.85), float(0.15), pane);
buildingMaterial.metalnessNode = pane.mul(0.3);
// At night about half the windows are lit, warm and of varying brightness; the rest stay dark.
const night = uniform(0);
const litPick = hash(floor(bay).mul(13.1).add(floor(storey).mul(7.7)).add(positionWorld.z.floor().mul(0.31)));
const lit = step(0.5, litPick).mul(litPick.mul(0.8).add(0.4));
buildingMaterial.emissiveNode = vec3(1, 0.7, 0.38).mul(pane).mul(lit).mul(night).mul(mix(float(0.75), float(0.45), isGlass));
export function setBuildingNight(on) {
  night.value = on ? 1 : 0;
}
buildingMaterial.maskNode = hole.lessThan(dither.mul(0.98).add(0.01));
// The shadows stay whole.
buildingMaterial.maskShadowNode = float(1).greaterThan(0);

// The sunny town's modelled buildings (render/town-kit-mesh.js): their colours come with the
// model, the glass (the `glass` attribute) is glossy and lights up at night like the drawn
// windows, and they are cut away around the car the same way.
const kitGlass = attribute('glass', 'float');
export const kitBuildingMaterial = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
kitBuildingMaterial.colorNode = vec4(baseColor, 1);
kitBuildingMaterial.roughnessNode = mix(float(0.85), float(0.15), kitGlass);
kitBuildingMaterial.metalnessNode = kitGlass.mul(0.3);
const kitLit = hash(positionWorld.x.mul(0.7).floor().add(positionWorld.y.mul(0.4).floor().mul(31.7)).add(positionWorld.z.mul(0.7).floor().mul(7.3)));
kitBuildingMaterial.emissiveNode = vec3(1, 0.7, 0.38).mul(kitGlass).mul(step(0.5, kitLit).mul(kitLit.mul(0.8).add(0.4))).mul(night).mul(0.75);
kitBuildingMaterial.maskNode = buildingMaterial.maskNode;
kitBuildingMaterial.maskShadowNode = buildingMaterial.maskShadowNode;

// Where the car is and the direction from it toward the camera (called every frame).
export function setBuildingCutaway(car, camera) {
  carPosition.value.set(car.x, car.y + 0.6, car.z);
  toCamera.value.subVectors(camera.position, carPosition.value).normalize();
}

export function createBuildingsMeshFromData(data) {
  if (!data) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
  geometry.setAttribute('facade', new BufferAttribute(data.facade, 3));
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, buildingMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';
  return mesh;
}

export function createBuildingsMesh(rocks) {
  return createBuildingsMeshFromData(buildingsMeshData(rocks));
}
