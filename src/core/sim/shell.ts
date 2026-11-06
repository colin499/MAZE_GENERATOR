import type { CellId } from '../model/ids';
import { edgeKey } from '../model/ids';
import type { Maze } from '../model/maze';
import type { Surface, Topology } from '../model/topology';
import { SIDES, cellsOnLayer, wallSegment } from '../model/topology';
import type { PhysicalParams } from '../layout/physical';
import { mergeRuns } from '../layout/runs';
import type { UnitSeg } from '../layout/runs';
import type { Vec3 } from '../math/vec';
import { dot3, norm3 } from '../math/vec';
import type { Quat } from '../math/quat';
import { QUAT_ID, quatAxisAngle, quatBetween, quatConj, quatMul, quatNormalize, quatRotate } from '../math/quat';
import type { Phase, SimEvent, SimParams } from './ball';
import { DEFAULT_SIM } from './ball';

/** Wall run in panel grid units (thickness and ball size are applied in local mm at collision time). */
interface Run {
  readonly u0: number; readonly u1: number;
  readonly v0: number; readonly v1: number;
  readonly bridge: boolean;
}

export interface ShellHole {
  readonly cell: CellId;
  readonly kind: 'trap' | 'goal';
  readonly panel: number;
  readonly u: number;
  readonly v: number;
}

export interface ShellState {
  panel: number;
  /** Grid coordinates on the panel. */
  u: number; v: number;
  /** Velocity in mm/s along the local u and v tangents. */
  vu: number; vv: number;
  /** Height of the ball centre above the floor surface (ballR while rolling, negative when falling out). */
  h: number;
  vh: number;
  cell: CellId | null;
  phase: Phase;
  phaseT: number;
  hole: ShellHole | null;
  elapsed: number;
  traps: number;
}

/**
 * Ball on the inside of a closed shell (cylinder, cube, sphere). The object is rotated by the player;
 * gravity is a unit vector `gDir` in the object frame. All motion happens in panel grid coordinates
 * with the surface's local metric, so the same code serves every shape.
 */
export class ShellSim {
  readonly surface: Surface;
  readonly state: ShellState;
  /** Gravity direction in the object frame (unit). */
  gDir: Vec3 = [0, 0, -1];
  private readonly runs: Run[][];
  private readonly holes: ShellHole[][];
  private readonly wrap: boolean[];
  private readonly pw: number[];
  private readonly ph: number[];
  private acc = 0;
  readonly ballR: number;

  constructor(readonly maze: Maze, readonly topo: Topology, readonly phys: PhysicalParams, readonly params: SimParams = DEFAULT_SIM) {
    this.surface = topo.surface(phys);
    this.ballR = phys.ballDia / 2;
    const panels = topo.panels();
    this.runs = panels.map(() => []);
    this.holes = panels.map(() => []);
    this.wrap = panels.map((p) => !!p.wrapU);
    this.pw = panels.map((p) => p.w);
    this.ph = panels.map((p) => p.h);
    for (const panel of panels) {
      const wallSegs: UnitSeg[] = [];
      const bridgeSegs: UnitSeg[] = [];
      for (const c of cellsOnLayer(topo, panel.layer)) {
        const info = topo.cell(c);
        if (info.panel !== panel.id) continue;
        for (const s of SIDES) {
          const nb = topo.side(c, s);
          const seg = wallSegment(info, s);
          if (nb === null) { wallSegs.push(seg); continue; }
          const e = maze.edges.get(edgeKey(c, nb));
          // walls on a shared panel edge are listed on both panels (each cell sees its own side)
          if (!e) wallSegs.push(seg);
          else if (e.kind === 'tunnel') bridgeSegs.push(seg);
        }
      }
      const push = (segs: UnitSeg[], bridge: boolean) => {
        for (const r of mergeRuns(segs)) {
          this.runs[panel.id]!.push({ u0: Math.min(r.from[0], r.to[0]), u1: Math.max(r.from[0], r.to[0]), v0: Math.min(r.from[1], r.to[1]), v1: Math.max(r.from[1], r.to[1]), bridge });
        }
      };
      push(wallSegs, false);
      push(bridgeSegs, true);
    }
    const hole = (c: CellId, kind: 'trap' | 'goal') => {
      const i = topo.cell(c);
      this.holes[i.panel]!.push({ cell: c, kind, panel: i.panel, u: i.u + 0.5, v: i.v + 0.5 });
    };
    for (const c of maze.traps) hole(c, 'trap');
    hole(maze.goal, 'goal');
    this.state = { panel: 0, u: 0, v: 0, vu: 0, vv: 0, h: this.ballR, vh: 0, cell: null, phase: 'rolling', phaseT: 0, hole: null, elapsed: 0, traps: 0 };
    this.reset();
  }

  reset(): void {
    const s = this.state, i = this.topo.cell(this.maze.start);
    s.panel = i.panel; s.u = i.u + 0.5; s.v = i.v + 0.5;
    s.vu = s.vv = 0; s.h = this.ballR; s.vh = 0;
    s.phase = 'rolling'; s.phaseT = 0; s.hole = null; s.cell = this.maze.start;
    this.acc = 0;
  }

  /** Ball centre in object coordinates (mm). */
  ballPoint(): Vec3 {
    const s = this.state;
    return this.surface.point(s.panel, s.u, s.v, s.h);
  }

  /** Floor normal under the ball (object frame, pointing toward the ball). */
  ballNormal(): Vec3 {
    const s = this.state;
    return this.surface.frame(s.panel, s.u, s.v).n;
  }

  step(dt: number): SimEvent[] {
    const events: SimEvent[] = [];
    this.acc += Math.min(dt, 0.05);
    while (this.acc > 0) {
      const speed = Math.hypot(this.state.vu, this.state.vv);
      const h = Math.min(this.acc, 1 / 240, (0.4 * this.phys.wallT) / Math.max(speed, 1));
      this.substep(h, events);
      this.acc -= h;
    }
    return events;
  }

  private substep(h: number, events: SimEvent[]): void {
    const s = this.state, p = this.params;
    s.elapsed += h; s.phaseT += h;
    switch (s.phase) {
      case 'rolling': this.roll(h, events); break;
      case 'falling': this.fall(h, events); break;
      case 'lost': if (s.phaseT >= p.lostDelay) { this.reset(); events.push('reset'); } break;
      case 'won': break;
    }
  }

  private roll(h: number, events: SimEvent[]): void {
    const s = this.state, p = this.params, r = this.ballR;
    const f = this.surface.frame(s.panel, s.u, s.v);
    const [pu, pv] = this.surface.metric(s.panel, s.u, s.v, r);
    // tangential gravity in the object frame
    const gn = dot3(this.gDir, f.n);
    const gt: Vec3 = [this.gDir[0] - gn * f.n[0], this.gDir[1] - gn * f.n[1], this.gDir[2] - gn * f.n[2]];
    let au = p.rollFactor * p.g * dot3(gt, f.tu);
    let av = p.rollFactor * p.g * dot3(gt, f.tv);

    for (const hole of this.holes[s.panel]!) {
      const dx = (hole.u - s.u) * pu, dy = (hole.v - s.v) * pv;
      const d = Math.hypot(dx, dy);
      const hr = this.phys.holeDia / 2;
      if (d >= hr + r * 0.5) continue;
      if (d < hr - r * p.holeGrab) {
        s.phase = 'falling'; s.phaseT = 0; s.hole = hole; s.vh = 0;
        s.vu *= 0.5; s.vv *= 0.5;
        return;
      }
      const k = (1 - d / (hr + r * 0.5)) * p.g * 0.6;
      if (d > 1e-6) { au += (dx / d) * k; av += (dy / d) * k; }
    }

    s.vu += au * h; s.vv += av * h;
    const sp = Math.hypot(s.vu, s.vv);
    if (sp > 0) {
      const drop = Math.min(sp, p.rollRes * h + sp * p.damping * h);
      const fct = (sp - drop) / sp;
      s.vu *= fct; s.vv *= fct;
    }
    const sp2 = Math.hypot(s.vu, s.vv);
    if (sp2 > p.maxSpeed) { s.vu *= p.maxSpeed / sp2; s.vv *= p.maxSpeed / sp2; }
    s.u += (s.vu / pu) * h; s.v += (s.vv / pv) * h;
    s.h = r;

    this.collide(pu, pv, events);
    this.cross(pu, pv);
    const cell = this.topo.cellAt(s.panel, Math.floor(s.u), Math.floor(s.v));
    if (cell !== null) s.cell = cell;
  }

  /** Circle (ball, mm) against the wall rectangles of the current panel, in the local affine metric. */
  private collide(pu: number, pv: number, events: SimEvent[]): void {
    const s = this.state, p = this.params, r = this.ballR, t = this.phys.wallT / 2;
    const offsets = this.wrap[s.panel] ? [0, -this.pw[s.panel]!, this.pw[s.panel]!] : [0];
    for (let pass = 0; pass < 2; pass++) {
      for (const run of this.runs[s.panel]!) {
        if (run.bridge && this.phys.bridgeLift >= s.h + r) continue; // the ball passes under
        for (const off of offsets) {
          const x = s.u * pu, y = s.v * pv;
          const x0 = (run.u0 + off) * pu - t, x1 = (run.u1 + off) * pu + t, y0 = run.v0 * pv - t, y1 = run.v1 * pv + t;
          const cx = Math.min(x1, Math.max(x0, x)), cy = Math.min(y1, Math.max(y0, y));
          let nx = x - cx, ny = y - cy;
          let d = Math.hypot(nx, ny);
          if (d >= r) continue;
          if (d < 1e-9) {
            const px = Math.min(x - x0, x1 - x), py = Math.min(y - y0, y1 - y);
            if (px < py) { nx = x - x0 < x1 - x ? -1 : 1; ny = 0; } else { nx = 0; ny = y - y0 < y1 - y ? -1 : 1; }
            d = 0;
          } else { nx /= d; ny /= d; }
          s.u = (x + nx * (r - d)) / pu; s.v = (y + ny * (r - d)) / pv;
          const vn = s.vu * nx + s.vv * ny;
          if (vn < 0) {
            const tx = s.vu - vn * nx, ty = s.vv - vn * ny;
            s.vu = tx * p.wallSlide - vn * p.restitution * nx;
            s.vv = ty * p.wallSlide - vn * p.restitution * ny;
            if (-vn > 60) events.push('bump');
          }
        }
      }
    }
  }

  /** Transfer to the neighbouring panel when the ball leaves this one (or wrap around). */
  private cross(pu: number, pv: number): void {
    const s = this.state;
    const w = this.pw[s.panel]!, hgt = this.ph[s.panel]!;
    if (this.wrap[s.panel]) {
      s.u = ((s.u % w) + w) % w;
      return;
    }
    const insU = this.surface.edgeInset / pu, insV = this.surface.edgeInset / pv;
    let cu = s.u, cv = s.v;
    if (s.u < insU) cu = s.u - 2 * insU;
    else if (s.u > w - insU) cu = s.u + 2 * insU;
    else if (s.v < insV) cv = s.v - 2 * insV;
    else if (s.v > hgt - insV) cv = s.v + 2 * insV;
    else return;
    const x = this.topo.crossPanel(s.panel, cu, cv);
    const pin = () => { s.u = Math.min(w - insU, Math.max(insU, s.u)); s.v = Math.min(hgt - insV, Math.max(insV, s.v)); };
    if (!x) { pin(); return; } // a real boundary: keep the ball inside (outer walls normally prevent this)
    const vu = x.m[0] * s.vu + x.m[1] * s.vv, vv = x.m[2] * s.vu + x.m[3] * s.vv;
    if (this.surface.edgeInset > 0) {
      // concave corner: the ball rests against both faces until the new face slopes away from the
      // edge (or momentum carries it over). Otherwise it stays pinned on this face.
      const out: Vec3 = [cu < 0 ? -1 : cu > w ? 1 : 0, cv < 0 ? -1 : cv > hgt ? 1 : 0, 0];
      const du = x.m[0] * out[0] + x.m[1] * out[1], dv = x.m[2] * out[0] + x.m[3] * out[1];
      const f = this.surface.frame(x.panel, x.u, x.v);
      const gn = dot3(this.gDir, f.n);
      const gt: Vec3 = [this.gDir[0] - gn * f.n[0], this.gDir[1] - gn * f.n[1], this.gDir[2] - gn * f.n[2]];
      const away: Vec3 = norm3([du * f.tu[0] + dv * f.tv[0], du * f.tu[1] + dv * f.tv[1], du * f.tu[2] + dv * f.tv[2]]);
      const aInto = dot3(gt, away);
      const vInto = vu * du + vv * dv;
      if (aInto <= 0 && vInto < 50) {
        pin();
        // kill the velocity component pushing into the corner
        const into = s.vu * out[0] + s.vv * out[1];
        if (into > 0) { s.vu -= into * out[0]; s.vv -= into * out[1]; }
        return;
      }
    }
    const loss = this.surface.edgeInset > 0 ? 0.75 : 1; // concave corner impact
    s.panel = x.panel; s.u = x.u; s.v = x.v; s.vu = vu * loss; s.vv = vv * loss;
    const w2 = this.pw[s.panel]!, h2 = this.ph[s.panel]!;
    const [pu2, pv2] = this.surface.metric(s.panel, s.u, s.v, this.ballR);
    const iu = this.surface.edgeInset / pu2, iv = this.surface.edgeInset / pv2;
    s.u = Math.min(w2 - iu, Math.max(iu, s.u)); s.v = Math.min(h2 - iv, Math.max(iv, s.v));
  }

  private fall(h: number, events: SimEvent[]): void {
    const s = this.state, p = this.params, hole = s.hole!;
    const k = Math.min(1, 12 * h);
    s.u += (hole.u - s.u) * k; s.v += (hole.v - s.v) * k;
    s.vu *= 1 - k; s.vv *= 1 - k;
    s.vh -= p.g * h;
    s.h += s.vh * h;
    if (s.h < -(this.phys.floorT + this.ballR * 4)) {
      s.vh = 0;
      if (hole.kind === 'goal') { s.phase = 'won'; s.phaseT = 0; events.push('goal'); }
      else { s.phase = 'lost'; s.phaseT = 0; s.traps += 1; events.push('trap'); }
    }
  }
}

/**
 * Rotates the object so the floor under the ball slopes the way the player asks. `R` maps object
 * coordinates to world (gravity is world −z). Inputs are a horizontal world direction and a tilt angle.
 */
export class ShellController {
  R: Quat = QUAT_ID;

  constructor(readonly sim: ShellSim, public maxRate = (150 * Math.PI) / 180) {
    this.sync();
  }

  /** Initial pose: put the ball's current floor at the bottom. */
  sync(): void {
    const n = quatRotate(this.R, this.sim.ballNormal());
    this.R = quatNormalize(quatMul(quatBetween(n, [0, 0, 1]), this.R));
    this.sim.gDir = quatRotate(quatConj(this.R), [0, 0, -1]);
  }

  /** Free rotation about a world axis (manual control: the player turns the object). */
  rotate(axisWorld: Vec3, angle: number): void {
    if (Math.abs(angle) < 1e-12) return;
    this.R = quatNormalize(quatMul(quatAxisAngle(axisWorld, angle), this.R));
    this.sim.gDir = quatRotate(quatConj(this.R), [0, 0, -1]);
  }

  /**
   * Steer: rotate so that the object-frame normal `nRef` (the floor the ball should be on) ends up
   * pointing up, tilted by `theta` toward horizontal world direction `d` (zero = level), at most maxRate·dt.
   */
  steer(nRef: Vec3, d: Vec3, theta: number, dt: number): void {
    const up: Vec3 = [0, 0, 1];
    const dl = Math.hypot(d[0], d[1], d[2]);
    const target: Vec3 = dl > 1e-9 ? norm3([Math.sin(theta) * d[0] / dl, Math.sin(theta) * d[1] / dl, Math.cos(theta)]) : up;
    const n = quatRotate(this.R, nRef);
    const q = quatBetween(n, target, this.maxRate * dt);
    this.R = quatNormalize(quatMul(q, this.R));
    this.sim.gDir = quatRotate(quatConj(this.R), [0, 0, -1]);
  }

  /** Convenience for tests and simple drivers: steer relative to the ball's current floor. */
  step(d: Vec3, theta: number, dt: number): void {
    this.steer(this.sim.ballNormal(), d, theta, dt);
  }
}
