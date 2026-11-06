import { describe, expect, it } from 'vitest';
import { generate } from '@core/generate/pipeline';
import { createTopology } from '@core/topology/registry';
import { DEFAULT_PHYSICAL } from '@core/layout/physical';
import { edgeKey } from '@core/model/ids';
import { buildWorld } from '@core/sim/world';
import { BallSim, deg } from '@core/sim/ball';
import { Autopilot } from '@core/sim/autopilot';
import type { CellId } from '@core/model/ids';

const H = 1 / 240;

describe('ball simulation', () => {
  it('rests at the start and accelerates in the tilt direction', () => {
    const { maze } = generate({ topology: { kind: 'flat', w: 5, h: 5 }, seed: 'rest' });
    const t = createTopology(maze.topology);
    const sim = new BallSim(buildWorld(maze, t, DEFAULT_PHYSICAL));
    const x0 = sim.state.x, y0 = sim.state.y;
    for (let i = 0; i < 60; i++) sim.step(H);
    expect(sim.state.x).toBeCloseTo(x0, 6);
    expect(sim.state.y).toBeCloseTo(y0, 6);
    sim.tilt = { x: deg(5), y: 0 };
    sim.step(0.05);
    expect(sim.state.vx).toBeGreaterThan(0);
    expect(Math.abs(sim.state.vy)).toBeLessThan(1e-6);
  });

  it('never passes through a wall: every cell change follows a passage', () => {
    for (const seed of ['a', 'b', 'c']) {
      const { maze } = generate({ topology: { kind: 'stacked', w: 7, h: 7, layers: 2 }, seed, params: { bridges: 2, trapsPerLayer: 1 } });
      const t = createTopology(maze.topology);
      const sim = new BallSim(buildWorld(maze, t, DEFAULT_PHYSICAL));
      let prev = sim.state.cell;
      let angle = 0;
      for (let i = 0; i < 240 * 20; i++) {
        angle += 0.7 * H; // sweep the tilt around so the ball bangs into everything
        sim.tilt = { x: deg(8) * Math.cos(angle), y: deg(8) * Math.sin(angle * 1.7) };
        const ev = sim.step(H);
        const cur = sim.state.cell;
        if (cur !== prev && prev !== null && cur !== null && sim.state.phase === 'rolling' && !ev.includes('drop') && !ev.includes('reset')) {
          const e = maze.edges.get(edgeKey(prev, cur));
          expect(e, `moved ${prev}→${cur} without a passage`).toBeDefined();
          expect(e!.kind === 'open' || e!.kind === 'tunnel').toBe(true);
        }
        prev = cur;
      }
    }
  });

  it('falls through a dropout onto the layer below', () => {
    const { maze } = generate({ topology: { kind: 'stacked', w: 6, h: 6, layers: 2 }, seed: 'drop', params: { trapsPerLayer: 0 } });
    const t = createTopology(maze.topology);
    const world = buildWorld(maze, t, DEFAULT_PHYSICAL);
    const dropout = [...maze.edges.values()].find((e) => e.kind === 'dropout')!;
    const upper = dropout.from!;
    const sim = new BallSim(world);
    const [hx, hy] = world.center(upper);
    sim.state.x = hx + 0.5; sim.state.y = hy; sim.state.layer = t.cell(upper).layer; sim.state.cell = upper;
    sim.state.z = world.layers[sim.state.layer]!.floorZ + world.ballR;
    const events: string[] = [];
    for (let i = 0; i < 240; i++) events.push(...sim.step(H));
    expect(events).toContain('drop');
    expect(sim.state.layer).toBe(t.cell(upper).layer - 1);
    expect(sim.state.cell).toBe(upper === dropout.a ? dropout.b : dropout.a);
    expect(sim.state.z).toBeCloseTo(world.layers[sim.state.layer]!.floorZ + world.ballR, 6);
  });

  it('a trap loses the ball and returns it to the start', () => {
    const { maze } = generate({ topology: { kind: 'stacked', w: 6, h: 6, layers: 2 }, seed: 'trap', params: { trapsPerLayer: 2 } });
    const t = createTopology(maze.topology);
    const world = buildWorld(maze, t, DEFAULT_PHYSICAL);
    const trap = [...maze.traps][0]!;
    const sim = new BallSim(world);
    const [hx, hy] = world.center(trap);
    sim.state.x = hx; sim.state.y = hy; sim.state.layer = t.cell(trap).layer; sim.state.cell = trap;
    const events: string[] = [];
    for (let i = 0; i < 240 * 2; i++) events.push(...sim.step(H));
    expect(events).toContain('trap');
    expect(events).toContain('reset');
    expect(sim.state.traps).toBe(1);
    expect(sim.state.cell).toBe(maze.start);
    expect(sim.state.phase).toBe('rolling');
  });

  it('autopilot solves generated mazes under physics', () => {
    for (const [seed, spec] of [
      ['auto1', { kind: 'flat', w: 8, h: 8 }],
      ['auto2', { kind: 'stacked', w: 7, h: 6, layers: 3 }],
      ['auto3', { kind: 'stacked', w: 9, h: 9, layers: 2 }],
    ] as const) {
      const { maze } = generate({ topology: spec, seed, params: { bridges: 3, trapsPerLayer: 2 } });
      const t = createTopology(maze.topology);
      const world = buildWorld(maze, t, DEFAULT_PHYSICAL);
      const sim = new BallSim(world);
      const pilot = new Autopilot(maze, t, world);
      const visited = new Set<CellId>();
      let steps = 0;
      while (sim.state.phase !== 'won' && steps < 240 * 180) {
        sim.tilt = pilot.control(sim.state);
        sim.step(H);
        if (sim.state.cell !== null) visited.add(sim.state.cell);
        steps++;
      }
      expect(sim.state.phase, `${seed}: not solved in ${(steps / 240).toFixed(0)} s (${sim.state.traps} traps)`).toBe('won');
      expect(sim.state.traps).toBe(0);
    }
  });
});
