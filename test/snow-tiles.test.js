import { describe, expect, it } from 'vitest';
import { createHeightField } from '../src/terrain/height.js';
import { SNOW_FIELDS, SnowTiles, sampleSnowTile } from '../src/terrain/snow-tiles.js';

const CELL = 0.125;

describe('snow tiles', () => {
  const heightAt = createHeightField({ mode: 'snow' });

  it('samples each cell as the snowfield has it', () => {
    const out = new Float32Array(SNOW_FIELDS);
    const tiles = new SnowTiles(heightAt, CELL);
    for (const [ix, iz] of [[0, 0], [-37, 400], [523, -129], [440, 512]]) {
      const x = ix * CELL;
      const z = iz * CELL;
      tiles.cell(ix, iz, out);
      const s = heightAt.snowAt(x, z);
      expect(out[0]).toBeCloseTo(heightAt(x, z), 4);
      expect(out[1]).toBeCloseTo(s.firm, 5);
      expect(out[2]).toBeCloseTo(s.packDepth, 5);
      expect(out[3]).toBeCloseTo(heightAt.roadSide(x, z), 4);
      expect(out[4]).toBeCloseTo(s.lake, 3);
    }
  });

  it('reads a received tile the same as sampling, and asks for tiles once', () => {
    const asked = [];
    const tiles = new SnowTiles(heightAt, CELL);
    tiles.request = (tx, tz) => asked.push(`${tx},${tz}`);
    tiles.want(-10, -10, 10, 10);
    tiles.want(-10, -10, 10, 10);
    expect(asked).toContain('-1,-1');
    expect(asked).toContain('0,0');
    expect(new Set(asked).size).toBe(asked.length);
    tiles.receive(-1, 0, sampleSnowTile(heightAt, -1, 0, CELL));
    const fromTile = new Float32Array(SNOW_FIELDS);
    const sampled = new Float32Array(SNOW_FIELDS);
    for (const [ix, iz] of [[-1, 0], [-128, 127], [-60, 33]]) {
      tiles.cell(ix, iz, fromTile);
      new SnowTiles(heightAt, CELL).cell(ix, iz, sampled);
      expect([...fromTile]).toEqual([...sampled]);
    }
  });

  it('lets go of tiles far from the area asked for', () => {
    const tiles = new SnowTiles(heightAt, CELL);
    tiles.request = () => {};
    tiles.receive(0, 0, new Float32Array(128 * 128 * SNOW_FIELDS));
    tiles.want(5000, 5000, 5100, 5100);
    expect(tiles.tiles.has('0,0')).toBe(false);
  });
});
