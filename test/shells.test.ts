import { describe, expect, it } from 'vitest';
import { createTopology } from '@core/topology/registry';
import { SIDES, SIDE_DELTA, allCells, opposite } from '@core/model/topology';
import type { TopologySpec } from '@core/model/topology';
import { generate } from '@core/generate/pipeline';
import { validate } from '@core/model/validate';
import { solve } from '@core/graph/solve';
import { DEFAULT_PHYSICAL, shellChannel, validatePhysical } from '@core/layout/physical';
import type { CellId } from '@core/model/ids';

const SPECS: TopologySpec[] = [
  { kind: 'cylinder', around: 9, along: 6 },
  { kind: 'cube', n: 4 },
  { kind: 'sphere', n: 5 },
];

describe('shell topologies', () => {
  for (const spec of SPECS) {
    const t = createTopology(spec);
    it(`${spec.kind}: adjacency is symmetric and sides are distinct`, () => {
      for (const c of allCells(t)) {
        const seen = new Set<CellId>();
        for (const s of SIDES) {
          const nb = t.side(c, s);
          if (nb === null) continue;
          expect(seen.has(nb), `cell ${c} reaches ${nb} twice`).toBe(false);
          seen.add(nb);
          expect(SIDES.some((s2) => t.side(nb, s2) === c), `${c}→${nb} not symmetric`).toBe(true);
        }
      }
    });
    it(`${spec.kind}: every cell has the expected number of neighbours`, () => {
      for (const c of allCells(t)) {
        const deg = SIDES.filter((s) => t.side(c, s) !== null).length;
        if (spec.kind === 'cylinder') {
          const v = t.cell(c).v;
          expect(deg).toBe(v === 0 || v === spec.along - 1 ? 3 : 4);
        } else expect(deg).toBe(4);
      }
    });
    it(`${spec.kind}: crossing a panel edge lands in the cell adjacency says`, () => {
      for (const c of allCells(t)) {
        const i = t.cell(c);
        for (const s of SIDES) {
          const d = SIDE_DELTA[s]!;
          const u = i.u + 0.5 + d[0] * 0.75, v = i.v + 0.5 + d[1] * 0.75;
          const x = t.crossPanel(i.panel, u, v);
          if (!x) continue;
          const landed = t.cellAt(x.panel, Math.floor(x.u), Math.floor(x.v));
          expect(landed).toBe(t.side(c, s));
          // the direction map is a rotation: the outgoing side maps onto the entering side's opposite
          const du = x.m[0] * d[0] + x.m[1] * d[1], dv = x.m[2] * d[0] + x.m[3] * d[1];
          const back = SIDES.find((s2) => t.side(landed!, s2) === c)!;
          const od = SIDE_DELTA[opposite(back)]!;
          expect([du + 0, dv + 0]).toEqual([od[0], od[1]]);
        }
      }
    });
    it(`${spec.kind}: generates a solvable maze with traps and the ball can reach every cell`, () => {
      const { maze, diagnostics } = generate({ topology: spec, seed: 'shell', params: { trapsPerLayer: 2, bridges: 2 } });
      expect(diagnostics.filter((d) => d.level === 'error')).toEqual([]);
      const s = solve(maze, t);
      expect(s.solvable).toBe(true);
      expect(s.length).toBeGreaterThan(t.cellCount / 6);
      expect(validate(maze, t).filter((d) => d.level === 'error')).toEqual([]);
      expect([...maze.edges.values()].some((e) => e.kind === 'dropout')).toBe(false);
      if (spec.kind === 'cylinder') {
        expect(t.cell(maze.start).v).toBe(0);
        expect(t.cell(maze.goal).v).toBe(spec.along - 1);
      }
    });
  }

  it('cylinder surface: circumference at the floor equals 2πR and cells wrap', () => {
    const t = createTopology({ kind: 'cylinder', around: 9, along: 6 });
    const s = t.surface(DEFAULT_PHYSICAL);
    const [pu] = s.metric(0, 2.5, 1, 0);
    expect(pu * 9).toBeCloseTo(Math.PI * DEFAULT_PHYSICAL.tubeDia, 3);
    const a = s.point(0, 0, 1, 0), b = s.point(0, 9, 1, 0);
    expect(a[0]).toBeCloseTo(b[0], 6);
    expect(a[1]).toBeCloseTo(b[1], 6);
    expect(s.frame(0, 2, 2).n[2]).toBeCloseTo(0, 6); // normal is radial
  });

  it('cube/sphere net: faces attached in the cross share their edge midpoints', () => {
    for (const kind of ['cube', 'sphere'] as const) {
      const t = createTopology({ kind, n: 4 });
      const net = t.surface(DEFAULT_PHYSICAL, true);
      let shared = 0;
      for (const c of allCells(t)) {
        const i = t.cell(c);
        for (const s of SIDES) {
          const nb = t.side(c, s)!;
          const j = t.cell(nb);
          // only the edges that are glued in the cross: centre face +Z to its four neighbours, and +X to −Z
          const glued = i.panel === 0 || (i.panel === 2 && j.panel === 1);
          if (j.panel === i.panel || !glued) continue;
          const d = SIDE_DELTA[s]!;
          const p = net.point(i.panel, i.u + 0.5 + d[0] * 0.5, i.v + 0.5 + d[1] * 0.5, 0);
          const back = SIDES.find((s2) => t.side(nb, s2) === c)!;
          const e = SIDE_DELTA[back]!;
          const q = net.point(j.panel, j.u + 0.5 + e[0] * 0.5, j.v + 0.5 + e[1] * 0.5, 0);
          expect(Math.hypot(p[0] - q[0], p[1] - q[1]), `${kind} net edge ${c}-${nb}`).toBeLessThan(1e-6);
          shared++;
        }
      }
      expect(shared).toBeGreaterThan(0);
    }
  });

  it('sphere surface points lie on the sphere and the cube ones on the cube, on either side', () => {
    for (const side of ['outside', 'inside'] as const) {
      const phys = { ...DEFAULT_PHYSICAL, shellSide: side };
      const sgn = side === 'inside' ? -1 : 1;
      const sph = createTopology({ kind: 'sphere', n: 5 }).surface(phys);
      const R = phys.sphereDia / 2;
      for (const [p, u, v] of [[0, 0.3, 4.9], [3, 2.5, 2.5], [5, 0, 0]] as const) {
        const q = sph.point(p, u, v, 3);
        expect(Math.hypot(q[0], q[1], q[2])).toBeCloseTo(R + sgn * 3, 6);
      }
      expect(sph.cutaway).toBe(side === 'inside');
      const cube = createTopology({ kind: 'cube', n: 5 }).surface(phys);
      const q = cube.point(2, 1, 4, 2);
      expect(q[0]).toBeCloseTo(phys.cubeSide / 2 + sgn * 2, 6);
      // the frame normal always points away from the shell material, toward the ball
      const f = cube.frame(2, 1, 4);
      expect(f.n[0]).toBeCloseTo(sgn, 6);
    }
  });

  it('physical validation flags channels too narrow for the ball', () => {
    expect(shellChannel(DEFAULT_PHYSICAL, { kind: 'cylinder', around: 9, along: 6 })!.min).toBeGreaterThan(DEFAULT_PHYSICAL.ballDia);
    const bad = validatePhysical(DEFAULT_PHYSICAL, { kind: 'cylinder', around: 16, along: 6 });
    expect(bad.some((i) => i.level === 'error')).toBe(true);
  });
});
