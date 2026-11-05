import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createTopology } from '@core/topology/registry';
import { SIDES, allCells, opposite, cellsOnLayer, isBoundary } from '@core/model/topology';
import type { TopologySpec } from '@core/model/topology';

const specs: TopologySpec[] = [
  { kind: 'flat', w: 2, h: 2 },
  { kind: 'flat', w: 7, h: 3 },
  { kind: 'stacked', w: 4, h: 5, layers: 3 },
];

describe('grid topologies', () => {
  it.each(specs)('cell <-> coordinates round trip %j', (spec) => {
    const t = createTopology(spec);
    for (const c of allCells(t)) {
      const info = t.cell(c);
      expect(t.cellAt(info.panel, info.u, info.v)).toBe(c);
    }
  });

  it.each(specs)('side adjacency is symmetric %j', (spec) => {
    const t = createTopology(spec);
    for (const c of allCells(t)) {
      for (const s of SIDES) {
        const nb = t.side(c, s);
        if (nb !== null) expect(t.side(nb, opposite(s))).toBe(c);
      }
    }
  });

  it('vertical adjacency links layers', () => {
    const t = createTopology({ kind: 'stacked', w: 3, h: 3, layers: 2 });
    for (const c of cellsOnLayer(t, 1)) {
      const b = t.below(c)!;
      expect(t.cell(b).layer).toBe(0);
      expect(t.above(b)).toBe(c);
    }
    for (const c of cellsOnLayer(t, 0)) expect(t.below(c)).toBeNull();
  });

  it('flat start/goal regions are the boundary; stacked are top/bottom layers', () => {
    const f = createTopology({ kind: 'flat', w: 5, h: 5 });
    expect(allCells(f).filter((c) => f.allowedStart(c)).length).toBe(16);
    expect(allCells(f).every((c) => f.allowedStart(c) === isBoundary(f, c))).toBe(true);
    const s = createTopology({ kind: 'stacked', w: 3, h: 3, layers: 4 });
    expect(allCells(s).filter((c) => s.allowedStart(c)).every((c) => s.cell(c).layer === 3)).toBe(true);
    expect(allCells(s).filter((c) => s.allowedGoal(c)).every((c) => s.cell(c).layer === 0)).toBe(true);
  });

  it('random sizes keep counts consistent', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), fc.integer({ min: 2, max: 12 }), fc.integer({ min: 1, max: 5 }), (w, h, layers) => {
        const t = createTopology({ kind: 'stacked', w, h, layers });
        expect(t.cellCount).toBe(w * h * layers);
        expect(t.panels().length).toBe(layers);
        let lateralArcs = 0;
        for (const c of allCells(t)) for (const s of SIDES) if (t.side(c, s) !== null) lateralArcs++;
        expect(lateralArcs).toBe(layers * (2 * ((w - 1) * h + (h - 1) * w)));
      }),
    );
  });
});
