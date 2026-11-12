import type { Poly, Pt, RotaryMaze } from './model';
import { trenchAt } from './model';
import type { TrenchRegion } from './model';

export interface RotarySimParams {
  /** Gravity, mm/s². */
  readonly g: number;
  readonly rollFactor: number;
  readonly restitution: number;
  /** Viscous damping, 1/s. */
  readonly damping: number;
  /** Rolling resistance, mm/s². */
  readonly rollRes: number;
  readonly maxSpeed: number;
  /** Dial speed while it moves between positions, deg/s. */
  readonly dialDegPerS: number;
}

export const DEFAULT_ROTARY_SIM: RotarySimParams = {
  g: 9810, rollFactor: 5 / 7, restitution: 0.25, damping: 0.6, rollRes: 60, maxSpeed: 450, dialDegPerS: 45,
};

export type RotaryEvent = 'goal' | 'home' | 'click' | 'jam' | 'trap';

export interface RotaryState {
  x: number; y: number; vx: number; vy: number;
  /** Dial angle in degrees (position × detentDeg when at rest). */
  angle: number;
  /** Dial position the dial is moving to. */
  target: number;
  clicks: number;
  elapsed: number;
  /** Ball is in the goal cup or the return lane (below floor level). */
  inLane: boolean;
  /** 0..1 how far the ball has dropped into the cup. */
  sunk: number;
  reachedGoal: boolean;
  /** The ball fell into a drop trap and has to go back to the start. */
  trapped: boolean;
  /** Number of times the ball has fallen into a trap since the last reset. */
  traps: number;
  home: boolean;
  /** The ball is pinched by a shutter, so the dial cannot move further. */
  jammed: boolean;
}

interface Seg { ax: number; ay: number; bx: number; by: number }

/** Uniform grid over line segments for circle queries. */
class SegGrid {
  private readonly cells = new Map<number, Seg[]>();
  private readonly n: number;
  constructor(segs: readonly Seg[], private readonly half: number, private readonly size: number) {
    this.n = Math.ceil((2 * half) / size);
    for (const s of segs) {
      const i0 = this.idx(Math.min(s.ax, s.bx)), i1 = this.idx(Math.max(s.ax, s.bx));
      const j0 = this.idx(Math.min(s.ay, s.by)), j1 = this.idx(Math.max(s.ay, s.by));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const key = i + j * this.n;
        let list = this.cells.get(key);
        if (!list) { list = []; this.cells.set(key, list); }
        list.push(s);
      }
    }
  }
  private idx(v: number): number { return Math.max(0, Math.min(this.n - 1, Math.floor((v + this.half) / this.size))); }
  each(x: number, y: number, r: number, fn: (s: Seg) => void): void {
    const i0 = this.idx(x - r), i1 = this.idx(x + r), j0 = this.idx(y - r), j1 = this.idx(y + r);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const list = this.cells.get(i + j * this.n);
      if (list) for (const s of list) fn(s);
    }
  }
}

function segsOf(polys: readonly Poly[]): Seg[] {
  const out: Seg[] = [];
  const ring = (pts: readonly Pt[]) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      out.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1] });
    }
  };
  for (const p of polys) { ring(p.outer); p.holes.forEach(ring); }
  return out;
}

const RAD = Math.PI / 180;

/**
 * Ball on a tilting rotary maze. Deterministic; units mm, s, radians for tilt, degrees for the dial.
 * The ball is a circle rolling in the plane; walls and shutters are polygon outlines. The goal cup and return lane
 * are one-way: once the ball's centre is over them it has dropped below the floor and cannot climb back out.
 */
export class RotarySim {
  readonly state: RotaryState;
  /** Board tilt, radians: +x rolls the ball toward +x, +y toward +y (north). */
  tilt: { x: number; y: number } = { x: 0, y: 0 };
  private readonly fixed: SegGrid;
  private readonly moving: SegGrid;
  private readonly trench: readonly { readonly reg: TrenchRegion; readonly segs: readonly Seg[] }[];
  /** Depth under the ball at the previous step (to notice a drop to a lower level). */
  private level = 0;
  private acc = 0;
  private readonly rampSin: number;

  constructor(readonly maze: RotaryMaze, readonly params: RotarySimParams = DEFAULT_ROTARY_SIM, startPos = 0) {
    const half = maze.outerR + 4;
    this.fixed = new SegGrid(segsOf(maze.walls), half, 4);
    this.moving = new SegGrid(segsOf(maze.shutters), half, 4);
    const L = maze.lane;
    this.rampSin = Math.sin(Math.atan2(L.depth, L.yFlatEnd - L.yEnd));
    this.state = {
      x: maze.start[0], y: maze.start[1], vx: 0, vy: 0, angle: startPos * maze.detentDeg, target: startPos,
      clicks: 0, elapsed: 0, inLane: false, sunk: 0, reachedGoal: false, trapped: false, traps: 0, home: false, jammed: false,
    };
    this.trench = maze.trench.map((reg) => ({ reg, segs: reg.poly.map((a, i) => { const b = reg.poly[(i + 1) % reg.poly.length]!; return { ax: a[0], ay: a[1], bx: b[0], by: b[1] }; }) }));
  }

  /** Current dial position (nearest detent). */
  get position(): number { return Math.round(this.state.angle / this.maze.detentDeg); }
  get turning(): boolean { return Math.abs(this.state.angle - this.state.target * this.maze.detentDeg) > 1e-9; }

  /** Ask the dial to move by whole positions (clamped to the end stops). Returns the clicks actually added. */
  turn(delta: number): number {
    const s = this.state;
    const t = Math.max(0, Math.min(this.maze.nDetent - 1, s.target + Math.round(delta)));
    const added = Math.abs(t - s.target);
    s.target = t;
    s.clicks += added;
    return added;
  }

  /** Put the ball back at the start; optionally also set the dial (instantly). */
  reset(dialPos?: number): void {
    const s = this.state;
    s.x = this.maze.start[0]; s.y = this.maze.start[1]; s.vx = 0; s.vy = 0;
    s.inLane = false; s.sunk = 0; s.reachedGoal = false; s.trapped = false; s.traps = 0; s.home = false; s.jammed = false;
    s.clicks = 0; s.elapsed = 0;
    if (dialPos !== undefined) { s.target = dialPos; s.angle = dialPos * this.maze.detentDeg; }
    this.acc = 0; this.level = 0;
  }

  /** Height of the ball's lowest point relative to the floor (≤ 0 in the cup and lane). */
  floorOffset(): number {
    const s = this.state;
    return s.inLane ? -this.level * s.sunk : 0;
  }

  step(dt: number): RotaryEvent[] {
    const events: RotaryEvent[] = [];
    const H = 1 / 480;
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= H) { this.acc -= H; this.substep(H, events); }
    return events;
  }

  /** Deepest overlap (mm) between the ball at (x, y) and anything solid, for a given dial angle. */
  penetration(x: number, y: number, angleDeg: number): number {
    const r = this.maze.ballR;
    let worst = Math.hypot(x, y) + r - this.maze.rimR;
    const probe = (px: number, py: number) => (s: Seg) => {
      const d = distToSeg(px, py, s);
      if (r - d > worst) worst = r - d;
    };
    this.fixed.each(x, y, r, probe(x, y));
    const c = Math.cos(-angleDeg * RAD), sn = Math.sin(-angleDeg * RAD);
    const qx = x * c - y * sn, qy = x * sn + y * c;
    this.moving.each(qx, qy, r, probe(qx, qy));
    return worst;
  }

  private substep(h: number, events: RotaryEvent[]): void {
    const s = this.state, m = this.maze, p = this.params, r = m.ballR;
    s.elapsed += h;
    const x0 = s.x, y0 = s.y, a0 = s.angle;
    // dial
    const goalA = s.target * m.detentDeg;
    let dA = 0;
    if (s.angle !== goalA) {
      const step = p.dialDegPerS * h;
      dA = Math.abs(goalA - s.angle) <= step ? goalA - s.angle : Math.sign(goalA - s.angle) * step;
      s.angle += dA;
      if (s.angle === goalA) events.push('click');
    }
    const omega = (dA / h) * RAD;
    // forces
    let ay = p.rollFactor * p.g * Math.sin(this.tilt.y);
    let ax = p.rollFactor * p.g * Math.sin(this.tilt.x);
    if (s.inLane) {
      const th = trenchAt(m, s.x, s.y, s.angle);
      if (th && th.onRamp && th.depth > 0) {
        // downhill is toward the centre along the lane; a notch riding on the dial points wherever the dial has put it
        const a = th.region.frame === 'dial' ? (s.angle - m.returnPos * m.detentDeg) * RAD : 0;
        const k = p.rollFactor * p.g * this.rampSin;
        ax += -Math.sin(a) * k; ay += Math.cos(a) * k;
      }
    }
    s.vx += ax * h; s.vy += ay * h;
    const damp = Math.exp(-p.damping * h);
    s.vx *= damp; s.vy *= damp;
    let sp = Math.hypot(s.vx, s.vy);
    if (sp > 0) {
      const drop = p.rollRes * h;
      if (sp <= drop && Math.hypot(ax, ay) < p.rollRes) { s.vx = 0; s.vy = 0; sp = 0; }
      else { const k = Math.max(0, sp - drop) / sp; s.vx *= k; s.vy *= k; sp *= k; }
    }
    if (sp > p.maxSpeed) { s.vx *= p.maxSpeed / sp; s.vy *= p.maxSpeed / sp; }
    s.x += s.vx * h; s.y += s.vy * h;
    // contacts
    const wasLane = s.inLane;
    for (let it = 0; it < 4; it++) {
      // rim
      const d = Math.hypot(s.x, s.y);
      if (d > m.rimR - r) { const nx = -s.x / d, ny = -s.y / d; this.contact(nx, ny, d - (m.rimR - r), 0, 0); }
      this.fixed.each(s.x, s.y, r, (sg) => this.hit(sg, s.x, s.y, 1, 0, 0));
      const c = Math.cos(s.angle * RAD), sn = Math.sin(s.angle * RAD);
      const qx = s.x * c + s.y * sn, qy = -s.x * sn + s.y * c;      // ball in the dial frame
      this.moving.each(qx, qy, r, (sg) => this.hit(sg, qx, qy, c, sn, omega));
      if (wasLane) this.confine(omega);
    }
    // a shutter that cannot push the ball out of its way stops the dial
    if (dA !== 0 && this.penetration(s.x, s.y, s.angle) > 0.2) {
      s.angle = a0; s.x = x0; s.y = y0; s.vx = 0; s.vy = 0;
      if (!s.jammed) events.push('jam');
      s.jammed = true;
    } else if (dA !== 0 || s.angle === goalA) s.jammed = false;
    // goal cup / return lane
    const th = trenchAt(m, s.x, s.y, s.angle);
    s.inLane = th !== null;
    if (th) {
      if (th.depth > this.level + 0.3) s.sunk = 0;          // dropped to a lower level: ease in again
      const dropped = !wasLane && th.depth > 0.4;
      this.level = th.depth;
      s.sunk = Math.max(s.sunk, Math.min(1, this.edgeDistance(th.depth) / r));
      // only a drop from the maze floor counts; rolling up the open lane from the start does not
      if (th.region.kind === 'cup' && !wasLane && !s.reachedGoal) { s.reachedGoal = true; events.push('goal'); }
      else if (dropped && th.region.kind !== 'cup' && !s.reachedGoal) { s.trapped = true; s.traps++; events.push('trap'); }
    } else { s.sunk = 0; s.trapped = false; this.level = 0; }
    if (s.reachedGoal && !s.home && !s.inLane && Math.hypot(s.x - m.start[0], s.y - m.start[1]) < 3) {
      s.home = true; events.push('home');
    }
  }

  /**
   * Is a pit edge open? (ix, iy) is just inside it on the ball's side, (qx, qy) just beyond: it is open when the
   * sunken area continues beyond without a step up (the ramp is a slope, not a step).
   */
  private openAt(ix: number, iy: number, qx: number, qy: number, depth: number): boolean {
    const m = this.maze, a = this.state.angle;
    const here = Math.min(depth, trenchAt(m, ix, iy, a)?.depth ?? depth);
    if (here < 0.3) return true;
    const t = trenchAt(m, qx, qy, a);
    return t !== null && t.depth >= here - 0.3;
  }

  /** Visit the pit-wall segments near the ball that really are walls for a ball `depth` below the floor. */
  private eachPitWall(depth: number, reach: number, fn: (sg: Seg, px: number, py: number, c: number, sn: number, dial: boolean, d: number) => void): void {
    const s = this.state;
    const c = Math.cos(s.angle * RAD), sn = Math.sin(s.angle * RAD);
    for (const { reg, segs } of this.trench) {
      const dial = reg.frame === 'dial';
      const px = dial ? s.x * c + s.y * sn : s.x, py = dial ? -s.x * sn + s.y * c : s.y;
      for (const sg of segs) {
        const dx = sg.bx - sg.ax, dy = sg.by - sg.ay;
        const len2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, len2 > 0 ? ((px - sg.ax) * dx + (py - sg.ay) * dy) / len2 : 0));
        const cx = sg.ax + dx * t, cy = sg.ay + dy * t;
        const d = Math.hypot(px - cx, py - cy);
        if (d >= reach) continue;
        // look just past the edge, on the far side from the ball
        const k = d > 1e-6 ? 0.5 / d : 0;
        const fx = cx + (cx - px) * k, fy = cy + (cy - py) * k;
        const gx = cx - (cx - px) * k * 0.8, gy = cy - (cy - py) * k * 0.8;
        const wx = dial ? fx * c - fy * sn : fx, wy = dial ? fx * sn + fy * c : fy;
        const ix = dial ? gx * c - gy * sn : gx, iy = dial ? gx * sn + gy * c : gy;
        if (this.openAt(ix, iy, wx, wy, depth)) continue;
        fn(sg, px, py, dial ? c : 1, dial ? sn : 0, dial, d);
      }
    }
  }

  /** Distance from the ball centre to the nearest real pit wall (capped at the ball radius). */
  private edgeDistance(depth: number): number {
    let best = this.maze.ballR;
    this.eachPitWall(depth, best, (_sg, _px, _py, _c, _sn, _dial, d) => { if (d < best) best = d; });
    return best;
  }

  /** Sunken ball: the pit walls of the cup, lane and traps hold it (drops are one-way). */
  private confine(omega: number): void {
    const rr = Math.min(this.maze.ballR, this.state.sunk * this.maze.ballR);
    if (rr <= 0) return;
    this.eachPitWall(this.level, rr, (sg, px, py, c, sn, dial) => this.hit(sg, px, py, c, sn, dial ? omega : 0, rr));
  }

  /** Resolve the ball against one segment given in a frame rotated by (c, sn) and turning at omega rad/s. */
  private hit(sg: Seg, px: number, py: number, c: number, sn: number, omega: number, r = this.maze.ballR): void {
    const dx = sg.bx - sg.ax, dy = sg.by - sg.ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - sg.ax) * dx + (py - sg.ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = sg.ax + dx * t, cy = sg.ay + dy * t;
    let nx = px - cx, ny = py - cy;
    const d = Math.hypot(nx, ny);
    if (d >= r || d < 1e-9) return;
    nx /= d; ny /= d;
    // back to the board frame
    const wnx = nx * c - ny * sn, wny = nx * sn + ny * c;
    const wcx = cx * c - cy * sn, wcy = cx * sn + cy * c;
    this.contact(wnx, wny, r - d, -omega * wcy, omega * wcx);
  }

  private contact(nx: number, ny: number, pen: number, svx: number, svy: number): void {
    const s = this.state;
    s.x += nx * pen; s.y += ny * pen;
    const vn = (s.vx - svx) * nx + (s.vy - svy) * ny;
    if (vn < 0) {
      const e = vn < -40 ? this.params.restitution : 0;
      s.vx -= (1 + e) * vn * nx; s.vy -= (1 + e) * vn * ny;
    }
  }
}

function distToSeg(px: number, py: number, s: Seg): number {
  const dx = s.bx - s.ax, dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - s.ax) * dx + (py - s.ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.ax + dx * t), py - (s.ay + dy * t));
}
