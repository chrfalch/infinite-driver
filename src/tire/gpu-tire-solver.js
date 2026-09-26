import { d, tgpu } from 'typegpu';

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

export const MAX_TIRES = 4;
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
  beadPull: d.f32,
  damping: d.f32,
  friction: d.f32,
  radius: d.f32,
  relaxation: d.f32,
  soilStiffness: d.f32, // N/m per particle; 0 = hard ground
  soilRebound: d.f32, // fraction of soil push kept while the tread lifts off
  maxSink: d.f32,
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
});

const Hub = d.struct({
  position: d.vec4f, // w: mirror sign, +1 left tyre, -1 right tyre
  rotation: d.vec4f,
  linvel: d.vec4f,
  angvel: d.vec4f,
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

    const root = this.root;
    this.pos = root.createMutable(d.arrayOf(d.vec4f, this.count));
    this.prev = root.createMutable(d.arrayOf(d.vec4f, this.count));
    this.vel = root.createMutable(d.arrayOf(d.vec4f, this.count));
    this.hubOut = root.createMutable(d.arrayOf(d.vec4f, MAX_TIRES * 2));
    this.rest = root.createReadonly(d.arrayOf(d.vec4f, this.perTire));
    // Uniform, to stay within the default 8 storage buffers per shader stage (Safari included).
    this.hubs = root.createUniform(d.arrayOf(Hub, MAX_TIRES));
    this.params = root.createUniform(Params);
    this.ground = root.createReadonly(d.arrayOf(d.f32, GROUND_N * GROUND_N));
    // Rocks: MAX_ROCKS bounding spheres followed by MAX_ROCKS × ROCK_FACES face planes.
    this.rocks = root.createReadonly(d.arrayOf(d.vec4f, MAX_ROCKS * (ROCK_FACES + 1)));

    const restData = new Float32Array(this.perTire * 4);
    for (let i = 0; i < this.perTire; i++) restData.set([restLocal[i * 3], restLocal[i * 3 + 1], restLocal[i * 3 + 2], 0], i * 4);
    this.rest.write(restData);
    this.ground.write(new Float32Array(GROUND_N * GROUND_N));
    this.groundOrigin = { x: -8, z: -8 };
    this.groundCell = 0.125;
    this.rockCount = 0;

    this.hubData = new Float32Array(MAX_TIRES * 16);
    this.raw = {
      pos: root.unwrap(this.pos),
      hubOut: root.unwrap(this.hubOut),
      hubs: root.unwrap(this.hubs),
      params: root.unwrap(this.params),
    };
    this.hubStaging = device.createBuffer({ size: MAX_TIRES * 2 * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.posStaging = device.createBuffer({ size: this.count * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.positions = new Float32Array(this.count * 4);
    this.hubForces = new Float32Array(MAX_TIRES * 8);
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
      let h = hubs[t];
      let w = h.angvel.xyz;
      let q = h.rotation;
      let dq = 0.5 * s * vec4f(
        w.x * q.w + w.y * q.z - w.z * q.y,
        w.y * q.w + w.z * q.x - w.x * q.z,
        w.z * q.w + w.x * q.y - w.y * q.x,
        -(w.x * q.x + w.y * q.y + w.z * q.z));
      return h.position.xyz + h.linvel.xyz * s + qrot(normalize(q + dq), restOf(t, k));
    }`.$uses({ hubs: this.hubs, qrot, restOf });
    const groundHeight = tgpu.fn([d.f32, d.f32], d.f32)/* wgsl */ `(x, z) {
      let last = f32(${GROUND_N - 1}) - 0.001;
      let gx = clamp((x - params.groundOriginX) / params.groundCell, 0.0, last);
      let gz = clamp((z - params.groundOriginZ) / params.groundCell, 0.0, last);
      let ix = u32(floor(gx));
      let iz = u32(floor(gz));
      let fx = gx - f32(ix);
      let fz = gz - f32(iz);
      let n = ${GROUND_N}u;
      let h00 = ground[iz * n + ix];
      let h10 = ground[iz * n + ix + 1u];
      let h01 = ground[(iz + 1u) * n + ix];
      let h11 = ground[(iz + 1u) * n + ix + 1u];
      if (fx + fz <= 1.0) { return h00 + (h10 - h00) * fx + (h01 - h00) * fz; }
      return h11 + (h01 - h11) * (1.0 - fx) + (h10 - h11) * (1.0 - fz);
    }`.$uses({ params: this.params, ground: this.ground });

    // Distance constraints, shape memory, and contacts for particle k of tyre t (one Jacobi pass).
    const relax = tgpu.fn([d.u32, d.u32, d.u32, d.u32, d.vec3f, d.f32], d.vec3f)/* wgsl */ `(t, k, src, substep, before, pen0) {
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
      var p = x + params.relaxation * delta / max(weight * 0.25, 1.0);
      if (params.shapeStiffness > 0.0) {
        p += params.shapeStiffness * (hubPoint(t, k, params.dt * f32(substep + 1u)) - p);
      }
      let surface = groundHeight(p.x, p.z) + params.radius;
      // On soft ground the hard floor is maxSink below the surface; the soil spring does the rest.
      var g = surface;
      if (params.soilStiffness > 0.0) { g = surface - params.maxSink; }
      // A particle that was pushed into the ground this substep keeps its grip even if a
      // constraint lifts it slightly in a later pass; otherwise it could slide freely.
      if (p.y < g || (pen0 > 0.0 && p.y < surface + params.radius)) {
        let pen = max(0.0, g - p.y);
        p.y = max(p.y, g);
        let slide = vec2f(p.x - before.x, p.z - before.z);
        let sl = length(slide);
        let limit = params.friction * max(pen, pen0);
        if (sl <= limit) { p.x = before.x; p.z = before.z; }
        else { p.x -= slide.x * (limit / sl); p.z -= slide.y * (limit / sl); }
      }
      for (var r = 0u; r < params.rocks; r++) {
        let sphere = rocks[r];
        if (distance(p, sphere.xyz) > sphere.w + params.radius) { continue; }
        var best = -1e9;
        var bestN = vec3f(0.0, 1.0, 0.0);
        for (var f = 0u; f < ${ROCK_FACES}u; f++) {
          let plane = rocks[${MAX_ROCKS}u + r * ${ROCK_FACES}u + f];
          let dist = dot(plane.xyz, p) - plane.w;
          if (dist > best) { best = dist; bestN = plane.xyz; }
        }
        if (best < params.radius) {
          let pen = params.radius - best;
          p += bestN * pen;
          let mv = p - before;
          let tang = mv - bestN * dot(mv, bestN);
          let tl = length(tang);
          let limit = params.friction * max(pen, pen0);
          if (tl <= limit) { p -= tang; } else { p -= tang * (limit / tl); }
        }
      }
      return p;
    }`.$uses({ params: this.params, rocks: this.rocks, getP, nb, restOf, hubPoint, groundHeight });

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
      workgroupBarrier();

      var hubForce = vec3f(0.0);
      var hubTorque = vec3f(0.0);
      for (var s = 0u; s < params.substeps; s++) {
        // Predict: gravity, pressure, bead springs; A -> B, previous positions kept in storage.
        for (var k = lid; k < per; k += ${WG}u) {
          let u = i32(k / params.nv);
          let v = i32(k % params.nv);
          let x = getP(0u, k);
          var vl = vel[base + k].xyz;
          var force = vec3f(0.0, -params.gravity * m, 0.0);
          let du = getP(0u, nb(u + 1, v)) - getP(0u, nb(u - 1, v));
          let dv = getP(0u, nb(u, v + 1)) - getP(0u, nb(u, v - 1));
          force += params.pressure * 0.25 * cross(du, dv) * hubs[t].position.w;
          // Soft ground: soil pushes back in proportion to depth, fully while it is being
          // compressed and only partly as the tread lifts off (so it absorbs energy).
          var soil = 0.0;
          if (params.soilStiffness > 0.0) {
            let depth = groundHeight(x.x, x.z) + params.radius - x.y;
            if (depth > 0.0) {
              soil = params.soilStiffness * depth;
              if (vl.y > 0.0) { soil *= params.soilRebound; }
              force.y += soil;
            }
          }
          vl = (vl + dt * force / m) * max(0.0, 1.0 - params.damping * dt);
          let predicted = x + vl * dt;
          // How hard this substep presses into the ground, as a distance: the normal "impulse"
          // that sets the friction budget for every pass of the substep.
          var pen0 = max(0.0, groundHeight(predicted.x, predicted.z) + params.radius - predicted.y);
          if (params.soilStiffness > 0.0) { pen0 = soil * dt * dt / m; }
          prev[base + k] = vec4f(x, pen0);
          setP(1u, k, predicted);
        }
        workgroupBarrier();
        // Jacobi passes ping-pong B -> A -> B ... The bead is a position constraint to the rim
        // seat; its total correction over the substep gives the force the hub feels.
        let st = dt * f32(s + 1u);
        let h = hubs[t];
        let center = h.position.xyz + h.linvel.xyz * st;
        var src = 1u;
        for (var it = 0u; it < params.iterations; it++) {
          for (var k = lid; k < per; k += ${WG}u) {
            let pr = prev[base + k];
            var p = relax(t, k, src, s, pr.xyz, pr.w);
            let vv = k % params.nv;
            if (vv >= params.beadLow && vv <= params.beadHigh) {
              let corr = params.beadPull * (hubPoint(t, k, st) - p);
              p += corr;
              // Force on the particle is m * corr / dt²; the hub gets the opposite.
              let f = -corr * (m / (dt * dt));
              hubForce += f;
              hubTorque += cross(p - center, f);
            }
            setP(1u - src, k, p);
          }
          workgroupBarrier();
          src = 1u - src;
        }
        // Finish: velocities; the result must end up in A.
        for (var k = lid; k < per; k += ${WG}u) {
          let p = getP(src, k);
          vel[base + k] = vec4f((p - prev[base + k].xyz) / dt, 0.0);
          if (src == 1u) { setP(0u, k, p); }
        }
        workgroupBarrier();
      }

      for (var k = lid; k < per; k += ${WG}u) { pos[base + k] = vec4f(getP(0u, k), 1.0); }
      workgroupBarrier();

      // Sum the bead reactions across the workgroup (reusing set B as scratch).
      let scale = 1.0 / f32(params.substeps);
      setP(1u, lid, hubForce * scale);
      setP(0u, lid, hubTorque * scale);
      workgroupBarrier();
      for (var stride = ${WG / 2}u; stride > 0u; stride = stride / 2u) {
        if (lid < stride) {
          setP(1u, lid, getP(1u, lid) + getP(1u, lid + stride));
          setP(0u, lid, getP(0u, lid) + getP(0u, lid + stride));
        }
        workgroupBarrier();
      }
      if (lid == 0u) {
        hubOut[t * 2u] = vec4f(getP(1u, 0u), 0.0);
        hubOut[t * 2u + 1u] = vec4f(getP(0u, 0u), 0.0);
      }
    }`.$uses({
      params: this.params,
      hubs: this.hubs,
      groundHeight,
      pos: this.pos,
      prev: this.prev,
      vel: this.vel,
      hubOut: this.hubOut,
      getP,
      setP,
      nb,
      hubPoint,
      relax,
    });

    this.pipeline = root.createComputePipeline({ compute: stepTyre });
  }

  // Places every particle on its tyre's moulded shape around the given hubs, at rest.
  reset(hubs) {
    this.writeHubs(hubs);
    const data = new Float32Array(this.count * 4);
    const q = [0, 0, 0, 1];
    for (let t = 0; t < this.tires; t++) {
      const h = hubs[t];
      for (let k = 0; k < this.perTire; k++) {
        const r = [this.restLocal[k * 3], this.restLocal[k * 3 + 1], this.restLocal[k * 3 + 2] * h.mirror];
        const p = rotate(h.rotation ?? q, r);
        data.set([h.position.x + p[0], h.position.y + p[1], h.position.z + p[2], 1], (t * this.perTire + k) * 4);
      }
    }
    this.device.queue.writeBuffer(this.raw.pos, 0, data);
    this.device.queue.writeBuffer(this.root.unwrap(this.prev), 0, data);
    this.device.queue.writeBuffer(this.root.unwrap(this.vel), 0, new Float32Array(this.count * 4));
    this.positions.set(data);
  }

  setParams(settings, dt) {
    const s = settings;
    this.substeps = Math.max(1, Math.round(s.substeps));
    this.iterations = Math.max(1, Math.round(s.iterations));
    this.params.write({
      dt: dt / this.substeps,
      gravity: 9.81,
      pressure: s.pressureKpa * 1000,
      particleMass: s.rubberMass / this.perTire,
      cordStiffness: s.cordStiffness,
      shearStiffness: s.shearStiffness,
      bendStiffness: s.bendStiffness,
      shapeStiffness: s.shapeStiffness,
      beadPull: s.beadPull,
      damping: s.damping,
      friction: s.friction,
      radius: s.contactRadius,
      relaxation: s.relaxation,
      // Soft ground is an explicit soil spring, capped below the stability limit for this substep.
      soilStiffness: s.soilStiffness > 0 ? Math.min(s.soilStiffness, (3.2 * (s.rubberMass / this.perTire)) / ((dt / this.substeps) ** 2)) : 0,
      soilRebound: s.soilRebound ?? 0.35,
      maxSink: s.maxSink ?? 0.25,
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
    });
    this.settings = settings;
    this.dt = dt;
  }

  // Ground heights on a GROUND_N² grid starting at (originX, originZ) with the given spacing.
  setGround(heights, originX, originZ, cell) {
    this.ground.write(heights);
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
    if (this.settings) this.setParams(this.settings, this.dt);
  }

  writeHubs(hubs) {
    const h = this.hubData;
    h.fill(0);
    hubs.forEach((hub, t) => {
      const o = t * 16;
      h.set([hub.position.x, hub.position.y, hub.position.z, hub.mirror], o);
      const q = hub.rotation;
      h.set([q.x, q.y, q.z, q.w], o + 4);
      h.set([hub.linvel.x, hub.linvel.y, hub.linvel.z, 0], o + 8);
      h.set([hub.angvel.x, hub.angvel.y, hub.angvel.z, 0], o + 12);
    });
    this.device.queue.writeBuffer(this.raw.hubs, 0, h);
  }

  // Runs one physics step for all tyres. Resolves with per-hub [fx, fy, fz, _, tx, ty, tz, _].
  // With readPositions, the particle positions are copied back too (for drawing).
  async step(hubs, { readPositions = false } = {}) {
    this.writeHubs(hubs);
    const encoder = this.root['~unstable'].createCommandEncoder();
    const pass = encoder.beginComputePass();
    this.pipeline.with(pass).dispatchWorkgroups(this.tires);
    pass.end();
    const raw = this.root.unwrap(encoder);
    raw.copyBufferToBuffer(this.raw.hubOut, 0, this.hubStaging, 0, MAX_TIRES * 2 * 16);
    if (readPositions) raw.copyBufferToBuffer(this.raw.pos, 0, this.posStaging, 0, this.count * 16);
    encoder.submit();

    await this.hubStaging.mapAsync(GPUMapMode.READ);
    this.hubForces.set(new Float32Array(this.hubStaging.getMappedRange()));
    this.hubStaging.unmap();
    if (readPositions) {
      await this.posStaging.mapAsync(GPUMapMode.READ);
      this.positions.set(new Float32Array(this.posStaging.getMappedRange()));
      this.posStaging.unmap();
    }
    return this.hubForces;
  }

  destroy() {
    this.hubStaging.destroy();
    this.posStaging.destroy();
    for (const b of [this.pos, this.prev, this.vel, this.hubOut, this.rest, this.hubs, this.params, this.ground, this.rocks]) {
      b.destroy?.();
    }
  }
}

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

// Convex rock → bounding sphere and outward face planes for the GPU.
export function rockToGpu(rock) {
  const v = rock.vertices;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const n = v.length / 3;
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
  rock.faces.slice(0, ROCK_FACES).forEach(([a, b, c], f) => {
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
    // Make the normal point away from the rock's centre.
    if (nx * (ax - cx) + ny * (ay - cy) + nz * (az - cz) < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    planes.set([nx, ny, nz, nx * ax + ny * ay + nz * az], f * 4);
  });
  return { sphere: [cx, cy, cz, radius], planes };
}
