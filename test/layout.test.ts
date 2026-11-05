import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeRuns } from '@core/layout/runs';
import { generate } from '@core/generate/pipeline';
import { createTopology } from '@core/topology/registry';
import { buildPlan } from '@core/layout/planner';
import { DEFAULT_PHYSICAL, validatePhysical } from '@core/layout/physical';
import { emitFusionChunks, emitFusionScript } from '@core/export/fusion/emit';

describe('mergeRuns', () => {
  it('merges touching collinear unit segments and keeps gaps apart', () => {
    const runs = mergeRuns([
      [[0, 0], [1, 0]], [[1, 0], [2, 0]], [[3, 0], [4, 0]],
      [[5, 1], [5, 2]], [[5, 2], [5, 3]],
    ]);
    expect(runs).toEqual([
      { from: [0, 0], to: [2, 0], length: 2 },
      { from: [3, 0], to: [4, 0], length: 1 },
      { from: [5, 1], to: [5, 3], length: 2 },
    ]);
  });
  it('preserves total length', () => {
    const { maze } = generate({ topology: { kind: 'flat', w: 9, h: 7 }, seed: 'runs' });
    const t = createTopology(maze.topology);
    const plan = buildPlan(maze, t, DEFAULT_PHYSICAL);
    const walls = plan.groups[0]!.features.find((f) => f.op === 'thin')!;
    if (walls.op !== 'thin') throw new Error();
    const pitch = DEFAULT_PHYSICAL.chanW + DEFAULT_PHYSICAL.wallT;
    const total = walls.segments.reduce((a, [p, q]) => a + Math.hypot(q[0] - p[0], q[1] - p[1]), 0) / pitch;
    // a perfect maze on w*h cells has exactly (w+1)*h + (h+1)*w - 2*(w*h-1) unit walls... minus passages
    const unitWalls = (9 + 1) * 7 + (7 + 1) * 9 - (9 * 7 - 1);
    expect(Math.round(total)).toBe(unitWalls);
  });
});

describe('grid planner + emitter', () => {
  const { maze } = generate({ topology: { kind: 'stacked', w: 6, h: 5, layers: 3 }, seed: 'plan', params: { bridges: 2 } });
  const t = createTopology(maze.topology);
  const plan = buildPlan(maze, t, DEFAULT_PHYSICAL);

  it('produces one group per layer with floor, walls, holes', () => {
    expect(plan.groups.length).toBe(3);
    for (const g of plan.groups) {
      expect(g.features[0]!.op).toBe('extrude');
      expect(g.features.some((f) => f.op === 'thin')).toBe(true);
    }
    const holes = plan.groups.flatMap((g) => g.features).filter((f) => f.op === 'holes');
    const dropouts = [...maze.edges.values()].filter((e) => e.kind === 'dropout').length;
    const n = holes.reduce((a, f) => a + (f.op === 'holes' ? f.points.length : 0), 0);
    expect(n).toBe(dropouts + maze.traps.size + 1); // + goal exit
    expect(plan.groups.some((g) => g.features.some((f) => f.name.endsWith('bridges')))).toBe(true);
    if (maze.disabled.size) expect(plan.groups.some((g) => g.features.some((f) => f.name.endsWith('shafts')))).toBe(true);
  });

  it('validates physical parameters', () => {
    expect(validatePhysical(DEFAULT_PHYSICAL).filter((i) => i.level === 'error')).toEqual([]);
    expect(validatePhysical({ ...DEFAULT_PHYSICAL, holeDia: 5 }).some((i) => i.level === 'error')).toBe(true);
    expect(validatePhysical({ ...DEFAULT_PHYSICAL, bridgeLift: 20 }).some((i) => i.level === 'error')).toBe(true);
  });

  it('emits syntactically valid Python (standalone and chunks)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maze-py-'));
    const files = [emitFusionScript(plan), ...emitFusionChunks(plan, { mode: 'replace' }).map((c) => c.code)];
    files.forEach((code, i) => writeFileSync(join(dir, `${i}.py`), code));
    const check = execFileSync('python3', ['-I', '-c', 'import ast,sys\nfor f in sys.argv[1:]:\n    ast.parse(open(f).read(), f)\nprint("ok")', ...files.map((_, i) => join(dir, `${i}.py`))]).toString();
    expect(check.trim()).toBe('ok');
    expect(files[1]).toContain('MODE = "replace"');
    expect(files[2]).toContain('MODE = "resume"');
    expect(files[0]).toContain('def run(context)');
  });
});
