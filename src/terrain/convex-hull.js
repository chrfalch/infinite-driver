// Small incremental 3D convex hull for rock collision shapes (tens of points).
// Returns outward-facing triangles as index triples into the point list.
export function convexHull(points) {
  const n = points.length / 3;
  const P = (i) => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const eps = 1e-9;

  // Initial tetrahedron from extreme, non-degenerate points.
  let i0 = 0;
  for (let i = 1; i < n; i++) if (P(i)[0] < P(i0)[0]) i0 = i;
  let i1 = 0;
  let best = -1;
  for (let i = 0; i < n; i++) {
    const d = dot(sub(P(i), P(i0)), sub(P(i), P(i0)));
    if (d > best) [best, i1] = [d, i];
  }
  let i2 = 0;
  best = -1;
  for (let i = 0; i < n; i++) {
    const c = cross(sub(P(i1), P(i0)), sub(P(i), P(i0)));
    const d = dot(c, c);
    if (d > best) [best, i2] = [d, i];
  }
  let i3 = 0;
  best = -1;
  const nrm = cross(sub(P(i1), P(i0)), sub(P(i2), P(i0)));
  for (let i = 0; i < n; i++) {
    const d = Math.abs(dot(nrm, sub(P(i), P(i0))));
    if (d > best) [best, i3] = [d, i];
  }
  if (best < eps) return [];

  const faces = [];
  const addFace = (a, b, c) => {
    const normal = cross(sub(P(b), P(a)), sub(P(c), P(a)));
    faces.push({ v: [a, b, c], normal, offset: dot(normal, P(a)), alive: true });
  };
  const centroid = [0, 1, 2].map((k) => (P(i0)[k] + P(i1)[k] + P(i2)[k] + P(i3)[k]) / 4);
  for (const [a, b, c] of [
    [i0, i1, i2],
    [i0, i1, i3],
    [i0, i2, i3],
    [i1, i2, i3],
  ]) {
    // Orient each face away from the tetrahedron's centre.
    const normal = cross(sub(P(b), P(a)), sub(P(c), P(a)));
    if (dot(normal, sub(centroid, P(a))) > 0) addFace(a, c, b);
    else addFace(a, b, c);
  }

  const used = new Set([i0, i1, i2, i3]);
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    const p = P(i);
    const visible = faces.filter((f) => f.alive && dot(f.normal, p) - f.offset > eps * Math.hypot(...f.normal));
    if (visible.length === 0) continue; // inside
    // Horizon: edges of visible faces not shared with another visible face.
    const edges = new Map();
    for (const f of visible) {
      f.alive = false;
      for (let k = 0; k < 3; k++) {
        const a = f.v[k];
        const b = f.v[(k + 1) % 3];
        const back = `${b},${a}`;
        if (edges.has(back)) edges.delete(back);
        else edges.set(`${a},${b}`, [a, b]);
      }
    }
    for (const [a, b] of edges.values()) addFace(a, b, i);
  }
  return faces.filter((f) => f.alive).map((f) => f.v);
}
