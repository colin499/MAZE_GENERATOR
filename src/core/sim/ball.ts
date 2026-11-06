import type { CellId } from '../model/ids';
import type { Hole, World } from './world';

export interface SimParams {
  /** Gravity, mm/s². */
  readonly g: number;
  /** Fraction of g·sinθ a rolling solid sphere accelerates with (5/7). */
  readonly rollFactor: number;
  /** Normal-velocity fraction kept on a wall hit. */
  readonly restitution: number;
  /** Tangential-velocity fraction kept on a wall hit. */
  readonly wallSlide: number;
  /** Viscous damping, 1/s. */
  readonly damping: number;
  /** Rolling resistance, constant deceleration in mm/s². */
  readonly rollRes: number;
  readonly maxSpeed: number;
  /** The ball commits to a hole when its centre is within r_hole − holeGrab·r_ball of the hole centre. */
  readonly holeGrab: number;
  /** Seconds the ball stays "lost" after a trap before it reappears at the start. */
  readonly lostDelay: number;
}

export const DEFAULT_SIM: SimParams = {
  g: 9810,
  rollFactor: 5 / 7,
  restitution: 0.3,
  wallSlide: 0.985,
  damping: 0.25,
  rollRes: 40,
  maxSpeed: 600,
  holeGrab: 0.4,
  lostDelay: 0.9,
};

export type Phase = 'rolling' | 'falling' | 'lost' | 'won';

export interface BallState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  layer: number;
  cell: CellId | null;
  phase: Phase;
  phaseT: number;
  hole: Hole | null;
  elapsed: number;
  drops: number;
  traps: number;
}

export type SimEvent = 'drop' | 'trap' | 'goal' | 'reset' | 'bump';

/** Board tilt in radians: +x lowers the +x edge (ball accelerates toward +x), likewise y. */
export interface Tilt { readonly x: number; readonly y: number }

/** Deterministic ball-on-tilting-board simulation. All units mm, s, radians. */
export class BallSim {
  readonly state: BallState;
  tilt: Tilt = { x: 0, y: 0 };
  private acc = 0;

  constructor(readonly world: World, readonly params: SimParams = DEFAULT_SIM) {
    this.state = {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, layer: 0, cell: null,
      phase: 'rolling', phaseT: 0, hole: null, elapsed: 0, drops: 0, traps: 0,
    };
    this.reset();
  }

  reset(): void {
    const s = this.state, w = this.world;
    s.x = w.start.x; s.y = w.start.y; s.layer = w.start.layer;
    s.z = w.layers[s.layer]!.floorZ + w.ballR;
    s.vx = s.vy = s.vz = 0;
    s.phase = 'rolling'; s.phaseT = 0; s.hole = null;
    s.cell = w.start.cell;
    this.acc = 0;
  }

  /** Advance by `dt` seconds (sub-stepped so the ball can never skip through a wall). */
  step(dt: number): SimEvent[] {
    const events: SimEvent[] = [];
    this.acc += Math.min(dt, 0.05);
    const wallT = Math.max(0.5, this.minWallThickness());
    while (this.acc > 0) {
      const speed = Math.hypot(this.state.vx, this.state.vy, this.state.vz);
      const h = Math.min(this.acc, 1 / 240, (0.4 * wallT) / Math.max(speed, 1));
      this.substep(h, events);
      this.acc -= h;
    }
    return events;
  }

  private minWallThickness(): number {
    const b = this.world.layers[0]?.walls[0];
    return b ? Math.min(b.x1 - b.x0, b.y1 - b.y0) : 1;
  }

  private substep(h: number, events: SimEvent[]): void {
    const s = this.state, p = this.params, w = this.world;
    s.elapsed += h;
    s.phaseT += h;
    switch (s.phase) {
      case 'rolling': this.roll(h, events); break;
      case 'falling': this.fall(h, events); break;
      case 'lost':
        if (s.phaseT >= p.lostDelay) { this.reset(); events.push('reset'); }
        break;
      case 'won': break;
    }
    if (s.phase === 'rolling') s.cell = w.cellAt(s.layer, s.x, s.y);
  }

  private roll(h: number, events: SimEvent[]): void {
    const s = this.state, p = this.params, w = this.world;
    const L = w.layers[s.layer]!;
    const r = w.ballR;
    let ax = p.rollFactor * p.g * Math.sin(this.tilt.x);
    let ay = p.rollFactor * p.g * Math.sin(this.tilt.y);

    // hole lip: the ball tips toward a hole it is partly over, and commits once far enough in
    for (const hole of L.holes) {
      const dx = hole.x - s.x, dy = hole.y - s.y;
      const d = Math.hypot(dx, dy);
      if (d >= hole.r + r * 0.5) continue;
      if (d < hole.r - r * p.holeGrab) {
        s.phase = 'falling'; s.phaseT = 0; s.hole = hole;
        s.vx *= 0.5; s.vy *= 0.5; s.vz = 0;
        return;
      }
      const k = (1 - d / (hole.r + r * 0.5)) * p.g * 0.6;
      if (d > 1e-6) { ax += (dx / d) * k; ay += (dy / d) * k; }
    }

    s.vx += ax * h; s.vy += ay * h;
    // rolling resistance + viscous damping
    const sp = Math.hypot(s.vx, s.vy);
    if (sp > 0) {
      const drop = Math.min(sp, p.rollRes * h + sp * p.damping * h);
      const f = (sp - drop) / sp;
      s.vx *= f; s.vy *= f;
    }
    const sp2 = Math.hypot(s.vx, s.vy);
    if (sp2 > p.maxSpeed) { s.vx *= p.maxSpeed / sp2; s.vy *= p.maxSpeed / sp2; }
    s.x += s.vx * h; s.y += s.vy * h;
    s.z = L.floorZ + r;

    // walls (two passes so corners resolve)
    for (let pass = 0; pass < 2; pass++) {
      const u = Math.min(w.w - 1, Math.max(0, Math.floor(s.x / w.pitch)));
      const v = Math.min(w.h - 1, Math.max(0, Math.floor(s.y / w.pitch)));
      for (const wi of L.buckets[v * w.w + u]!) {
        const b = L.walls[wi]!;
        if (!(b.z0 < s.z + r && b.z1 > s.z - r)) continue; // bridge walls sit above the ball
        const cx = Math.min(b.x1, Math.max(b.x0, s.x));
        const cy = Math.min(b.y1, Math.max(b.y0, s.y));
        let nx = s.x - cx, ny = s.y - cy;
        let d = Math.hypot(nx, ny);
        if (d >= r) continue;
        if (d < 1e-9) {
          // centre inside the box: push out along the axis of least penetration
          const px = Math.min(s.x - b.x0, b.x1 - s.x), py = Math.min(s.y - b.y0, b.y1 - s.y);
          if (px < py) { nx = s.x - b.x0 < b.x1 - s.x ? -1 : 1; ny = 0; } else { nx = 0; ny = s.y - b.y0 < b.y1 - s.y ? -1 : 1; }
          d = 0;
        } else { nx /= d; ny /= d; }
        s.x += nx * (r - d); s.y += ny * (r - d);
        const vn = s.vx * nx + s.vy * ny;
        if (vn < 0) {
          const tx = s.vx - vn * nx, ty = s.vy - vn * ny;
          s.vx = tx * p.wallSlide - vn * p.restitution * nx;
          s.vy = ty * p.wallSlide - vn * p.restitution * ny;
          if (-vn > 60) events.push('bump');
        }
      }
    }
    // outer safety clamp (should never trigger: the boundary walls exist)
    s.x = Math.min(w.w * w.pitch, Math.max(0, s.x));
    s.y = Math.min(w.h * w.pitch, Math.max(0, s.y));
  }

  private fall(h: number, events: SimEvent[]): void {
    const s = this.state, p = this.params, w = this.world;
    const hole = s.hole!;
    s.vz -= p.g * h;
    s.z += s.vz * h;
    // slide down the hole wall toward its centre
    const k = Math.min(1, 12 * h);
    s.x += (hole.x - s.x) * k; s.y += (hole.y - s.y) * k;
    s.vx *= 1 - k; s.vy *= 1 - k;
    if (hole.kind === 'dropout') {
      const land = w.layers[s.layer - 1]!.floorZ + w.ballR;
      if (s.z <= land) {
        s.z = land; s.vz = 0; s.layer -= 1; s.cell = hole.to;
        s.phase = 'rolling'; s.phaseT = 0; s.hole = null; s.drops += 1;
        events.push('drop');
      }
      return;
    }
    const bottom = -w.ballR * 4;
    if (s.z < bottom) {
      if (hole.kind === 'goal') { s.phase = 'won'; s.phaseT = 0; s.vz = 0; s.z = bottom; events.push('goal'); }
      else { s.phase = 'lost'; s.phaseT = 0; s.vz = 0; s.z = bottom; s.traps += 1; events.push('trap'); }
    }
  }
}

export const clampTilt = (t: Tilt, max: number): Tilt => ({ x: Math.max(-max, Math.min(max, t.x)), y: Math.max(-max, Math.min(max, t.y)) });
export const deg = (d: number): number => (d * Math.PI) / 180;
