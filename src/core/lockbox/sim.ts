import type { LockBox } from './model';
import { clutchBacklash, goalPolar, wrapDeg } from './model';

export interface LockBoxSimParams {
  /** Gravity, mm/s². */
  readonly g: number;
  readonly rollFactor: number;
  readonly restitution: number;
  /** Viscous damping, 1/s. */
  readonly damping: number;
  /** Rolling resistance, mm/s². */
  readonly rollRes: number;
  readonly maxSpeed: number;
  /** Cap speed at full turn input, deg/s. */
  readonly capDegPerS: number;
  /** Lid speed when it is lifted or lowered, mm/s. */
  readonly liftMmPerS: number;
  /** How high an unlocked lid is lifted, mm. */
  readonly liftH: number;
}

export const DEFAULT_LOCKBOX_SIM: LockBoxSimParams = {
  g: 9810, rollFactor: 5 / 7, restitution: 0.25, damping: 0.6, rollRes: 60, maxSpeed: 300, capDegPerS: 50, liftMmPerS: 45, liftH: 26,
};

/**
 * goal: the ball fell into the goal hole. click: it dropped into a ring pocket (clutch engaged).
 * stop: the ring reached a rotation stop. locked: a lift was refused by the bayonet. open / close: the lid came off / went back on.
 */
export type LockBoxEvent = 'goal' | 'click' | 'stop' | 'locked' | 'open' | 'close';

/** maze: rolling in the lanes. riding: in the goal hole, resting on the ring's top face. clutch: in a ring pocket. */
export type BallPhase = 'maze' | 'riding' | 'clutch';

export interface LockBoxState {
  /** Ball position and velocity in the cap frame (the maze turns with the cap). */
  x: number; y: number; vx: number; vy: number;
  /** Cap angle, degrees. Unbounded: the cap spins freely. */
  capA: number;
  /** Ring angle, degrees: 0 at the locked stop, openTurn at the open stop. */
  ringA: number;
  /** Height of the lid (cap + ring) above its seat, mm. */
  lidZ: number;
  /** The lid is being held up / pulled. */
  lifting: boolean;
  phase: BallPhase;
  /** Pocket the ball is in while in the clutch. */
  pocket: number;
  /** 0..1 progress of the ball dropping to its current level. */
  sunk: number;
  /** The lid has come off (it is above the body). */
  open: boolean;
  /** The ring is against a stop and the cap is pushing it further. */
  atStop: boolean;
  /** Seconds since the last refused lift (for the display), or -1. */
  sinceLocked: number;
  elapsed: number;
}

interface Seg { readonly ax: number; readonly ay: number; readonly bx: number; readonly by: number }

const RAD = Math.PI / 180;

/**
 * Ball maze lock box. Deterministic; units mm, s, radians for tilt, degrees for the cap and ring.
 * The ball is a circle inside the lane outline. The goal hole is one-way: an upright box cannot tip the ball back out.
 */
export class LockBoxSim {
  readonly state: LockBoxState;
  /** Box tilt in the world frame, radians: +x rolls the ball toward +x, +y toward +y (north). */
  tilt: { x: number; y: number } = { x: 0, y: 0 };
  /** Cap turn input, -1..1: positive = counter-clockwise seen from above (the unlocking direction). */
  turn = 0;
  private readonly segs: readonly Seg[];
  private readonly goalR: number;
  private readonly goalA: number;
  /** Half the cap/ring play with the ball in the clutch, degrees. */
  readonly backlash: number;
  private acc = 0;

  constructor(readonly box: LockBox, readonly params: LockBoxSimParams = DEFAULT_LOCKBOX_SIM) {
    const L = box.lanes;
    this.segs = L.map((a, i) => { const b = L[(i + 1) % L.length]!; return { ax: a[0], ay: a[1], bx: b[0], by: b[1] }; });
    const g = goalPolar(box);
    this.goalR = g.r; this.goalA = g.a;
    this.backlash = clutchBacklash(box);
    this.state = {
      x: box.start[0], y: box.start[1], vx: 0, vy: 0, capA: 0, ringA: 0, lidZ: 0, lifting: false,
      phase: 'maze', pocket: -1, sunk: 0, open: false, atStop: false, sinceLocked: -1, elapsed: 0,
    };
  }

  /** The bayonet holds the lid (tabs under the lugs). */
  get locked(): boolean { return this.state.ringA < this.box.clearAt - 1e-9; }

  /** Ball back on the start (as if picked out of the goal by hand). Cap, ring and lid stay as they are. */
  resetBall(): void {
    const s = this.state;
    s.x = this.box.start[0]; s.y = this.box.start[1]; s.vx = 0; s.vy = 0;
    s.phase = 'maze'; s.pocket = -1; s.sunk = 0; s.atStop = false;
  }

  /** Everything back to the locked box with the ball on the start. */
  resetAll(): void {
    const s = this.state;
    this.resetBall();
    s.capA = 0; s.ringA = 0; s.lidZ = 0; s.lifting = false; s.open = false; s.sinceLocked = -1; s.elapsed = 0;
    this.acc = 0; this.turn = 0; this.tilt = { x: 0, y: 0 };
  }

  /** Pull the lid up (true) or let it down (false). A locked lid only rattles and stays. */
  lift(up: boolean): void { this.state.lifting = up; }

  /** Ball height above the maze floor (≤ 0 once it is in the goal hole). */
  ballZ(): number {
    const b = this.box, s = this.state;
    if (s.phase === 'maze') return 0;
    const ride = b.capFloor + b.seamGap;
    return s.phase === 'riding' ? -ride * s.sunk : -(ride + b.pocketD * s.sunk);
  }

  /** Angle (degrees) from the goal hole to the centre of pocket k, measured cap minus ring; 0 = aligned. */
  private offsetTo(k: number, capA: number): number {
    return wrapDeg(this.goalA + capA - this.state.ringA - (this.box.pocketA0 + (k * 360) / this.box.pockets));
  }

  /** Deepest overlap (mm) between the ball and a lane wall; ≤ 0 when it is clear. Only meaningful in the maze. */
  penetration(): number {
    const s = this.state, r = this.box.ballR;
    let worst = -Infinity;
    for (const sg of this.segs) worst = Math.max(worst, r - distToSeg(s.x, s.y, sg));
    return worst;
  }

  step(dt: number): LockBoxEvent[] {
    const events: LockBoxEvent[] = [];
    const H = 1 / 480;
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= H) { this.acc -= H; this.substep(H, events); }
    return events;
  }

  private substep(h: number, events: LockBoxEvent[]): void {
    const s = this.state, b = this.box, p = this.params, r = b.ballR;
    s.elapsed += h;
    if (s.sinceLocked >= 0) s.sinceLocked += h;

    // ---- cap (and through the ball, the ring). The lid has to be seated to turn against the bayonet.
    const dCap = s.lidZ > b.liftPlay + 0.05 ? 0 : Math.max(-1, Math.min(1, this.turn)) * p.capDegPerS * h;
    if (dCap !== 0) {
      let cap = s.capA + dCap;
      if (s.phase === 'clutch') {
        const d = this.offsetTo(s.pocket, cap);
        const over = d > this.backlash ? d - this.backlash : d < -this.backlash ? d + this.backlash : 0;
        if (over !== 0) {
          const ring = Math.max(0, Math.min(b.openTurn, s.ringA + over));
          const short = over - (ring - s.ringA);
          s.ringA = ring;
          if (Math.abs(short) > 1e-9) {
            cap -= short;                                    // the ring is on a stop: the cap cannot go further either
            if (!s.atStop) events.push('stop');
            s.atStop = true;
          } else s.atStop = false;
        } else s.atStop = false;
      }
      s.capA = cap;
    }

    // ---- ball
    if (s.phase === 'maze') {
      // tilt is given in the world frame; the lanes turn with the cap
      const c = Math.cos(s.capA * RAD), sn = Math.sin(s.capA * RAD);
      const wx = p.rollFactor * p.g * Math.sin(this.tilt.x), wy = p.rollFactor * p.g * Math.sin(this.tilt.y);
      const ax = wx * c + wy * sn, ay = -wx * sn + wy * c;
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
      for (let it = 0; it < 4; it++) for (const sg of this.segs) this.hit(sg, r);
      // the goal hole spans the lane: once the ball's centre is over it, it drops in
      if (Math.hypot(s.x - b.goal[0], s.y - b.goal[1]) < b.holeR * 0.75) {
        s.phase = 'riding'; s.sunk = 0; s.vx = 0; s.vy = 0;
        events.push('goal');
      }
    } else {
      // held by the hole: settle on its centre and sink to the level below
      const k = Math.min(1, h * 30);
      s.x += (b.goal[0] - s.x) * k; s.y += (b.goal[1] - s.y) * k;
      s.sunk = Math.min(1, s.sunk + h * 12);
      if (s.phase === 'riding' && s.sunk >= 1) {
        for (let k2 = 0; k2 < b.pockets; k2++) {
          if (Math.abs(this.offsetTo(k2, s.capA)) <= this.backlash * 0.5) {
            s.phase = 'clutch'; s.pocket = k2; s.sunk = 0;
            events.push('click');
            break;
          }
        }
      }
    }

    // ---- lid
    const wasOpen = s.open;
    if (s.lifting) {
      if (this.locked) {
        s.lidZ = Math.min(b.liftPlay, s.lidZ + p.liftMmPerS * h);
        if (s.lidZ >= b.liftPlay) { s.lifting = false; s.sinceLocked = 0; events.push('locked'); }
      } else s.lidZ = Math.min(p.liftH, s.lidZ + p.liftMmPerS * h);
    } else if (s.lidZ > 0) s.lidZ = Math.max(0, s.lidZ - p.liftMmPerS * h);
    s.open = s.lidZ > b.liftPlay + 2;
    if (s.open && !wasOpen) events.push('open');
    if (!s.open && wasOpen) events.push('close');
  }

  private hit(sg: Seg, r: number): void {
    const s = this.state;
    const dx = sg.bx - sg.ax, dy = sg.by - sg.ay;
    const len2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, len2 > 0 ? ((s.x - sg.ax) * dx + (s.y - sg.ay) * dy) / len2 : 0));
    let nx = s.x - (sg.ax + dx * t), ny = s.y - (sg.ay + dy * t);
    const d = Math.hypot(nx, ny);
    if (d >= r || d < 1e-9) return;
    nx /= d; ny /= d;
    s.x += nx * (r - d); s.y += ny * (r - d);
    const vn = s.vx * nx + s.vy * ny;
    if (vn < 0) {
      const e = vn < -40 ? this.params.restitution : 0;
      s.vx -= (1 + e) * vn * nx; s.vy -= (1 + e) * vn * ny;
    }
  }
}

function distToSeg(px: number, py: number, s: Seg): number {
  const dx = s.bx - s.ax, dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, len2 > 0 ? ((px - s.ax) * dx + (py - s.ay) * dy) / len2 : 0));
  return Math.hypot(px - (s.ax + dx * t), py - (s.ay + dy * t));
}
