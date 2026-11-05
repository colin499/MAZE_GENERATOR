import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { generate, regenerate } from '@core/generate/pipeline';
import { createTopology } from '@core/topology/registry';
import { solve } from '@core/graph/solve';
import { validate, hasErrors } from '@core/model/validate';
import { allCells, cellsOnLayer } from '@core/model/topology';
import { graphOf } from '@core/graph/index';
import { encodeMaze } from '@core/serialize/codec';
import { withLocked } from '@core/model/ops';
import { edgeKey } from '@core/model/ids';
import { scoreMaze } from '@core/difficulty/score';

const stackedArb = fc.record({
  w: fc.integer({ min: 2, max: 9 }),
  h: fc.integer({ min: 2, max: 9 }),
  layers: fc.integer({ min: 1, max: 4 }),
  seed: fc.string({ minLength: 1, maxLength: 6 }),
});

describe('generate', () => {
  it('is deterministic', () => {
    const o = { topology: { kind: 'stacked', w: 8, h: 8, layers: 3 } as const, seed: 'abc' };
    expect(encodeMaze(generate(o).maze)).toEqual(encodeMaze(generate(o).maze));
    expect(encodeMaze(generate(o).maze)).not.toEqual(encodeMaze(generate({ ...o, seed: 'abd' }).maze));
  });

  it('changing the bridge count does not change the tree', () => {
    const base = { topology: { kind: 'stacked', w: 8, h: 8, layers: 3 } as const, seed: 'fork' };
    const a = generate({ ...base, params: { bridges: 0 } }).maze;
    const b = generate({ ...base, params: { bridges: 3 } }).maze;
    const lateral = (m: typeof a) => [...m.edges.values()].filter((e) => e.kind !== 'dropout').map((e) => edgeKey(e.a, e.b)).sort();
    expect(lateral(a)).toEqual(lateral(b));
    expect([...b.traps].sort()).toEqual([...a.traps].sort());
  });

  it('produces solvable, live, perfect-per-layer mazes for random sizes', () => {
    fc.assert(
      fc.property(stackedArb, ({ w, h, layers, seed }) => {
        const topology = { kind: 'stacked', w, h, layers } as const;
        const t = createTopology(topology);
        const { maze, diagnostics } = generate({ topology, seed });
        expect(hasErrors(diagnostics), JSON.stringify(diagnostics)).toBe(false);
        const s = solve(maze, t);
        expect(s.solvable).toBe(true);
        expect(s.stuckCells).toEqual([]);
        expect(s.unreachableCells.filter((c) => !maze.disabled.has(c))).toEqual([]);
        // each layer's lateral passages form a spanning tree over its playable cells
        for (let L = 0; L < layers; L++) {
          const cells = new Set(cellsOnLayer(t, L).filter((c) => !maze.disabled.has(c)));
          const lateralEdges = [...maze.edges.values()].filter((e) => cells.has(e.a) && cells.has(e.b));
          expect(lateralEdges.length).toBe(cells.size - 1);
        }
        // every shaft cell sits under a trap, carries no passages, and traps are never on the solution path
        const path = new Set(solve(maze, t).path);
        for (const c of maze.traps) expect(path.has(c)).toBe(false);
        for (const c of maze.disabled) {
          let above = t.above(c); let found = false;
          while (above !== null) { if (maze.traps.has(above)) found = true; above = t.above(above); }
          expect(found).toBe(true);
          expect([...maze.edges.values()].some((e) => e.a === c || e.b === c)).toBe(false);
        }
        // one true dropout per layer boundary at least, each from the upper cell
        const drops = [...maze.edges.values()].filter((e) => e.kind === 'dropout');
        expect(drops.length).toBeGreaterThanOrEqual(layers - 1);
        for (const d of drops) expect(t.cell(d.from!).layer).toBe(t.cell(d.from === d.a ? d.b : d.a).layer + 1);
        if (layers > 1) {
          expect(t.cell(maze.start).layer).toBe(layers - 1);
          expect(t.cell(maze.goal).layer).toBe(0);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('flat mazes put start and goal on the boundary', () => {
    const topology = { kind: 'flat', w: 10, h: 6 } as const;
    const t = createTopology(topology);
    const { maze } = generate({ topology, seed: 'edge' });
    expect(t.allowedStart(maze.start)).toBe(true);
    expect(t.allowedGoal(maze.goal)).toBe(true);
    expect(validate(maze, t).filter((d) => d.level === 'error')).toEqual([]);
  });

  it('places traps near the route that send the ball back to the start', () => {
    const topology = { kind: 'stacked', w: 9, h: 9, layers: 4 } as const;
    const t = createTopology(topology);
    const m = generate({ topology, seed: 'd', params: { trapsPerLayer: 2 } }).maze;
    expect(m.traps.size).toBeGreaterThanOrEqual(4);
    const g = graphOf(m, t.cellCount);
    for (const c of m.traps) expect(g.out[c]).toContain(m.start);
    const s = solve(m, t);
    expect(s.stuckCells).toEqual([]);
    for (const c of m.traps) expect(s.distFromStart[c]).toBeGreaterThan(0);
  });

  it('bridges keep connectivity and mark tunnels on the path', () => {
    const topology = { kind: 'flat', w: 12, h: 12 } as const;
    const t = createTopology(topology);
    const { maze } = generate({ topology, seed: 'b', params: { bridges: 3 } });
    const tunnels = [...maze.edges.values()].filter((e) => e.kind === 'tunnel');
    expect(tunnels.length).toBe(3);
    const path = new Set(solve(maze, t).path);
    for (const e of tunnels) { expect(path.has(e.a)).toBe(true); expect(path.has(e.b)).toBe(true); }
  });

  it('braiding adds loops without shortening the solution', () => {
    const topology = { kind: 'flat', w: 12, h: 12 } as const;
    const t = createTopology(topology);
    const a = generate({ topology, seed: 'br' }).maze;
    const b = generate({ topology, seed: 'br', params: { braid: 0.5 } }).maze;
    expect(b.edges.size).toBeGreaterThan(a.edges.size);
    expect(solve(b, t).length).toBeGreaterThanOrEqual(solve(a, t).length);
    expect(validate(b, t).filter((d) => d.level === 'error')).toEqual([]);
  });

  it('regenerate keeps the locked interior and stays connected', () => {
    const topology = { kind: 'stacked', w: 10, h: 10, layers: 2 } as const;
    const t = createTopology(topology);
    const first = generate({ topology, seed: 'one' }).maze;
    // lock a 4x4 block on the top layer
    const block = allCells(t).filter((c) => { const i = t.cell(c); return i.layer === 1 && i.u >= 2 && i.u < 6 && i.v >= 2 && i.v < 6; });
    const locked = withLocked(first, block, true);
    const { maze: second, diagnostics } = regenerate(locked, 'two');
    expect(hasErrors(diagnostics), JSON.stringify(diagnostics)).toBe(false);
    const blockSet = new Set(block);
    const interior = (m: typeof first) => [...m.edges.values()].filter((e) => blockSet.has(e.a) && blockSet.has(e.b)).map((e) => edgeKey(e.a, e.b)).sort();
    expect(interior(second)).toEqual(interior(first));
    expect(solve(second, t).solvable).toBe(true);
    expect(solve(second, t).unreachableCells.filter((c) => !second.disabled.has(c))).toEqual([]);
    for (const c of first.traps) if (blockSet.has(c)) expect(second.traps.has(c)).toBe(true);
    const g = graphOf(second, t.cellCount);
    expect(g.out.length).toBe(t.cellCount);
  });

  it('scores a maze between 0 and 100 and harder params score higher on average', () => {
    const topology = { kind: 'stacked', w: 10, h: 10, layers: 3 } as const;
    const t = createTopology(topology);
    const easy = scoreMaze(generate({ topology, seed: 's', params: { newestBias: 0.0, trapsPerLayer: 0 } }).maze, t);
    const hard = scoreMaze(generate({ topology, seed: 's', params: { newestBias: 1.0, trapsPerLayer: 3 } }).maze, t);
    expect(easy.score).toBeGreaterThanOrEqual(0);
    expect(hard.score).toBeLessThanOrEqual(100);
    expect(hard.score).toBeGreaterThan(easy.score);
    expect(hard.metrics.solutionLength).toBeGreaterThan(0);
    expect(hard.explorer.failures).toBe(0);
  });
});
