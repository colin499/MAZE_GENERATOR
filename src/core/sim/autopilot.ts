import type { CellId } from '../model/ids';
import type { Maze } from '../model/maze';
import type { Topology } from '../model/topology';
import { SIDE_DELTA, sideTo } from '../model/topology';
import { graphOf } from '../graph/index';
import type { BallState, Tilt } from './ball';
import { clampTilt } from './ball';
import type { World } from './world';
import type { ShellSim } from './shell';
import type { Vec3 } from '../math/vec';
import { quatRotate } from '../math/quat';
import type { Quat } from '../math/quat';

/** Next cell toward the goal from every cell, never stepping into a trap; −1 where the goal is unreachable. */
export function nextHopTable(maze: Maze, topo: Topology): Int32Array {
  const n = topo.cellCount;
  const g = graphOf(maze, n);
  const dist = new Int32Array(n).fill(-1);
  const next = new Int32Array(n).fill(-1);
  const queue: CellId[] = [maze.goal];
  dist[maze.goal] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    for (const p of g.inn[c]!) {
      if (maze.traps.has(p) || dist[p] !== -1) continue;
      dist[p] = dist[c]! + 1;
      next[p] = c;
      queue.push(p);
    }
  }
  return next;
}

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
    this.next = nextHopTable(maze, topo);
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

/** Steering request for a shell: a tangent direction in the object frame, a slope angle, and the floor normal to level. */
export interface ShellSteer {
  readonly dir: Vec3;
  readonly angle: number;
  /** Object-frame normal of the floor the ball should be on (the next face when crossing an edge). */
  readonly ref: Vec3;
}

/** Autopilot for shell mazes: aims at the next cell in the current panel's grid coordinates. */
export class ShellAutopilot {
  private readonly next: Int32Array;

  /** Cruise speed capped by the shell's size: a few radians per second around a small tube is plenty. */
  private readonly speed: number;

  constructor(maze: Maze, private readonly topo: Topology, private readonly sim: ShellSim, readonly opts: AutopilotOptions = DEFAULT_AUTOPILOT) {
    this.next = nextHopTable(maze, topo);
    const b = sim.surface.bbox;
    const radius = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
    this.speed = Math.min(opts.speed, 3 * radius);
  }

  nextHop(cell: CellId): CellId | null {
    const n = this.next[cell]!;
    return n < 0 ? null : (n as CellId);
  }

  /** Target point in the current panel's grid coordinates (cells across a panel edge are folded out). */
  target(): { u: number; v: number; slow: boolean } | null {
    const s = this.sim.state;
    if (s.cell === null) return null;
    let cur = s.cell;
    let nxt = this.nextHop(cur);
    if (nxt === null) return null;
    const ci = this.topo.cell(cur);
    let side = sideTo(this.topo, cur, nxt);
    if (side === null) return null;
    let d = SIDE_DELTA[side]!;
    let steps = 1;
    // look ahead along straight runs within this panel
    for (let i = 0; i < 2; i++) {
      const after = this.nextHop(nxt);
      if (after === null || after === this.sim.maze.goal || this.topo.cell(nxt).panel !== ci.panel) break;
      const s2 = sideTo(this.topo, nxt, after);
      if (s2 !== side) break;
      cur = nxt; nxt = after; steps++;
      side = s2; d = SIDE_DELTA[side]!;
    }
    const slow = this.nextHop(nxt) === this.sim.maze.goal || this.topo.cell(nxt).panel !== ci.panel;
    return { u: ci.u + 0.5 + d[0] * steps, v: ci.v + 0.5 + d[1] * steps, slow };
  }

  /** Steering for the current state: desired tangent direction in the object frame and slope. */
  control(): ShellSteer | null {
    const s = this.sim.state;
    if (s.phase !== 'rolling' || s.cell === null) return null;
    const t = this.target();
    if (!t) return null;
    const surf = this.sim.surface;
    const [pu, pv] = surf.metric(s.panel, s.u, s.v, this.sim.ballR);
    const dx = (t.u - s.u) * pu, dy = (t.v - s.v) * pv;
    const d = Math.hypot(dx, dy);
    const o = this.opts;
    const vmax = t.slow ? Math.min(this.speed, 40 + d * 4) : Math.min(this.speed, 60 + d * 3);
    const vdx = d > 1e-6 ? (dx / d) * vmax : 0, vdy = d > 1e-6 ? (dy / d) * vmax : 0;
    let eu = vdx - s.vu, ev = vdy - s.vv;
    const e = Math.hypot(eu, ev);
    const k = 1 / (o.tau * 7007);
    const angle = Math.min(o.maxTilt, e * k);
    // When the next cell lies on another panel the floor changes direction at the edge:
    // - concave (inside a cube): the ball pins in the corner, so level the NEXT face and push away from the edge;
    // - convex (outside a cube): the ball simply rolls over the edge (the sleeve holds it on) and the controller
    //   then levels the new face as fast as it can — levelling the next face in advance would put the edge at
    //   the top and the ball could never climb to it;
    // - smooth (sphere): nothing special, the current floor is the reference.
    let frame = surf.frame(s.panel, s.u, s.v);
    let ref: Vec3 = frame.n;
    const nxt = this.nextHop(s.cell)!;
    const ni = this.topo.cell(nxt);
    if (ni.panel !== s.panel && !surf.curved) {
      const side = sideTo(this.topo, s.cell, nxt)!;
      const dd = SIDE_DELTA[side]!;
      const x = this.topo.crossPanel(s.panel, s.u + dd[0] * 1.5, s.v + dd[1] * 1.5);
      if (x) {
        const next = surf.frame(x.panel, x.u, x.v);
        if (surf.edgeInset > 0) {
          const mu = x.m[0] * eu + x.m[1] * ev, mv = x.m[2] * eu + x.m[3] * ev;
          eu = mu; ev = mv;
          frame = next;
          ref = next.n;
        }
      }
    }
    if (e < 1e-6) return { dir: [0, 0, 0], angle: 0, ref };
    const dir: Vec3 = [
      (eu * frame.tu[0] + ev * frame.tv[0]) / e,
      (eu * frame.tu[1] + ev * frame.tv[1]) / e,
      (eu * frame.tu[2] + ev * frame.tv[2]) / e,
    ];
    return { dir, angle, ref };
  }

  /** The same steering expressed as a horizontal world direction for a given object orientation. */
  worldSteer(R: Quat): { d: Vec3; angle: number; ref: Vec3 } {
    const c = this.control();
    if (!c) return { d: [0, 0, 0], angle: 0, ref: this.sim.ballNormal() };
    const w = quatRotate(R, c.dir);
    return { d: [w[0], w[1], 0], angle: c.angle, ref: c.ref };
  }
}
