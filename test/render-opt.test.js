import { describe, expect, it } from 'vitest';
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three/webgpu';
import { mergeByMaterial } from '../src/render/merge-geometry.js';
import { TireTracks } from '../src/render/tracks.js';
import { GroundDeformation } from '../src/terrain/deformation.js';

describe('static mesh merging', () => {
  it('merges meshes into one per material with their poses baked in', () => {
    const a = new MeshStandardMaterial();
    const b = new MeshStandardMaterial();
    const root = new Group();
    const inner = new Group();
    inner.position.set(0, 2, 0);
    inner.rotation.z = Math.PI / 2;
    root.add(inner);
    const box = new Mesh(new BoxGeometry(1, 1, 1), a);
    box.position.set(3, 0, 0);
    box.castShadow = true;
    root.add(box);
    const bar = new Mesh(new CylinderGeometry(0.1, 0.1, 2, 8), a);
    inner.add(bar);
    const other = new Mesh(new BoxGeometry(1, 1, 1), b);
    root.add(other);
    mergeByMaterial(root);
    expect(root.children.length).toBe(2);
    const merged = root.children.find((m) => m.material === a);
    expect(merged.castShadow).toBe(true);
    merged.geometry.computeBoundingBox();
    const bb = merged.geometry.boundingBox;
    // The box spans x 2.5..3.5; the bar was turned to lie along x, centred at (0, 2, 0).
    expect(bb.max.x).toBeCloseTo(3.5);
    expect(bb.min.x).toBeCloseTo(-1);
    expect(bb.max.y).toBeCloseTo(2.1);
    // Normals stay unit length and point away from the box centre on its +x face.
    const pos = merged.geometry.getAttribute('position');
    const nor = merged.geometry.getAttribute('normal');
    const p = new Vector3();
    const n = new Vector3();
    for (let i = 0; i < pos.count; i++) {
      n.fromBufferAttribute(nor, i);
      expect(n.length()).toBeCloseTo(1);
      p.fromBufferAttribute(pos, i);
      if (Math.abs(p.x - 3.5) < 1e-6 && n.x > 0.5) expect(n.x).toBeCloseTo(1);
    }
    expect(merged.geometry.index.count).toBe(36 + new CylinderGeometry(0.1, 0.1, 2, 8).index.count);
  });
});

describe('tyre tracks', () => {
  const flat = () => 0;
  const right = { x: 0, z: 1 };

  it('writes and uploads only the new segment and the settling berms', () => {
    const d = new GroundDeformation();
    const tr = new TireTracks({ add() {} }, { wheels: 2, segments: 100, deformation: d });
    for (let i = 0; i < 150; i++) tr.add(0, flat, { x: i * 0.13, z: 0 }, right, 0.3, 0.5);
    tr.update();
    expect(tr.state[0].count).toBe(100);
    expect(tr.heads.array[0]).toBe(149);
    for (const attr of Object.values(tr.attrs)) attr.clearUpdateRanges();
    d.add(19.4, 0.22, 0.05); // a berm beside the newest segment
    tr.add(0, flat, { x: 150 * 0.13, z: 0 }, right, 0.3, 0.5);
    tr.update();
    const { position, berm } = tr.attrs;
    const floats = (a) => a.updateRanges.reduce((s, r) => s + r.count, 0);
    expect(floats(position)).toBe(20 * 3); // one segment of 20 vertices
    expect(floats(berm)).toBe(40 * 20); // the 40 settling segments
    expect(Math.max(...tr.bermHeights)).toBeGreaterThan(0);
    // The newest segment carries the newest sequence number of its wheel.
    const slot = (tr.state[0].head - 1 + 100) % 100;
    expect(tr.seg[slot * 20 * 3 + 1]).toBe(149);
    expect(tr.seg[slot * 20 * 3]).toBe(0);
  });

  it('skips work when nothing changed and resets on clear', () => {
    const tr = new TireTracks({ add() {} }, { wheels: 1, segments: 10 });
    tr.add(0, flat, { x: 0, z: 0 }, right, 0.3, 1);
    tr.add(0, flat, { x: 0.5, z: 0 }, right, 0.3, 1);
    tr.update();
    tr.attrs.berm.clearUpdateRanges();
    tr.update();
    expect(tr.attrs.berm.updateRanges.length).toBe(0);
    tr.clear();
    expect(tr.state[0].count).toBe(0);
    expect(tr.heads.array[0]).toBe(0);
    expect(Math.max(...tr.positions)).toBe(0);
  });
});

describe('instanced moving parts', () => {
  it('draws parts that share shape and material as one instanced mesh that follows them', async () => {
    const { Scene } = await import('three/webgpu');
    const { createInstanceBatcher } = await import('../src/render/instance-batcher.js');
    const scene = new Scene();
    const root = new Group();
    scene.add(root);
    const steel = new MeshStandardMaterial();
    const paint = new MeshStandardMaterial();
    // Four arms built separately with the same parameters, one of another material, one unique.
    const arms = [0, 1, 2, 3].map((i) => {
      const pivot = new Group();
      pivot.position.set(i, 0, 0);
      root.add(pivot);
      const arm = new Mesh(new CylinderGeometry(0.02, 0.02, 1, 8), steel);
      arm.castShadow = true;
      pivot.add(arm);
      return arm;
    });
    const painted = new Mesh(new CylinderGeometry(0.02, 0.02, 1, 8), paint);
    root.add(painted);
    const unique = new Mesh(new BoxGeometry(1, 2, 3), steel);
    root.add(unique);

    const batcher = createInstanceBatcher(root, scene);
    expect(batcher.batches.length).toBe(1);
    const { mesh } = batcher.batches[0];
    expect(mesh.count).toBe(4);
    expect(mesh.castShadow).toBe(true);
    // The originals are no longer drawn; the others are untouched.
    expect(arms.every((a) => !a.layers.test({ mask: 1 }))).toBe(true);
    expect(painted.layers.test({ mask: 1 })).toBe(true);
    expect(unique.layers.test({ mask: 1 })).toBe(true);

    // The instances follow the parts as they move, and a hidden part disappears.
    arms[2].parent.position.y = 5;
    arms[3].visible = false;
    scene.updateMatrixWorld();
    batcher.update();
    const m = new (await import('three/webgpu')).Matrix4();
    mesh.getMatrixAt(2, m);
    expect(m.elements[13]).toBeCloseTo(5);
    mesh.getMatrixAt(3, m);
    expect(m.elements[0]).toBe(0);

    batcher.dispose();
    expect(scene.children.includes(mesh)).toBe(false);
    expect(arms.every((a) => a.layers.test({ mask: 1 }))).toBe(true);
  });
});
