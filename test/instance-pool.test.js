import { describe, expect, it } from 'vitest';
import { BoxGeometry, Color, Group, MeshStandardMaterial } from 'three/webgpu';
import { releaseInstancedMesh, takeInstancedMesh, warmInstancedMeshes } from '../src/render/instance-pool.js';

describe('instance pool', () => {
  const geometry = new BoxGeometry();
  const material = new MeshStandardMaterial();

  it('hands a released mesh to the next chunk, white and at the origin', () => {
    const a = takeInstancedMesh(geometry, material, 20);
    expect(a.instanceMatrix.count).toBe(32);
    a.setColorAt(3, new Color(1, 0, 0));
    a.position.set(5, 0, 5);
    const chunk = new Group();
    chunk.add(a);
    releaseInstancedMesh(a);
    expect(a.parent).toBe(null);
    const b = takeInstancedMesh(geometry, material, 12);
    expect(b).toBe(a);
    expect(b.count).toBe(12);
    expect(b.position.x).toBe(0);
    expect(b.instanceColor.getX(3)).toBe(1);
    expect(b.instanceColor.getY(3)).toBe(1);
  });

  it('takes the smallest kept mesh with room, or makes one', () => {
    const big = takeInstancedMesh(geometry, material, 100);
    const small = takeInstancedMesh(geometry, material, 10);
    releaseInstancedMesh(big);
    releaseInstancedMesh(small);
    expect(takeInstancedMesh(geometry, material, 9)).toBe(small);
    expect(takeInstancedMesh(geometry, material, 60)).toBe(big);
    const other = takeInstancedMesh(geometry, material, 300);
    expect(other).not.toBe(big);
    expect(other.instanceMatrix.count).toBe(512);
  });

  it('draws a new mesh unculled for its first frames', () => {
    const mesh = takeInstancedMesh(new BoxGeometry(), material, 5);
    expect(mesh.frustumCulled).toBe(false);
    warmInstancedMeshes();
    expect(mesh.frustumCulled).toBe(false);
    warmInstancedMeshes();
    expect(mesh.frustumCulled).toBe(true);
  });
});
