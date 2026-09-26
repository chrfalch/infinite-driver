import { describe, expect, it } from 'vitest';
import { ifsCorner } from '../src/vehicle/frame-geometry.js';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const crs = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a) => Math.hypot(a.x, a.y, a.z);
const nrm = (a) => mul(a, 1 / len(a));
const mid = ([a, b]) => mul(add(a, b), 0.5);
function rotAbout(p, o, a, t) {
  const v = sub(p, o);
  return add(o, add(add(mul(v, Math.cos(t)), mul(crs(a, v), Math.sin(t))), mul(a, dot(a, v) * (1 - Math.cos(t)))));
}
function bisect(f, lo, hi) {
  for (let k = 0; k < 60; k++) {
    const m = (lo + hi) / 2;
    if (f(lo) * f(m) <= 0) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}

// Wheel pose of the right-front corner when the lower arm turns by `th` (kinematics only).
function pose(G, th) {
  const X = { x: 1, y: 0, z: 0 };
  const lo = mid(G.lowerInner);
  const uo = mid(G.upperInner);
  const LBJ = rotAbout(G.lowerBall, lo, X, th);
  const dBJ = len(sub(G.upperBall, G.lowerBall));
  const ph = bisect((p) => len(sub(rotAbout(G.upperBall, uo, X, p), LBJ)) - dBJ, th - 0.6, th + 0.6);
  const UBJ = rotAbout(G.upperBall, uo, X, ph);
  const u0 = nrm(sub(G.upperBall, G.lowerBall));
  const u1 = nrm(sub(UBJ, LBJ));
  const ax = crs(u0, u1);
  const s = len(ax);
  const base = (p) => (s < 1e-9 ? add(LBJ, sub(p, G.lowerBall)) : add(LBJ, rotAbout(sub(p, G.lowerBall), { x: 0, y: 0, z: 0 }, nrm(ax), Math.asin(Math.min(1, s)))));
  const place = (p, psi) => rotAbout(base(p), LBJ, u1, psi);
  const Ltie = len(sub(G.tieOuter, G.tieInner));
  const psi = bisect((q) => len(sub(place(G.tieOuter, q), G.tieInner)) - Ltie, -0.2, 0.2);
  const W = place(G.wheel, psi);
  const axle = sub(place(add(G.wheel, { x: 0, y: 0, z: 1 }), psi), W);
  return { travel: W.y - G.wheel.y, toe: (Math.atan2(axle.x, axle.z) * 180) / Math.PI, camber: (Math.atan2(-axle.y, axle.z) * 180) / Math.PI };
}

describe('double A-arm geometry', () => {
  const G = ifsCorner(1);
  it('has a short upper arm (0.65–0.75 of the lower), 8° kingpin and ~6° caster', () => {
    const lower = len(sub(mid(G.lowerInner), G.lowerBall));
    const upper = len(sub(mid(G.upperInner), G.upperBall));
    expect(upper / lower).toBeGreaterThan(0.65);
    expect(upper / lower).toBeLessThan(0.75);
    const kpi = (Math.atan2(G.lowerBall.z - G.upperBall.z, G.upperBall.y - G.lowerBall.y) * 180) / Math.PI;
    const caster = (Math.atan2(G.lowerBall.x - G.upperBall.x, G.upperBall.y - G.lowerBall.y) * 180) / Math.PI;
    expect(kpi).toBeCloseTo(8, 0);
    expect(caster).toBeGreaterThan(4);
    expect(caster).toBeLessThan(8);
  });
  it('puts the roll centre 0.15–0.35 m above the ground', () => {
    const line = (a, b) => ({ a, m: (b.y - a.y) / (b.z - a.z) });
    const L = line(mid(G.lowerInner), G.lowerBall);
    const U = line(mid(G.upperInner), G.upperBall);
    const z = (U.a.y - L.a.y + L.m * L.a.z - U.m * U.a.z) / (L.m - U.m);
    const ic = { z, y: L.a.y + L.m * (z - L.a.z) };
    const ground = -0.89;
    const contact = { z: G.wheel.z, y: ground };
    const rc = contact.y + ((0 - contact.z) / (ic.z - contact.z)) * (ic.y - contact.y) - ground;
    expect(rc).toBeGreaterThan(0.15);
    expect(rc).toBeLessThan(0.35);
  });
  it('gains negative camber in bump with under 0.5° of bump steer over ±0.15 m', () => {
    const rows = [];
    for (let th = -0.34; th <= 0.34; th += 0.02) rows.push(pose(G, th));
    const bump = rows.filter((r) => r.travel > 0.1);
    expect(Math.min(...bump.map((r) => r.camber))).toBeLessThan(-1);
    const inRange = rows.filter((r) => Math.abs(r.travel) <= 0.15);
    expect(Math.max(...inRange.map((r) => Math.abs(r.toe)))).toBeLessThan(0.5);
  });
});
