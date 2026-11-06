import type { CellId } from '../model/ids';
import type { Maze } from '../model/maze';
import type { Topology } from '../model/topology';
import { graphOf } from '../graph/index';
import type { BallState, Tilt } from './ball';
import { clampTilt } from './ball';
import type { World } from './world';

export interface AutopilotOptions {
  /** Cruise speed, mm/s. */
  readonly speed: number;
  /** Time constant for velocity correction, s. */
  readonly tau: number;
  readonly maxTilt: number;
}

export const DEFAULT_AUTOPILOT: AutopilotOptions = { speed: 160, tau: 0.12, maxTilt: (7 * Math.PI) / 180 };

/**
 * Drives the ball toward the goal along the shortest route that never enters a trap.
 * Pure: the only state is the next-hop table computed once per maze.
 */
export class Autopilot {
  private readonly next: Int32Array;

  constructor(maze: Maze, private readonly topo: Topology, private readonly world: World, readonly opts: AutopilotOptions = DEFAULT_AUTOPILOT) {
    const n = topo.cellCount;
    const g = graphOf(maze, n);
    // reverse BFS from the goal over arcs whose source is not a trap
    const dist = new Int32Array(n).fill(-1);
    this.next = new Int32Array(n).fill(-1);
    const queue: CellId[] = [maze.goal];
    dist[maze.goal] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi]!;
      for (const p of g.inn[c]!) {
        if (maze.traps.has(p) || dist[p] !== -1) continue;
        dist[p] = dist[c]! + 1;
        this.next[p] = c;
        queue.push(p);
      }
    }
  }

  nextHop(cell: CellId): CellId | null {
    const n = this.next[cell]!;
    return n < 0 ? null : (n as CellId);
  }

  /** Where the ball should be heading from its current cell, or null when there is nowhere to go. */
  target(s: BallState): readonly [number, number] | null {
    if (s.cell === null) return null;
    let cur: CellId = s.cell;
    let nxt = this.nextHop(cur);
    if (nxt === null) return null;
    const vertical = (a: CellId, b: CellId) => this.topo.cell(a).layer !== this.topo.cell(b).layer;
    if (vertical(cur, nxt)) return this.world.center(cur); // aim for the hole in this cell
    // look ahead through straight runs so corridors are taken at speed
    const [cx, cy] = this.world.center(cur);
    const [nx, ny] = this.world.center(nxt);
    const dx = Math.sign(nx - cx), dy = Math.sign(ny - cy);
    for (let i = 0; i < 2; i++) {
      const after = this.nextHop(nxt);
      if (after === null || vertical(nxt, after)) break;
      const [ax, ay] = this.world.center(after);
      const [px, py] = this.world.center(nxt);
      if (Math.sign(ax - px) !== dx || Math.sign(ay - py) !== dy) break;
      cur = nxt; nxt = after;
    }
    return this.world.center(nxt);
  }

  /** Tilt command for the current state. */
  control(s: BallState): Tilt {
    if (s.phase !== 'rolling') return { x: 0, y: 0 };
    const t = this.target(s);
    if (!t) return { x: 0, y: 0 };
    const dx = t[0] - s.x, dy = t[1] - s.y;
    const d = Math.hypot(dx, dy);
    const o = this.opts;
    // slow down when the target is a hole (the ball must settle over it) or a corner
    const nxt = s.cell !== null ? this.nextHop(s.cell) : null;
    const toHole = nxt !== null && s.cell !== null && this.topo.cell(nxt).layer !== this.topo.cell(s.cell).layer;
    const vmax = toHole ? Math.min(o.speed, 40 + d * 6) : Math.min(o.speed, 60 + d * 3);
    const vdx = d > 1e-6 ? (dx / d) * vmax : 0, vdy = d > 1e-6 ? (dy / d) * vmax : 0;
    // a = (5/7) g sinθ ≈ 7007 θ  →  θ needed to change v by Δv within tau
    const k = 1 / (o.tau * 7007);
    return clampTilt({ x: (vdx - s.vx) * k, y: (vdy - s.vy) * k }, o.maxTilt);
  }
}
