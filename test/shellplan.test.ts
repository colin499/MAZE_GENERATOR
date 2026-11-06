import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '@core/generate/pipeline';
import { createTopology } from '@core/topology/registry';
import { buildPlan } from '@core/layout/planner';
import { DEFAULT_PHYSICAL } from '@core/layout/physical';
import { emitFusionChunks, emitFusionScript } from '@core/export/fusion/emit';
import type { TopologySpec } from '@core/model/topology';

const SPECS: TopologySpec[] = [
  { kind: 'cylinder', around: 9, along: 6 },
  { kind: 'cube', n: 4 },
  { kind: 'sphere', n: 4 },
];

describe('shell planners', () => {
  for (const spec of SPECS) for (const side of ['outside', 'inside'] as const) {
    it(`${spec.kind} ${side}: plan has a shell, walls, holes and parses as Python`, () => {
      const { maze } = generate({ topology: spec, seed: 'plan', params: { trapsPerLayer: 2, bridges: 2 } });
      const t = createTopology(maze.topology);
      const phys = { ...DEFAULT_PHYSICAL, shellSide: side };
      const plan = buildPlan(maze, t, phys);
      expect(plan.groups[0]!.name).toBe('Shell');
      const feats = plan.groups.flatMap((g) => g.features);
      const ops = new Set(feats.map((f) => f.op));
      if (spec.kind === 'cylinder') { expect(ops.has('ring')).toBe(true); expect(ops.has('disk')).toBe(side === 'inside'); expect(ops.has('sectors')).toBe(true); expect(ops.has('thin')).toBe(true); }
      if (spec.kind === 'cube') { expect(ops.has('thin')).toBe(true); expect(feats.filter((f) => f.op === 'thin').length).toBeGreaterThanOrEqual(6); }
      if (spec.kind === 'sphere') { expect(ops.has('revolve')).toBe(true); expect(ops.has('sectors')).toBe(true); }
      expect(feats.filter((f) => f.op === 'radialHoles').length).toBe(maze.traps.size + (spec.kind === 'cylinder' && side === 'inside' ? 0 : 1));
      // walls grow away from the shell: on the outside every sector/line radius is >= the surface radius
      if (spec.kind === 'cylinder') {
        const R = phys.tubeDia / 2;
        for (const f of feats) {
          if (f.op === 'sectors') for (const sc of f.sectors) { const r = Math.hypot(sc.outerMid[0], sc.outerMid[1]); expect(side === 'outside' ? r > R : r < R + 1).toBe(true); }
        }
      }
      expect(plan.expected.volumeMm3).toBeGreaterThan(0);
      // every group after the first is marked by a feature name that exists in it
      for (const g of plan.groups.slice(1)) {
        expect(g.marker.startsWith('feature:')).toBe(true);
        expect(g.features.length).toBeLessThanOrEqual(6);
      }
      const dir = mkdtempSync(join(tmpdir(), 'maze-shell-'));
      const file = join(dir, 'plan.py');
      writeFileSync(file, emitFusionScript(plan));
      execFileSync('python3', ['-c', `import ast,sys; ast.parse(open(sys.argv[1]).read())`, file]);
      const chunks = emitFusionChunks(plan);
      expect(chunks.length).toBe(plan.groups.length);
    });
  }

  it('sphere walls group onto a few great-circle planes', () => {
    const { maze } = generate({ topology: { kind: 'sphere', n: 4 }, seed: 'plan', params: { trapsPerLayer: 0, bridges: 0 } });
    const t = createTopology(maze.topology);
    const plan = buildPlan(maze, t, DEFAULT_PHYSICAL);
    const sectors = plan.groups.flatMap((g) => g.features).filter((f) => f.op === 'sectors');
    // 5 grid lines per family × 2 families × 6 faces, opposite faces share planes → at most 30 distinct
    expect(sectors.length).toBeLessThanOrEqual(30);
    expect(sectors.length).toBeGreaterThan(10);
  });
});
