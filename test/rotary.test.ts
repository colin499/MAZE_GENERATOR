import { describe, expect, it } from 'vitest';
import { parseRotaryMaze } from '@core/rotary/model';
import { RotarySim } from '@core/rotary/sim';
import { DemoPlayer } from '@core/rotary/demo';
import { THREE_PATH_JSON } from '@core/rotary/sampleThreePath';
import { HARD_JSON } from '@core/rotary/sampleHard';
import { ANGULAR_JSON } from '@core/rotary/sampleAngular';

describe.each([['three-path v2', THREE_PATH_JSON], ['hard v3', HARD_JSON], ['angular v4', ANGULAR_JSON]])('rotary maze: %s', (_name, json) => {
  const maze = parseRotaryMaze(json);

  const RAD = Math.PI / 180;

  /** Steer the simulated ball along a recorded demo with tilt only, turning the dial where the demo does. */
  function autopilot(demoIdx: number): { sim: RotarySim; events: string[]; worst: number; failed: string; clicksAtGoal: number } {
    const demo = maze.demos[demoIdx]!;
    const first = demo.events.find((e) => e.t !== 'pause')!;
    const k0 = first.t === 'move' ? first.k : first.t === 'turn' ? first.k0 : 0;
    const sim = new RotarySim(maze);
    sim.reset(k0);
    const events: string[] = [];
    let worst = -Infinity;
    const tick = () => {
      for (const e of sim.step(1 / 120)) events.push(e);
      worst = Math.max(worst, sim.penetration(sim.state.x, sim.state.y, sim.state.angle));
    };
    const max = 10 * RAD;
    let clicksAtGoal = -1;
    const steer = (tx: number, ty: number) => {
      const s = sim.state;
      const ux = (tx - s.x) * 1.2 - s.vx * 0.03, uy = (ty - s.y) * 1.2 - s.vy * 0.03;
      const k = Math.max(1, Math.hypot(ux, uy));
      sim.tilt = { x: (ux / k) * max, y: (uy / k) * max };
      tick();
      if (clicksAtGoal < 0 && s.reachedGoal) clicksAtGoal = s.clicks;
    };
    for (const ev of demo.events) {
      if (ev.t === 'turn') {
        sim.tilt = { x: 0, y: 0 };
        for (let i = 0; i < 60; i++) tick();                       // let the ball settle
        sim.turn(ev.k1 - ev.k0);
        for (let i = 0; i < 2000 && sim.turning; i++) tick();
        if (sim.turning || sim.position !== ev.k1) return { sim, events, worst, clicksAtGoal, failed: `dial stuck going ${ev.k0}->${ev.k1}` };
      } else if (ev.t === 'move') {
        if (sim.position !== ev.k) return { sim, events, worst, clicksAtGoal, failed: `dial at ${sim.position}, demo expects ${ev.k}` };
        for (const [tx, ty] of ev.pts) {
          let n = 0;
          for (; n < 1200; n++) {
            if (Math.hypot(tx - sim.state.x, ty - sim.state.y) < 0.7) break;
            steer(tx, ty);
          }
          if (n === 1200) return { sim, events, worst, clicksAtGoal, failed: `stuck at ${sim.state.x.toFixed(1)},${sim.state.y.toFixed(1)} heading for ${tx},${ty} (dial ${sim.position})` };
        }
        // brake at the end of the leg, as a player would before touching the dial
        const end = ev.pts[ev.pts.length - 1];
        if (end) for (let n = 0; n < 240 && Math.hypot(sim.state.vx, sim.state.vy) > 3; n++) steer(end[0], end[1]);
      }
    }
    sim.tilt = { x: 0, y: 0 };
    for (let i = 0; i < 120; i++) tick();
    return { sim, events, worst, clicksAtGoal, failed: '' };
  }



  it('parses the bundled three-path maze', () => {
    expect(maze.format).toBe('rotary-maze/1');
    expect(maze.routes.length).toBeGreaterThan(0);
    expect(maze.demos.length).toBeGreaterThanOrEqual(maze.routes.length);
    expect(maze.walls.length).toBeGreaterThan(0);
    expect(maze.shutters.length).toBeGreaterThan(0);
    expect(() => parseRotaryMaze('{"format":"nope"}')).toThrow();
  });

  it('demo playback never puts the ball inside a wall or shutter', () => {
    const sim = new RotarySim(maze);
    for (const d of maze.demos) {
      const p = new DemoPlayer(maze, d);
      expect(p.duration).toBeGreaterThan(2);
      let worst = -Infinity;
      for (let t = 0; t <= p.duration; t += 0.02) {
        const f = p.sample(t);
        worst = Math.max(worst, sim.penetration(f.x, f.y, f.angle));
      }
      expect(worst, d.name).toBeLessThan(0.25);
      expect(p.sample(p.duration + 1).done).toBe(true);
    }
  });

  it('rests at the start, rolls with the tilt and stays inside the rim', () => {
    const sim = new RotarySim(maze);
    sim.step(0.5);
    expect(sim.state.x).toBeCloseTo(maze.start[0], 6);
    expect(sim.state.y).toBeCloseTo(maze.start[1], 6);
    for (const [tx, ty] of [[1, 0], [0, -1], [-1, 0], [0.7, 0.7]] as const) {
      sim.tilt = { x: tx * 10 * RAD, y: ty * 10 * RAD };
      for (let i = 0; i < 300; i++) {
        sim.step(1 / 60);
        expect(Math.hypot(sim.state.x, sim.state.y)).toBeLessThanOrEqual(maze.rimR - maze.ballR + 1e-6);
        expect(sim.penetration(sim.state.x, sim.state.y, sim.state.angle)).toBeLessThan(0.05);
      }
    }
    expect(sim.state.reachedGoal).toBe(false);
  });

  it('keeps the return lane shut until the return position', () => {
    for (let k = 0; k < maze.nDetent; k++) {
      const sim = new RotarySim(maze);
      sim.reset(k);
      sim.tilt = { x: 0, y: 8 * RAD };                           // straight up the lane towards the cup
      for (let i = 0; i < 600; i++) sim.step(1 / 60);
      expect(sim.state.reachedGoal, `dial ${k}`).toBe(false);    // the cup ledge is one-way even with the lane open
      // (mazes with rotating floor rings leave the lane mouth open: rolling in there is a trap, not a shortcut)
      if (k !== maze.returnPos && maze.dialFloor.length === 0) expect(sim.state.inLane, `dial ${k}`).toBe(false);
    }
  });

  it('the dial stops at its end positions and counts clicks', () => {
    const sim = new RotarySim(maze);
    expect(sim.turn(-1)).toBe(0);
    expect(sim.turn(2)).toBe(2);
    for (let i = 0; i < 200; i++) sim.step(1 / 60);
    expect(sim.position).toBe(2);
    expect(sim.turn(99)).toBe(maze.nDetent - 3);
    expect(sim.state.clicks).toBe(maze.nDetent - 1);
  });

  for (let i = 0; i < maze.routes.length; i++) {
    it(`maze ${i + 1} can be solved by tilting and turning (physics follows the recorded solution)`, () => {
      const r = autopilot(i);
      expect(r.failed).toBe('');
      expect(r.events).toContain('goal');
      expect(r.events).toContain('home');
      expect(r.events).not.toContain('jam');
      expect(r.worst).toBeLessThan(0.05);
      expect(r.clicksAtGoal).toBe(maze.routes.find((x) => x.maze === maze.demos[i]!.maze)!.clicks);
    });
  }

  it('pit traps catch the ball and only let it out through the return lane', () => {
    for (const reg of maze.trench) {
      if (reg.kind !== 'trap') continue;
      const cx = reg.poly.reduce((a, p) => a + p[0], 0) / reg.poly.length, cy = reg.poly.reduce((a, p) => a + p[1], 0) / reg.poly.length;
      const sim = new RotarySim(maze);
      sim.state.x = cx; sim.state.y = cy;                       // dial at 0: dial-frame regions are where they are drawn
      const ev: string[] = [];
      for (let i = 0; i < 30; i++) ev.push(...sim.step(1 / 60));
      expect(ev).toContain('trap');
      expect(sim.state.trapped).toBe(true);
      // rattle it around: it must stay in the sunken area
      for (const [tx, ty] of [[1, 0], [0, 1], [-1, 0], [1, 1], [-1, 1], [0, -1], [0, 1]] as const) {
        sim.tilt = { x: tx * 12 * RAD, y: ty * 12 * RAD };
        for (let i = 0; i < 240; i++) { sim.step(1 / 60); expect(sim.state.inLane).toBe(true); }
      }
      expect(sim.state.reachedGoal).toBe(false);
      // the way out: return position (a pit on the dial carries the ball round), then roll to the start
      sim.tilt = { x: 0, y: 0 };
      sim.turn(maze.returnPos);
      for (let i = 0; i < 600; i++) sim.step(1 / 60);
      expect(sim.position).toBe(maze.returnPos);
      let out = false;
      for (let n = 0; n < 4000 && !out; n++) {
        const s = sim.state;
        const ux = -s.x * 1.5 - s.vx * 0.03;
        sim.tilt = { x: Math.max(-1, Math.min(1, ux)) * 10 * RAD, y: Math.abs(s.x) > 0.3 ? 0 : -10 * RAD };
        sim.step(1 / 60);
        out = !s.inLane && s.y < maze.lane.yEnd + 1;
      }
      expect(out).toBe(true);
      expect(sim.state.trapped).toBe(false);
      expect(sim.state.reachedGoal).toBe(false);
    }
  });
});
