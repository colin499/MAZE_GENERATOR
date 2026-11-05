import { describe, expect, it } from 'vitest';
import { generate } from '@core/generate/pipeline';
import { decodeMaze, encodeMaze, mazeFromJson, mazeToJson } from '@core/serialize/codec';

describe('codec', () => {
  it('round-trips a generated maze', () => {
    const { maze } = generate({ topology: { kind: 'stacked', w: 6, h: 5, layers: 3 }, seed: 'rt', params: { bridges: 2 } });
    const back = mazeFromJson(mazeToJson(maze));
    expect(encodeMaze(back)).toEqual(encodeMaze(maze));
    expect(back.edges.size).toBe(maze.edges.size);
    expect([...back.edges.values()].find((e) => e.kind === 'dropout')?.from).toBeDefined();
  });
  it('rejects malformed input', () => {
    expect(() => decodeMaze({})).toThrow();
    expect(() => decodeMaze({ formatVersion: 1, topology: { kind: 'nope' }, edges: [] })).toThrow();
    expect(() => decodeMaze({ formatVersion: 1, topology: { kind: 'flat', w: 3, h: 3 }, start: 0, goal: 8, edges: [[0, 1, 'weird']] })).toThrow();
  });
});
