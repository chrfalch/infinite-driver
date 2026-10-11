import { readFileSync } from 'node:fs';
import { Vector2 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { beltPath, beltPoint, createBelt, solveLinkage, throttleTravel } from '../src/render/dragster-engine.js';

// The exported model's nodes (pivots as translations, the rest in extras).
function modelNodes() {
  const glb = readFileSync(new URL('../public/models/dragster-engine.glb', import.meta.url));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
  return Object.fromEntries(json.nodes.map((n) => [n.name, { position: n.translation ?? [0, 0, 0], extras: n.extras ?? {} }]));
}
const nodes = modelNodes();
const circles = ['crank', 'idler', 'blower'].map((name) => ({ c: new Vector2(nodes[name].position[1], nodes[name].position[2]), r: nodes[name].extras.radius }));
const xy = (a) => new Vector2(a[0], a[1]);
const geo = {
  shaft: xy(nodes.throttle.position),
  top: xy(nodes.rod.position),
  bottom: xy(nodes.rod.extras.bottom),
  pivot: xy(nodes.valveArm.position),
};
const springEnds = { fixed: xy(nodes.spring.position), moving: xy(nodes.spring.extras.moving) };

describe('dragster engine model', () => {
  it('has every moving part with its data', () => {
    for (const name of ['static', 'crank', 'idler', 'blower', 'throttle', 'rod', 'valveArm', 'spring']) expect(nodes[name]).toBeDefined();
    for (const c of circles) expect(c.r).toBeGreaterThan(0.03);
    expect(nodes.static.extras.belt.width).toBeGreaterThan(0.02);
    // The crank pulley is the engine's origin.
    expect(nodes.crank.position).toEqual([0, 0, 0]);
  });
});

describe('blower belt', () => {
  const path = beltPath(circles);
  const p = new Vector2();
  const n = new Vector2();

  it('is a closed loop with no jumps', () => {
    const steps = 2000;
    const ds = path.length / steps;
    const prev = beltPoint(path, 0, new Vector2(), new Vector2()).clone();
    for (let i = 1; i <= steps; i++) {
      beltPoint(path, i * ds, p, n);
      expect(p.distanceTo(prev)).toBeLessThan(ds * 1.01);
      prev.copy(p);
    }
    expect(beltPoint(path, path.length, p, n).distanceTo(beltPoint(path, 0, new Vector2(), new Vector2()))).toBeLessThan(1e-9);
  });

  it('wraps every pulley from outside without cutting through one', () => {
    for (let i = 0; i < 1000; i++) {
      beltPoint(path, (i / 1000) * path.length, p, n);
      for (const { c, r } of circles) expect(p.distanceTo(c)).toBeGreaterThan(r - 1e-6);
    }
    // Each pulley carries part of the belt on its rim.
    const arcs = path.segments.filter((s) => !s.line);
    expect(arcs).toHaveLength(3);
    for (const arc of arcs) expect(arc.length).toBeGreaterThan(0.02);
  });

  it('runs counterclockwise in (y, z), the way the pulleys turn with a rising rotation.x', () => {
    // Shoelace area of the run is positive for a counterclockwise loop.
    let area = 0;
    const q = new Vector2();
    for (let i = 0; i < 500; i++) {
      beltPoint(path, (i / 500) * path.length, p, n);
      beltPoint(path, ((i + 1) / 500) * path.length, q, n);
      area += p.x * q.y - q.x * p.y;
    }
    expect(area).toBeGreaterThan(0);
  });

  it('builds a whole number of teeth and moves them along the path', () => {
    const belt = createBelt(circles, 0, 0.045);
    expect(belt.teeth).toBeGreaterThan(50);
    const pos = belt.mesh.geometry.attributes.position;
    const before = pos.array.slice();
    belt.update(0.004);
    expect(pos.array.some((v, i) => Math.abs(v - before[i]) > 1e-4)).toBe(true);
    // A whole loop later every vertex is back.
    belt.update(path.length);
    for (let i = 0; i < before.length; i++) expect(pos.array[i]).toBeCloseTo(before[i], 5);
  });
});

describe('throttle linkage', () => {
  const rod = geo.top.distanceTo(geo.bottom);
  const travel = throttleTravel(geo, springEnds);
  const rot = (v, a, c) => v.clone().sub(c).rotateAround(new Vector2(), a).add(c);

  it('opens far enough to see, toward stretching the return spring', () => {
    expect(Math.abs(travel)).toBeGreaterThan((12 * Math.PI) / 180);
    const stretch = (a) => rot(springEnds.moving, a, geo.shaft).distanceTo(springEnds.fixed);
    expect(stretch(travel)).toBeGreaterThan(stretch(0));
  });

  it('keeps the rod its length over the whole travel', () => {
    let near = 0;
    for (let i = 0; i <= 40; i++) {
      const a = (travel * i) / 40;
      const phi = solveLinkage(geo, a, near);
      expect(phi).not.toBeNull();
      // The valve arm swings smoothly, with no jump to the other solution.
      expect(Math.abs(phi - near)).toBeLessThan(0.2);
      near = phi;
      const T = rot(geo.top, a, geo.shaft);
      const B = rot(geo.bottom, phi, geo.pivot);
      expect(T.distanceTo(B)).toBeCloseTo(rod, 6);
    }
    expect(solveLinkage(geo, 0, 0)).toBeCloseTo(0, 6);
  });
});
