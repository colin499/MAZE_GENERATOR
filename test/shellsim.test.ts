import { describe, expect, it } from 'vitest';
import { generate } from '@core/generate/pipeline';
import { createTopology } from '@core/topology/registry';
import { DEFAULT_PHYSICAL } from '@core/layout/physical';
import { edgeKey } from '@core/model/ids';
import type { TopologySpec } from '@core/model/topology';
import { ShellController, ShellSim } from '@core/sim/shell';
import { ShellAutopilot } from '@core/sim/autopilot';
import { solve } from '@core/graph/solve';
import type { CellId } from '@core/model/ids';

const H = 1 / 240;
const SPECS: [string, TopologySpec][] = [
  ['cyl', { kind: 'cylinder', around: 9, along: 6 }],
  ['cube', { kind: 'cube', n: 4 }],
  ['sph', { kind: 'sphere', n: 4 }],
];

describe('shell simulation', () => {
  it('starts level: the ball stays put with no input', () => {
    const { maze } = generate({ topology: { kind: 'sphere', n: 4 }, seed: 'rest' });
    const t = createTopology(maze.topology);
    const sim = new ShellSim(maze, t, DEFAULT_PHYSICAL);
    const ctl = new ShellController(sim);
    const u0 = sim.state.u, v0 = sim.state.v;
    for (let i = 0; i < 120; i++) { ctl.step([0, 0, 0], 0, H); sim.step(H); }
    expect(Math.hypot(sim.state.u - u0, sim.state.v - v0)).toBeLessThan(1e-3);
  });

  for (const [seed, spec] of SPECS) {
    it(`${seed}: random steering never crosses a wall`, () => {
      const { maze } = generate({ topology: spec, seed, params: { trapsPerLayer: 1, bridges: 2 } });
      const t = createTopology(maze.topology);
      const sim = new ShellSim(maze, t, DEFAULT_PHYSICAL);
      const ctl = new ShellController(sim);
      let prev = sim.state.cell;
      let a = 0;
      for (let i = 0; i < 240 * 25; i++) {
        a += 0.9 * H;
        ctl.step([Math.cos(a), Math.sin(1.7 * a), 0], (9 * Math.PI) / 180, H);
        const ev = sim.step(H);
        const cur = sim.state.cell;
        if (cur !== prev && prev !== null && cur !== null && sim.state.phase === 'rolling' && !ev.includes('reset')) {
          const e = maze.edges.get(edgeKey(prev, cur));
          expect(e, `${seed}: moved ${prev}→${cur} without a passage`).toBeDefined();
        }
        prev = cur;
      }
    });

    it(`${seed}: autopilot reaches the goal`, () => {
      const { maze } = generate({ topology: spec, seed: `${seed}-auto`, params: { trapsPerLayer: 1, bridges: 2 } });
      const t = createTopology(maze.topology);
      const sim = new ShellSim(maze, t, DEFAULT_PHYSICAL);
      const ctl = new ShellController(sim);
      const pilot = new ShellAutopilot(maze, t, sim);
      const visited = new Set<CellId>();
      let steps = 0;
      while (sim.state.phase !== 'won' && steps < 240 * 240) {
        const st = pilot.worldSteer(ctl.R);
        ctl.steer(st.ref, st.d, st.angle, H);
        sim.step(H);
        if (sim.state.cell !== null) visited.add(sim.state.cell);
        steps++;
      }
      expect(sim.state.phase, `${seed}: not solved in ${(steps / 240).toFixed(0)} s, ${sim.state.traps} traps, ${visited.size}/${solve(maze, t).length + 1} route cells visited`).toBe('won');
      expect(sim.state.traps).toBe(0);
    });
  }
});
