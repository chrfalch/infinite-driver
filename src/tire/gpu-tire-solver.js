import { d, tgpu } from 'typegpu';
import { convexHull } from '../terrain/convex-hull.js';
import { GRAVEL_HASH_WGSL, GRAVEL_HEIGHT_WGSL } from '../terrain/gravel.js';

// A soft-tyre solver that runs on the GPU (WebGPU compute through TypeGPU).
//
// Each tyre is a torus of particles on a regular grid: `nu` around the wheel, `nv` around the
// tube, so neighbours are found by index arithmetic. One physics step runs `substeps` substeps:
//   predict – gravity and a gauge-pressure force on each particle's share of the surface;
//   solve   – `iterations` Jacobi passes of distance constraints (cords, shear, bending), shape
//             memory, ground and rock contact with friction, and the bead held to the rim seat
//             (its corrections give the reaction force on the hub);
//   finish  – velocities from positions; reduce – bead reactions summed per hub.
// The caller reads back one force and one torque per hub and applies them to its rigid hubs.
//
// A dispatch can run up to MAX_STEPS physics steps (`steps`), so several steps share one GPU round
// trip. Between those steps the kernel moves each hub itself: its spin about the axle is integrated
// from the drive torque, the brake, and the tyre's own torque (the stiff loop, closed here at step
// rate as it is on the CPU), and the rest of its motion carries on at the batch's start velocity.
// One force/torque record per step goes into a log that the CPU applies step by step to Rapier.

export const MAX_TIRES = 4;
export const MAX_STEPS = 4; // physics steps per dispatch
export const MAX_ROCKS = 48;
export const ROCK_FACES = 80;
export const GROUND_N = 129; // ground height samples per side (16 m at 12.5 cm)
const WG = 256;
export const MAX_PER_TIRE = 512; // particles per tyre (workgroup memory)

const Params = d.struct({
  dt: d.f32,
  gravity: d.f32,
  pressure: d.f32,
  particleMass: d.f32,
  cordStiffness: d.f32,
  shearStiffness: d.f32,
  bendStiffness: d.f32,
  shapeStiffness: d.f32,
  treadShapeRadial: d.f32, // 0..1: share of shape memory kept radially on the tread (0 lets it dent)
  treadRadius: d.f32, // rest radius (in the wheel plane) above which a particle counts as tread
  beltStretch: d.f32, // growth past its rest radius a particle may have, as a fraction (0 = off)
  beltPull: d.f32, // fraction of the growth past beltStretch taken back per pass
  treadBend: d.f32, // per pass: how much the tread keeps its moulded curve (around and across)
  sidewallBulge: d.f32, // sidewall push out per metre the tread there is pushed in (at its widest)
  halfWidth: d.f32, // the tyre's rest half-width (m)
  beadPull: d.f32,
  damping: d.f32,
  friction: d.f32,
  rockFriction: d.f32, // rubber on bare rock (grippier than on dusty ground)
  radius: d.f32,
  relaxation: d.f32,
  soilStiffness: d.f32, // N/m per particle; 0 = hard ground
  pressureLead: d.f32, // substeps of wheel spin the pressure normal is turned ahead
  groundStiffness: d.f32, // N/m per particle, hard ground and rocks
  groundDamping: d.f32, // N·s/m per particle
  soilRebound: d.f32, // fraction of soil push kept while the tread lifts off
  maxSink: d.f32,
  rockFloor: d.f32, // how far below bare rock (m) a particle may be pushed before it is stopped
  gravel: d.f32, // 0..1: amount of loose gravel stones on the ground (see terrain/gravel.js)
  groundOriginX: d.f32,
  groundOriginZ: d.f32,
  groundCell: d.f32,
  nu: d.u32,
  nv: d.u32,
  perTire: d.u32,
  tires: d.u32,
  rocks: d.u32,
  beadLow: d.u32,
  beadHigh: d.u32,
  substeps: d.u32,
  iterations: d.u32,
  steps: d.u32, // physics steps in this dispatch (1..MAX_STEPS)
  stepDt: d.f32, // one physics step (s)
});

const Hub = d.struct({
  position: d.vec4f, // w: mirror sign, +1 left tyre, -1 right tyre
  rotation: d.vec4f,
  linvel: d.vec4f,
  angvel: d.vec4f,
  spin: d.vec4f, // xyz: spin axis (world), w: hub inertia about it (kg·m²)
  drive: d.vec4f, // x: drive torque about the axis, y: brake torque limit, z: knuckle spin rate
});

export class GpuTireSolver {
  constructor(device, { nu, nv, tires, restLocal, beadLow, beadHigh }) {
    this.device = device;
    this.root = tgpu.initFromDevice({ device });
    this.nu = nu;
    this.nv = nv;
    this.tires = tires;
    this.perTire = nu * nv;
    this.count = this.perTire * tires;
    this.beadLow = beadLow;
    this.beadHigh = beadHigh;
    this.restLocal = restLocal;
    // Tread: particles whose rest radius (in the wheel plane) is within 6 cm of the outermost.
    let maxR = 0;
    for (let i = 0; i < this.perTire; i++) maxR = Math.max(maxR, Math.hypot(restLocal[i * 3], restLocal[i * 3 + 1]));
    this.treadRadius = maxR - 0.06;
    this.halfWidth = 0;
    for (let i = 0; i < this.perTire; i++) this.halfWidth = Math.max(this.halfWidth, Math.abs(restLocal[i * 3 + 2]));

    const root = this.root;
    this.pos = root.createMutable(d.arrayOf(d.vec4f, this.count));
    this.prev = root.createMutable(d.arrayOf(d.vec4f, this.count));
    this.vel = root.createMutable(d.arrayOf(d.vec4f, this.count));
    this.hubOut = root.createMutable(d.arrayOf(d.vec4f, MAX_STEPS * MAX_TIRES * 2));
    this.rest = root.createReadonly(d.arrayOf(d.vec4f, this.perTire));
    // Uniform, to stay within the default 8 storage buffers per shader stage (Safari included).
    this.hubs = root.createUniform(d.arrayOf(Hub, MAX_TIRES));
    this.params = root.createUniform(Params);
    // Ground grid: GROUND_N² heights, then GROUND_N² bare-rock flags (1 = rock: grippy, hard, no
    // gravel), in one buffer to stay within the storage buffer limit.
    this.ground = root.createReadonly(d.arrayOf(d.f32, GROUND_N * GROUND_N * 2));
    // Rocks: MAX_ROCKS bounding spheres followed by MAX_ROCKS × ROCK_FACES face planes.
    this.rocks = root.createReadonly(d.arrayOf(d.vec4f, MAX_ROCKS * (ROCK_FACES + 1)));

    const restData = new Float32Array(this.perTire * 4);
    for (let i = 0; i < this.perTire; i++) restData.set([restLocal[i * 3], restLocal[i * 3 + 1], restLocal[i * 3 + 2], 0], i * 4);
    this.rest.write(restData);
    this.ground.write(new Float32Array(GROUND_N * GROUND_N * 2));
    this.groundOrigin = { x: -8, z: -8 };
    this.groundCell = 0.125;
    this.rockCount = 0;

    this.hubData = new Float32Array(MAX_TIRES * 24);
    this.raw = {
      pos: root.unwrap(this.pos),
      hubOut: root.unwrap(this.hubOut),
      hubs: root.unwrap(this.hubs),
      params: root.unwrap(this.params),
    };
    this.hubStaging = device.createBuffer({ size: MAX_STEPS * MAX_TIRES * 2 * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.posStaging = device.createBuffer({ size: this.count * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.positions = new Float32Array(this.count * 4);
    this.hubForces = new Float32Array(MAX_STEPS * MAX_TIRES * 8);
    this.busy = false;

    this.buildPipelines();
  }

  buildPipelines() {
    const { root } = this;
    // Two sets (A, B) of particle positions in workgroup memory, split per component to fit the
    // default 16 KB limit. The Jacobi passes ping-pong between them.
    const wg = () => tgpu.workgroupVar(d.arrayOf(d.f32, MAX_PER_TIRE));
    const A = { x: wg(), y: wg(), z: wg() };
    const B = { x: wg(), y: wg(), z: wg() };
    const sets = { ax: A.x, ay: A.y, az: A.z, bx: B.x, by: B.y, bz: B.z };
    // The hub's pose during the dispatch (position with mirror in w, rotation, linvel, angvel): it
    // starts from the uniform and moves on after each physics step.
    const hubW = tgpu.workgroupVar(d.arrayOf(d.vec4f, 4));
    const dbgA = tgpu.workgroupVar(d.arrayOf(d.f32, WG));
    const dbgB = tgpu.workgroupVar(d.arrayOf(d.f32, WG));
    const getP = tgpu.fn([d.u32, d.u32], d.vec3f)/* wgsl */ `(which, k) {
      if (which == 0u) { return vec3f(ax[k], ay[k], az[k]); }
      return vec3f(bx[k], by[k], bz[k]);
    }`.$uses(sets);
    const setP = tgpu.fn([d.u32, d.u32, d.vec3f])/* wgsl */ `(which, k, p) {
      if (which == 0u) { ax[k] = p.x; ay[k] = p.y; az[k] = p.z; }
      else { bx[k] = p.x; by[k] = p.y; bz[k] = p.z; }
    }`.$uses(sets);
    const qrot = tgpu.fn([d.vec4f, d.vec3f], d.vec3f)/* wgsl */ `(q, v) {
      let t = 2.0 * cross(q.xyz, v);
      return v + q.w * t + cross(q.xyz, t);
    }`;
    // Local (per-tyre) neighbour index on the torus grid.
    const nb = tgpu.fn([d.i32, d.i32], d.u32)/* wgsl */ `(u, v) {
      let nu = i32(params.nu);
      let nv = i32(params.nv);
      let uu = ((u % nu) + nu) % nu;
      let vv = ((v % nv) + nv) % nv;
      return u32(uu * nv + vv);
    }`.$uses({ params: this.params });
    const restOf = tgpu.fn([d.u32, d.u32], d.vec3f)/* wgsl */ `(t, k) {
      let r = rest[k].xyz;
      return vec3f(r.x, r.y, r.z * hubs[t].position.w);
    }`.$uses({ rest: this.rest, hubs: this.hubs });
    // Hub pose extrapolated s seconds into the step (small-angle rotation update).
    const hubPoint = tgpu.fn([d.u32, d.u32, d.f32], d.vec3f)/* wgsl */ `(t, k, s) {
      let w = hubW[3].xyz;
      let q = hubW[1];
      let dq = 0.5 * s * vec4f(
        w.x * q.w + w.y * q.z - w.z * q.y,
        w.y * q.w + w.z * q.x - w.x * q.z,
        w.z * q.w + w.x * q.y - w.y * q.x,
        -(w.x * q.x + w.y * q.y + w.z * q.z));
      return hubW[0].xyz + hubW[2].xyz * s + qrot(normalize(q + dq), restOf(t, k));
    }`.$uses({ hubW, qrot, restOf });
    const gravelHash = tgpu.fn([d.i32, d.i32], d.u32)/* wgsl */ `${GRAVEL_HASH_WGSL}`;
    const gravelHeight = tgpu.fn([d.f32, d.f32], d.f32)/* wgsl */ `${GRAVEL_HEIGHT_WGSL}`.$uses({ gravelHash });
    const groundHeight = tgpu.fn([d.f32, d.f32], d.f32)/* wgsl */ `(x, z) {
      let stones = select(0.0, gravelHeight(x, z) * params.gravel, params.gravel > 0.0);
      let last = f32(${GROUND_N - 1}) - 0.001;
      let gx = clamp((x - params.groundOriginX) / params.groundCell, 0.0, last);
      let gz = clamp((z - params.groundOriginZ) / params.groundCell, 0.0, last);
      let ix = u32(floor(gx));
      let iz = u32(floor(gz));
      let fx = gx - f32(ix);
      let fz = gz - f32(iz);
      let n = ${GROUND_N}u;
      // No loose gravel on bare rock.
      let stonesHere = stones * (1.0 - ground[n * n + iz * n + ix]);
      let h00 = ground[iz * n + ix];
      let h10 = ground[iz * n + ix + 1u];
      let h01 = ground[(iz + 1u) * n + ix];
      let h11 = ground[(iz + 1u) * n + ix + 1u];
      if (fx + fz <= 1.0) { return h00 + (h10 - h00) * fx + (h01 - h00) * fz + stonesHere; }
      return h11 + (h01 - h11) * (1.0 - fx) + (h10 - h11) * (1.0 - fz) + stonesHere;
    }`.$uses({ params: this.params, ground: this.ground, gravelHeight });
    // Up normal of the ground grid's triangle under (x, z) (the ground as drawn, without gravel).
    const groundNormal = tgpu.fn([d.f32, d.f32], d.vec3f)/* wgsl */ `(x, z) {
      let last = f32(${GROUND_N - 1}) - 0.001;
      let gx = clamp((x - params.groundOriginX) / params.groundCell, 0.0, last);
      let gz = clamp((z - params.groundOriginZ) / params.groundCell, 0.0, last);
      let ix = u32(floor(gx));
      let iz = u32(floor(gz));
      let n = ${GROUND_N}u;
      let h00 = ground[iz * n + ix];
      let h10 = ground[iz * n + ix + 1u];
      let h01 = ground[(iz + 1u) * n + ix];
      let h11 = ground[(iz + 1u) * n + ix + 1u];
      var sx = (h10 - h00) / params.groundCell;
      var sz = (h01 - h00) / params.groundCell;
      if ((gx - f32(ix)) + (gz - f32(iz)) > 1.0) {
        sx = (h11 - h01) / params.groundCell;
        sz = (h11 - h10) / params.groundCell;
      }
      return normalize(vec3f(-sx, 1.0, -sz));
    }`.$uses({ params: this.params, ground: this.ground });
    // 1 on bare rock (the nearest grid cell's flag), else 0.
    const groundRock = tgpu.fn([d.f32, d.f32], d.f32)/* wgsl */ `(x, z) {
      let last = f32(${GROUND_N - 1});
      let ix = u32(clamp(round((x - params.groundOriginX) / params.groundCell), 0.0, last));
      let iz = u32(clamp(round((z - params.groundOriginZ) / params.groundCell), 0.0, last));
      return ground[${GROUND_N * GROUND_N}u + iz * ${GROUND_N}u + ix];
    }`.$uses({ params: this.params, ground: this.ground });

    // Distance constraints for particle k of tyre t (one Jacobi pass).
    const constrain = tgpu.fn([d.u32, d.u32, d.u32], d.vec3f)/* wgsl */ `(t, k, src) {
      let u = i32(k / params.nv);
      let v = i32(k % params.nv);
      let x = getP(src, k);
      let r0 = restOf(t, k);
      var delta = vec3f(0.0);
      var weight = 0.0;
      for (var c = 0; c < 12; c++) {
        var ou = 0;
        var ov = 0;
        var s = params.cordStiffness;
        if (c == 0) { ou = 1; } else if (c == 1) { ou = -1; } else if (c == 2) { ov = 1; } else if (c == 3) { ov = -1; }
        else if (c == 4) { ou = 1; ov = 1; s = params.shearStiffness; }
        else if (c == 5) { ou = -1; ov = -1; s = params.shearStiffness; }
        else if (c == 6) { ou = 1; ov = -1; s = params.shearStiffness; }
        else if (c == 7) { ou = -1; ov = 1; s = params.shearStiffness; }
        else if (c == 8) { ou = 2; s = params.bendStiffness; }
        else if (c == 9) { ou = -2; s = params.bendStiffness; }
        else if (c == 10) { ov = 2; s = params.bendStiffness; }
        else { ov = -2; s = params.bendStiffness; }
        if (s <= 0.0) { continue; }
        let j = nb(u + ou, v + ov);
        let restLen = length(restOf(t, j) - r0);
        let dvec = getP(src, j) - x;
        let len = length(dvec);
        if (len > 1e-6) {
          delta += s * 0.5 * (len - restLen) * (dvec / len);
          weight += s;
        }
      }
      return x + params.relaxation * delta / max(weight * 0.25, 1.0);
    }`.$uses({ params: this.params, getP, nb, restOf });

    // Contact force on one particle: a stiff spring into the ground (or the softer soil spring)
    // and into rocks, plus Coulomb friction that at most stops the sliding this substep. Explicit
    // forces, so the ground's push on the tyre is known exactly for the hub's momentum balance.
    // vTrial is the particle velocity after all other forces this substep.
    const contactForce = tgpu.fn([d.vec3f, d.vec3f, d.f32, d.f32], d.vec3f)/* wgsl */ `(x, vTrial, m, dt) {
      var f = vec3f(0.0);
      // Bare rock does not give like soil.
      let soft = params.soilStiffness > 0.0 && groundRock(x.x, x.z) < 0.5;
      // The ground pushes along its normal (the triangle's slope), by the depth along it: on a steep
      // face a straight-up push let a tyre pressed sideways sink into the rock.
      let gn = groundNormal(x.x, x.z);
      let depth = (groundHeight(x.x, x.z) + params.radius - x.y) * gn.y;
      if (depth > 0.0) {
        var push = select(params.groundStiffness, params.soilStiffness, soft) * depth;
        let vn0 = dot(vTrial, gn);
        if (soft && vn0 > 0.0) {
          // Soil pushes back fully while compressed, only partly as the tread lifts (it absorbs energy).
          push *= params.soilRebound;
        }
        // Normal damping, integrated implicitly (stable at any strength): the tread settles on the
        // ground instead of bouncing in and out of contact between substeps.
        let c = params.groundDamping;
        let vn = (vn0 + push * dt / m) / (1.0 + c * dt / m);
        push = (vn - vn0) * m / dt;
        // Ground friction is applied after the constraint passes (see the finish step), where the
        // whole substep's sliding is known.
        f += gn * max(push, 0.0);
      }
      for (var r = 0u; r < params.rocks; r++) {
        let sphere = rocks[r];
        if (distance(x, sphere.xyz) > sphere.w + params.radius) { continue; }
        var best = -1e9;
        var n = vec3f(0.0, 1.0, 0.0);
        for (var fc = 0u; fc < ${ROCK_FACES}u; fc++) {
          let plane = rocks[${MAX_ROCKS}u + r * ${ROCK_FACES}u + fc];
          let dist = dot(plane.xyz, x) - plane.w;
          if (dist > best) { best = dist; n = plane.xyz; }
        }
        if (best < params.radius) {
          let vn0 = dot(vTrial + f * (dt / m), n);
          let spring = params.groundStiffness * (params.radius - best);
          let vn = (vn0 + spring * dt / m) / (1.0 + params.groundDamping * dt / m);
          let push = max((vn - vn0) * m / dt, 0.0);
          let vRel = vTrial + f * (dt / m);
          let vt = vRel - n * dot(vRel, n);
          let speed = length(vt);
          if (speed > 1e-6) { f -= (vt / speed) * min(speed * m / dt, params.rockFriction * push); }
          f += n * push;
        }
      }
      return f;
    }`.$uses({ params: this.params, rocks: this.rocks, groundHeight, groundNormal, groundRock });

    // Safety floor: if a particle is ever driven deep into the ground, put it back (rare; the
    // contact springs normally hold it).
    const floorClamp = tgpu.fn([d.vec3f], d.vec3f)/* wgsl */ `(pIn) {
      var p = pIn;
      let floorDepth = select(params.rockFloor, params.maxSink, params.soilStiffness > 0.0 && groundRock(p.x, p.z) < 0.5);
      let floor = groundHeight(p.x, p.z) + params.radius - floorDepth;
      if (p.y < floor) { p.y = floor; }
      return p;
    }`.$uses({ params: this.params, groundHeight, groundRock });

    // How far a particle must move to get out of any rock, back to 1 cm inside the contact skin
    // (the contact spring's own working depth). The rock contact is a penalty force in the
    // prediction; the constraint passes after it (cords, pressure, shape) can drive the tread back
    // into a rock, which sank it up to 7 cm into a 21 cm rock. The finish step removes that.
    const rockPushOut = tgpu.fn([d.vec3f], d.vec3f)/* wgsl */ `(p) {
      var out = vec3f(0.0);
      for (var r = 0u; r < params.rocks; r++) {
        let sphere = rocks[r];
        if (distance(p, sphere.xyz) > sphere.w + params.radius) { continue; }
        var best = -1e9;
        var n = vec3f(0.0, 1.0, 0.0);
        for (var fc = 0u; fc < ${ROCK_FACES}u; fc++) {
          let plane = rocks[${MAX_ROCKS}u + r * ${ROCK_FACES}u + fc];
          let dist = dot(plane.xyz, p + out) - plane.w;
          if (dist > best) { best = dist; n = plane.xyz; }
        }
        let allowed = params.radius - 0.01;
        if (best < allowed) { out += n * (allowed - best); }
      }
      return out;
    }`.$uses({ params: this.params, rocks: this.rocks });

    // Distance from a particle to the nearest surface (ground or rock), for drawing: the tread lugs
    // are drawn no taller than this, so they flatten where the tyre presses on something.
    const clearance = tgpu.fn([d.vec3f], d.f32)/* wgsl */ `(p) {
      var c = p.y - groundHeight(p.x, p.z);
      for (var r = 0u; r < params.rocks; r++) {
        let sphere = rocks[r];
        if (distance(p, sphere.xyz) > sphere.w + 0.1) { continue; }
        var best = -1e9;
        for (var fc = 0u; fc < ${ROCK_FACES}u; fc++) {
          let plane = rocks[${MAX_ROCKS}u + r * ${ROCK_FACES}u + fc];
          best = max(best, dot(plane.xyz, p) - plane.w);
        }
        c = min(c, best);
      }
      return clamp(c, 0.0, 0.1);
    }`.$uses({ params: this.params, rocks: this.rocks, groundHeight });

    // One workgroup per tyre runs the whole physics step, so a step is a single dispatch.
    const stepTyre = tgpu.computeFn({
      in: { groupId: d.builtin.workgroupId, localIndex: d.builtin.localInvocationIndex },
      workgroupSize: [WG],
    })/* wgsl */ `{
      let t = in.groupId.x;
      let lid = in.localIndex;
      let per = params.perTire;
      let base = t * per;
      let dt = params.dt;
      let m = params.particleMass;

      for (var k = lid; k < per; k += ${WG}u) { setP(0u, k, pos[base + k].xyz); }
      if (lid == 0u) {
        hubW[0] = hubs[t].position;
        hubW[1] = hubs[t].rotation;
        hubW[2] = hubs[t].linvel;
        hubW[3] = hubs[t].angvel;
      }
      workgroupBarrier();

      for (var ps = 0u; ps < params.steps; ps++) {
      // The hub's force and torque on the tyre follow from momentum balance: the tyre's change
      // of momentum minus the external forces (gravity, ground, rocks). That is exact however well
      // the constraint passes converge; summing the passes' corrections overshoots when they fight.
      var hubForce = vec3f(0.0);
      var hubTorque = vec3f(0.0);
      var dbgCount = 0.0;
      var dbgFric = 0.0;
      let hsPos = hubW[0];
      let hsRot = hubW[1];
      let hsLin = hubW[2];
      let hsAng = hubW[3];
      let hsSpin = hubs[t].spin;
      let hsDrive = hubs[t].drive;
      for (var s = 0u; s < params.substeps; s++) {
        let s0 = dt * f32(s);
        let c0 = hsPos.xyz + hsLin.xyz * s0;
        var momentum = vec3f(0.0);
        var angular = vec3f(0.0);
        var extForce = vec3f(0.0);
        var externalTorque = vec3f(0.0);
        // Predict: gravity, pressure, damping, contact; A -> B, previous positions kept in storage.
        for (var k = lid; k < per; k += ${WG}u) {
          let u = i32(k / params.nv);
          let v = i32(k % params.nv);
          let x = getP(0u, k);
          let vOld = vel[base + k].xyz;
          let pushMemory = vel[base + k].w;
          momentum -= m * vOld;
          angular -= m * cross(x - c0, vOld);
          let du = getP(0u, nb(u + 1, v)) - getP(0u, nb(u - 1, v));
          let dv = getP(0u, nb(u, v + 1)) - getP(0u, nb(u, v - 1));
          // Pressure on this particle's share of the surface. The explicit step applies the force
          // to where the surface will be, so the area vector is advanced by its own rate of change
          // (from the neighbours' velocities) over pressureLead substeps. Without this, a spinning
          // tyre feels a drag torque proportional to spin (about 30 N·m per rad/s at 120 kPa).
          let dvu = vel[base + nb(u + 1, v)].xyz - vel[base + nb(u - 1, v)].xyz;
          let dvv = vel[base + nb(u, v + 1)].xyz - vel[base + nb(u, v - 1)].xyz;
          let sign = hsPos.w;
          var area = 0.25 * cross(du, dv) * sign;
          area += 0.25 * (cross(dvu, dv) + cross(du, dvv)) * sign * (params.pressureLead * dt);
          let gravity = vec3f(0.0, -params.gravity * m, 0.0);
          var vl = vOld + dt * (gravity + params.pressure * area) / m;
          // Damping of motion relative to the wheel's rigid motion (rolling itself is not damped).
          let rigid = hsLin.xyz + cross(hsAng.xyz, x - c0);
          vl -= (vl - rigid) * min(1.0, params.damping * dt);
          // Ground push and rocks.
          let fc = contactForce(x, vl, m, dt);
          vl += fc * (dt / m);
          let ext = gravity + fc;
          extForce += ext;
          externalTorque += cross(x - c0, ext);
          // The ground's normal push sets the friction budget in the finish step. Stiff contact
          // springs make a tread particle bounce in and out of contact between substeps, so the
          // budget remembers recent contact (it fades over a few substeps) to keep the patch gripping.
          let inContact = groundHeight(x.x, x.z) + params.radius > x.y;
          let pushNow = max(dot(fc, groundNormal(x.x, x.z)), 0.0) * select(0.0, 1.0, inContact);
          var pushed = max(pushNow, pushMemory * 0.6);
          if (pushed < 1.0) { pushed = 0.0; }
          prev[base + k] = vec4f(x, pushed);
          setP(1u, k, x + vl * dt);
        }
        workgroupBarrier();
        // Jacobi passes ping-pong B -> A -> B ...: cords, shear, bending, shape memory, and the
        // bead held on the rim seat.
        let st = dt * f32(s + 1u);
        let center = hsPos.xyz + hsLin.xyz * st;
        let axleDir = qrot(hsRot, vec3f(0.0, 0.0, 1.0));
        var src = 1u;
        for (var it = 0u; it < params.iterations; it++) {
          for (var k = lid; k < per; k += ${WG}u) {
            var p = constrain(t, k, src);
            let seat = hubPoint(t, k, st);
            // Shape memory only acts across the tread (radially and sideways), not around the
            // axle: the wheel's torque goes through the bead and the cords, as on a real tyre.
            let around = normalize(cross(axleDir, p - center) + vec3f(1e-6, 0.0, 0.0));
            var shape = params.shapeStiffness * (seat - p);
            shape -= around * dot(shape, around);
            // On the tread, shape memory holds the cross-section sideways but mostly lets the tread
            // move in radially: pressure and the cords carry the load, so a rock dents the tread
            // locally (and the sidewalls bulge) instead of lifting the whole tyre like a rigid ring.
            let r0 = restOf(t, k);
            let treadW = clamp((length(r0.xy) - params.treadRadius) / 0.04, 0.0, 1.0);
            let rel = p - center;
            let radial = normalize(rel - axleDir * dot(rel, axleDir) + vec3f(0.0, 1e-6, 0.0));
            shape -= radial * dot(shape, radial) * treadW * (1.0 - params.treadShapeRadial);
            // Sidewall bulge: the cords across keep their length, so where the tread is pushed in the
            // sidewalls bow out, as a real tyre's do. The pull toward the moulded shape then aims
            // sidewallBulge times the tread's inward travel (at this point around the wheel) out
            // sideways, most at the sidewall's widest.
            if (params.sidewallBulge > 0.0 && treadW < 1.0) {
              let crown = u32(i32(k / params.nv)) * params.nv;
              let relC = getP(src, crown) - center;
              let rCrown = length(relC - axleDir * dot(relC, axleDir));
              let pushedIn = max(0.0, length(restOf(t, crown).xy) - rCrown);
              let widest = clamp(abs(r0.z) / params.halfWidth, 0.0, 1.0);
              let out = axleDir * sign(r0.z) * (params.sidewallBulge * pushedIn * widest * (1.0 - treadW));
              shape += params.shapeStiffness * out;
            }
            p += shape;
            // Belt bending: the tread keeps its moulded curve with its neighbours around the wheel
            // and across it, so the ground or a rock flattens a longer piece of the tread instead of
            // pressing a small dent into it like a rubber sheet.
            if (params.treadBend > 0.0 && treadW > 0.0) {
              let ub = i32(k / params.nv);
              let vb = i32(k % params.nv);
              let ua = nb(ub - 1, vb);
              let uc = nb(ub + 1, vb);
              let va = nb(ub, vb - 1);
              let vc = nb(ub, vb + 1);
              let x0 = getP(src, k);
              let lapU0 = seat - 0.5 * (hubPoint(t, ua, st) + hubPoint(t, uc, st));
              let lapU = x0 - 0.5 * (getP(src, ua) + getP(src, uc));
              let lapV0 = seat - 0.5 * (hubPoint(t, va, st) + hubPoint(t, vc, st));
              let lapV = x0 - 0.5 * (getP(src, va) + getP(src, vc));
              p += params.treadBend * treadW * 0.5 * ((lapU0 - lapU) + (lapV0 - lapV));
            }
            let vv = k % params.nv;
            if (vv >= params.beadLow && vv <= params.beadHigh) { p += params.beadPull * (seat - p); }
            // Belt: the cords alone let the pressure balloon the tyre (more with higher pressure and
            // a bigger tyre), so a particle that grows more than beltStretch past its rest radius is
            // pulled back, as the steel belt and plies of a real tyre hold it. Moving in (a dent)
            // stays free. Part of the excess per pass: a hard limit makes the hub bounce.
            if (params.beltStretch > 0.0) {
              let relB = p - center;
              let radB = relB - axleDir * dot(relB, axleDir);
              let rNow = length(radB);
              let rMax = length(r0.xy) * (1.0 + params.beltStretch);
              if (rNow > rMax) { p -= params.beltPull * treadW * (1.0 - rMax / rNow) * radB; }
            }
            setP(1u - src, k, floorClamp(p));
          }
          workgroupBarrier();
          src = 1u - src;
        }
        // Finish: ground friction, velocities, the result in A, and the momentum balance.
        for (var k = lid; k < per; k += ${WG}u) {
          var p = getP(src, k);
          let pr = prev[base + k];
          // Coulomb friction for a tread particle on the ground: hold it where it was (static), or
          // let it slide by what exceeds μ·N over the substep. Applied once, so its force is exact.
          let push = pr.w;
          if (push > 0.0) {
            // Sliding in the ground's plane (on flat ground, sideways and along).
            let gn = groundNormal(p.x, p.z);
            let moved = p - pr.xyz;
            let slide = moved - gn * dot(moved, gn);
            let len = length(slide);
            let mu = select(params.friction, params.rockFriction, groundRock(p.x, p.z) > 0.5);
            let limit = mu * push * dt * dt / m;
            var cut = slide;
            if (len > limit) { cut = slide * (limit / len); }
            p -= cut;
            let ff = -cut * (m / (dt * dt));
            dbgCount += 1.0;
            dbgFric += ff.z;
            extForce += ff;
            externalTorque += cross(p - c0, ff);
          }
          // Rocks: push a tread particle that the passes drove into a rock back out, and count the
          // push as an external force (the rock's), so the hub force stays a true momentum balance.
          let outOfRock = rockPushOut(p);
          if (dot(outOfRock, outOfRock) > 0.0) {
            p += outOfRock;
            let fr = outOfRock * (m / (dt * dt));
            extForce += fr;
            externalTorque += cross(p - c0, fr);
          }
          let vNew = (p - pr.xyz) / dt;
          vel[base + k] = vec4f(vNew, push);
          setP(0u, k, p);
          momentum += m * vNew;
          angular += m * cross(p - c0, vNew);
        }
        // Force and torque the hub put into the tyre this substep; the hub feels the opposite.
        hubForce -= momentum / dt - extForce;
        hubTorque -= angular / dt - externalTorque;
        workgroupBarrier();
      }

      // Park the positions in storage (the reduction below reuses both sets as scratch). The
      // clearance for drawing is only needed after the last step.
      let lastStep = ps + 1u == params.steps;
      for (var k = lid; k < per; k += ${WG}u) {
        let p = getP(0u, k);
        pos[base + k] = vec4f(p, select(0.0, clearance(p), lastStep));
      }
      workgroupBarrier();

      // Sum the hub force and torque across the workgroup (reusing set B as scratch).
      let scale = 1.0 / f32(params.substeps);
      setP(1u, lid, hubForce * scale);
      setP(0u, lid, hubTorque * scale);
      dbgA[lid] = dbgCount * scale;
      dbgB[lid] = dbgFric * scale;
      workgroupBarrier();
      for (var stride = ${WG / 2}u; stride > 0u; stride = stride / 2u) {
        if (lid < stride) {
          setP(1u, lid, getP(1u, lid) + getP(1u, lid + stride));
          setP(0u, lid, getP(0u, lid) + getP(0u, lid + stride));
          dbgA[lid] += dbgA[lid + stride];
          dbgB[lid] += dbgB[lid + stride];
        }
        workgroupBarrier();
      }
      if (lid == 0u) {
        let force = getP(1u, 0u);
        let torque = getP(0u, 0u);
        let o = (ps * ${MAX_TIRES}u + t) * 2u;
        hubOut[o] = vec4f(force, dbgA[0]);
        hubOut[o + 1u] = vec4f(torque, dbgB[0]);
        // Move the hub on by one physics step, as Rapier will: the spin from the drive torque, the
        // tyre's torque about the axle, and the brake (a torque that at most stops the spin relative
        // to the knuckle); everything else at the batch's start velocity.
        let axis = hsSpin.xyz;
        let h = params.stepDt;
        let spin = dot(hsAng.xyz, axis);
        var spinNew = spin + h * (hsDrive.x + dot(torque, axis)) / hsSpin.w;
        var rel = spinNew - hsDrive.z;
        let brakeCut = h * hsDrive.y / hsSpin.w;
        if (abs(rel) <= brakeCut) { rel = 0.0; } else { rel -= sign(rel) * brakeCut; }
        spinNew = hsDrive.z + rel;
        let w = hsAng.xyz + axis * (spinNew - spin);
        let turn = w * h;
        let angle = length(turn);
        var dq = vec4f(0.0, 0.0, 0.0, 1.0);
        if (angle > 1e-9) { dq = vec4f(turn / angle * sin(0.5 * angle), cos(0.5 * angle)); }
        let q = hsRot;
        hubW[0] = vec4f(hsPos.xyz + hsLin.xyz * h, hsPos.w);
        hubW[1] = normalize(vec4f(
          dq.w * q.xyz + q.w * dq.xyz + cross(dq.xyz, q.xyz),
          dq.w * q.w - dot(dq.xyz, q.xyz)));
        hubW[3] = vec4f(w, 0.0);
      }
      workgroupBarrier();
      // Back to the particle positions for the next step.
      if (!lastStep) {
        for (var k = lid; k < per; k += ${WG}u) { setP(0u, k, pos[base + k].xyz); }
        workgroupBarrier();
      }
      }
    }`.$uses({
      hubW,
      clearance,
      rockPushOut,
      params: this.params,
      hubs: this.hubs,
      groundHeight,
      groundNormal,
      groundRock,
      pos: this.pos,
      prev: this.prev,
      vel: this.vel,
      hubOut: this.hubOut,
      getP,
      setP,
      nb,
      qrot,
      hubPoint,
      restOf,
      constrain,
      contactForce,
      floorClamp,
      dbgA,
      dbgB,
    });

    this.pipeline = root.createComputePipeline({ compute: stepTyre });
  }

  // Places every particle on its tyre's moulded shape around the given hubs, at rest.
  reset(hubs) {
    this.writeHubs(hubs);
    const data = new Float32Array(this.count * 4);
    // The rubber starts moving with its hub (a respawn or rebuild can happen at speed).
    const vel = new Float32Array(this.count * 4);
    const q = [0, 0, 0, 1];
    const zero = { x: 0, y: 0, z: 0 };
    for (let t = 0; t < this.tires; t++) {
      const h = hubs[t];
      const v = h.linvel ?? zero;
      const w = h.angvel ?? zero;
      for (let k = 0; k < this.perTire; k++) {
        const r = [this.restLocal[k * 3], this.restLocal[k * 3 + 1], this.restLocal[k * 3 + 2] * h.mirror];
        const p = rotate(h.rotation ?? q, r);
        data.set([h.position.x + p[0], h.position.y + p[1], h.position.z + p[2], 1], (t * this.perTire + k) * 4);
        vel.set([v.x + w.y * p[2] - w.z * p[1], v.y + w.z * p[0] - w.x * p[2], v.z + w.x * p[1] - w.y * p[0], 0], (t * this.perTire + k) * 4);
      }
    }
    this.device.queue.writeBuffer(this.raw.pos, 0, data);
    this.device.queue.writeBuffer(this.root.unwrap(this.prev), 0, data);
    this.device.queue.writeBuffer(this.root.unwrap(this.vel), 0, vel);
    this.positions.set(data);
  }

  setParams(settings, dt) {
    const s = settings;
    this.substeps = Math.max(1, Math.round(s.substeps));
    this.iterations = Math.max(1, Math.round(s.iterations));
    this.paramValues = {
      dt: dt / this.substeps,
      gravity: 9.81,
      pressure: s.pressureKpa * 1000,
      particleMass: s.rubberMass / this.perTire,
      cordStiffness: s.cordStiffness,
      shearStiffness: s.shearStiffness,
      bendStiffness: s.bendStiffness,
      shapeStiffness: s.shapeStiffness,
      treadShapeRadial: s.treadShapeRadial ?? 1,
      treadRadius: this.treadRadius,
      beltStretch: s.beltStretch ?? 0,
      beltPull: s.beltPull ?? 0.3,
      treadBend: s.treadBend ?? 0,
      sidewallBulge: s.sidewallBulge ?? 0,
      halfWidth: this.halfWidth,
      beadPull: s.beadPull,
      damping: s.damping,
      friction: s.friction,
      rockFriction: s.rockFriction ?? s.friction,
      radius: s.contactRadius,
      relaxation: s.relaxation,
      // Soft ground is an explicit soil spring, capped below the stability limit for this substep.
      soilStiffness: s.soilStiffness > 0 ? Math.min(s.soilStiffness, (3.2 * (s.rubberMass / this.perTire)) / ((dt / this.substeps) ** 2)) : 0,
      soilRebound: s.soilRebound ?? 0.35,
      pressureLead: s.pressureLead ?? 1,
      // Hard ground and rocks: the stiffest contact spring the substep allows, lightly damped.
      groundStiffness: (3.2 * (s.rubberMass / this.perTire)) / ((dt / this.substeps) ** 2),
      // Critically damped contact (2·√(k·m)); the kernel integrates it implicitly.
      groundDamping: 2 * Math.sqrt(((3.2 * (s.rubberMass / this.perTire)) / ((dt / this.substeps) ** 2)) * (s.rubberMass / this.perTire)),
      maxSink: s.maxSink ?? 0.25,
      rockFloor: s.rockFloor ?? 0.06,
      gravel: s.gravel ?? 0,
      groundOriginX: this.groundOrigin.x,
      groundOriginZ: this.groundOrigin.z,
      groundCell: this.groundCell,
      nu: this.nu,
      nv: this.nv,
      perTire: this.perTire,
      tires: this.tires,
      rocks: this.rockCount,
      beadLow: this.beadLow,
      beadHigh: this.beadHigh,
      substeps: this.substeps,
      iterations: this.iterations,
      steps: this.paramValues?.steps ?? 1,
      stepDt: dt,
    };
    this.params.write(this.paramValues);
    this.settings = settings;
    this.dt = dt;
  }

  // Ground heights on a GROUND_N² grid starting at (originX, originZ) with the given spacing.
  // `grid`: GROUND_N² heights followed by GROUND_N² bare-rock flags.
  setGround(grid, originX, originZ, cell) {
    this.ground.write(grid);
    this.groundOrigin = { x: originX, z: originZ };
    this.groundCell = cell;
    if (this.settings) this.setParams(this.settings, this.dt);
  }

  // Rocks as bounding spheres and face planes (normal, offset), up to MAX_ROCKS.
  setRocks(rocks) {
    const n = Math.min(rocks.length, MAX_ROCKS);
    const data = new Float32Array(MAX_ROCKS * (ROCK_FACES + 1) * 4);
    for (let r = 0; r < n; r++) {
      data.set(rocks[r].sphere, r * 4);
      data.set(rocks[r].planes.subarray(0, ROCK_FACES * 4), (MAX_ROCKS + r * ROCK_FACES) * 4);
    }
    this.rocks.write(data);
    this.rockCount = n;
    this.rockList = rocks.slice(0, n); // for drawing (the tyre mesh keeps its tread out of rocks)
    if (this.settings) this.setParams(this.settings, this.dt);
  }

  writeHubs(hubs) {
    const h = this.hubData;
    h.fill(0);
    hubs.forEach((hub, t) => {
      const o = t * 24;
      h.set([hub.position.x, hub.position.y, hub.position.z, hub.mirror], o);
      const q = hub.rotation;
      h.set([q.x, q.y, q.z, q.w], o + 4);
      h.set([hub.linvel.x, hub.linvel.y, hub.linvel.z, 0], o + 8);
      h.set([hub.angvel.x, hub.angvel.y, hub.angvel.z, 0], o + 12);
      // Only used between the steps of a multi-step dispatch (see the kernel).
      const axis = hub.spinAxis ?? rotateObj(q, { x: 0, y: 0, z: 1 });
      h.set([axis.x, axis.y, axis.z, hub.inertia ?? 1], o + 16);
      h.set([hub.driveTorque ?? 0, hub.brakeTorque ?? 0, hub.knuckleSpin ?? 0, 0], o + 20);
    });
    this.device.queue.writeBuffer(this.raw.hubs, 0, h);
  }

  // Runs one physics step for all tyres. Resolves with per-hub [fx, fy, fz, _, tx, ty, tz, _].
  // With readPositions, the particle positions are copied back too (for drawing).
  // Pipelined use: submit() records and queues a step without waiting; the returned promise
  // resolves with the forces once the GPU is done. step() is submit() followed by waiting.
  // `steps` physics steps run in this one dispatch; the result then holds one record per step
  // (hubForces[(step * MAX_TIRES + t) * 8 ...]).
  submit(hubs, { readPositions = false, steps = 1 } = {}) {
    steps = Math.max(1, Math.min(MAX_STEPS, steps));
    if (steps !== this.paramValues.steps) {
      this.paramValues.steps = steps;
      this.params.write(this.paramValues);
    }
    this.writeHubs(hubs);
    const encoder = this.root['~unstable'].createCommandEncoder();
    const pass = encoder.beginComputePass();
    this.pipeline.with(pass).dispatchWorkgroups(this.tires);
    pass.end();
    const raw = this.root.unwrap(encoder);
    raw.copyBufferToBuffer(this.raw.hubOut, 0, this.hubStaging, 0, MAX_STEPS * MAX_TIRES * 2 * 16);
    if (readPositions) raw.copyBufferToBuffer(this.raw.pos, 0, this.posStaging, 0, this.count * 16);
    encoder.submit();
    return this.collect(readPositions);
  }

  async collect(readPositions) {
    const maps = [this.hubStaging.mapAsync(GPUMapMode.READ)];
    if (readPositions) maps.push(this.posStaging.mapAsync(GPUMapMode.READ));
    await Promise.all(maps);
    this.hubForces.set(new Float32Array(this.hubStaging.getMappedRange()));
    this.hubStaging.unmap();
    if (readPositions) {
      this.positions.set(new Float32Array(this.posStaging.getMappedRange()));
      this.posStaging.unmap();
    }
    return this.hubForces;
  }

  // Runs one physics step for all tyres and waits for the per-hub forces (and, with
  // readPositions, the particle positions, mapped together with the forces).
  step(hubs, { readPositions = false, steps = 1 } = {}) {
    return this.submit(hubs, { readPositions, steps });
  }

  destroy() {
    this.hubStaging.destroy();
    this.posStaging.destroy();
    for (const b of [this.pos, this.prev, this.vel, this.hubOut, this.rest, this.hubs, this.params, this.ground, this.rocks]) {
      b.destroy?.();
    }
  }
}

const rotateObj = (q, v) => {
  const [x, y, z] = rotate(q, [v.x, v.y, v.z]);
  return { x, y, z };
};

function rotate(q, v) {
  const [x, y, z] = v;
  const qx = q.x ?? q[0];
  const qy = q.y ?? q[1];
  const qz = q.z ?? q[2];
  const qw = q.w ?? q[3];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}

// Rock → bounding sphere and the outward face planes of its convex hull for the GPU: the same
// solid Rapier builds with ColliderDesc.convexHull, so tyres and chassis meet the same rock.
export function rockToGpu(rock) {
  const v = rock.vertices;
  const n = v.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += v[i * 3];
    cy += v[i * 3 + 1];
    cz += v[i * 3 + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let radius = 0;
  for (let i = 0; i < n; i++) radius = Math.max(radius, Math.hypot(v[i * 3] - cx, v[i * 3 + 1] - cy, v[i * 3 + 2] - cz));
  const planes = new Float32Array(ROCK_FACES * 4);
  // Unused slots: a plane far away that every point is deep inside, so it never wins the max.
  for (let f = 0; f < ROCK_FACES; f++) planes.set([0, 1, 0, 1e6], f * 4);
  convexHull(v)
    .slice(0, ROCK_FACES)
    .forEach(([a, b, c], f) => {
      const ax = v[a * 3], ay = v[a * 3 + 1], az = v[a * 3 + 2];
      const ux = v[b * 3] - ax, uy = v[b * 3 + 1] - ay, uz = v[b * 3 + 2] - az;
      const wx = v[c * 3] - ax, wy = v[c * 3 + 1] - ay, wz = v[c * 3 + 2] - az;
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      planes.set([nx, ny, nz, nx * ax + ny * ay + nz * az], f * 4);
    });
  return { sphere: [cx, cy, cz, radius], planes };
}
