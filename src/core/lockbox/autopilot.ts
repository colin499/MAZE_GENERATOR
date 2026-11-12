import type { LockBoxSim } from './sim';

export type LockBoxDemoKind = 'solve' | 'cheat';

export const LOCKBOX_DEMOS: readonly { readonly kind: LockBoxDemoKind; readonly name: string }[] = [
  { kind: 'solve', name: 'Solve the maze and open the box' },
  { kind: 'cheat', name: 'No ball in the goal: spin the cap and pull' },
];

const RAD = Math.PI / 180;

/**
 * Drives a LockBoxSim through its inputs only (tilt, cap turn, lift), the way a person would.
 * solve: roll the ball along the solution, turn the cap until the ball clicks into the ring, unlock, lift.
 * cheat: leave the ball on the start, spin the cap a full turn and pull: the lid stays on.
 * Call `update` before every sim.step.
 */
export class LockBoxAutopilot {
  text = '';
  done = false;
  private stage = 0;
  private wp = 1;
  private wait = 0;
  private turned = 0;
  private lastCap: number;

  constructor(private readonly sim: LockBoxSim, readonly kind: LockBoxDemoKind, private readonly maxTiltDeg = 10) {
    sim.resetAll();
    this.lastCap = sim.state.capA;
  }

  update(dt: number): void {
    const sim = this.sim, s = sim.state, b = sim.box;
    sim.tilt = { x: 0, y: 0 }; sim.turn = 0;
    this.turned += Math.abs(s.capA - this.lastCap); this.lastCap = s.capA;
    if (this.done) return;
    if (this.kind === 'cheat') {
      if (this.stage === 0) {
        this.text = 'Ball still on the start: the cap just spins, the ring does not move';
        sim.turn = 1;
        if (this.turned >= 300) { this.stage = 1; sim.lift(true); }
      } else if (this.stage === 1) {
        this.text = 'Pull the lid: locked';
        if (s.sinceLocked >= 0) { this.wait += dt; if (this.wait > 1.5) this.done = true; }
      }
      return;
    }
    if (this.stage === 0) {
      this.text = 'Roll the ball through the maze';
      if (s.phase !== 'maze') { this.stage = 1; return; }
      const path = b.path;
      while (this.wp < path.length - 1 && Math.hypot(path[this.wp]![0] - s.x, path[this.wp]![1] - s.y) < 1.3) this.wp++;
      const t = path[Math.min(this.wp, path.length - 1)] ?? b.goal;
      // steer in the cap frame, then express the tilt in the world frame
      const ux = (t[0] - s.x) * 1.2 - s.vx * 0.03, uy = (t[1] - s.y) * 1.2 - s.vy * 0.03;
      const k = Math.max(1, Math.hypot(ux, uy)), max = this.maxTiltDeg * RAD;
      const c = Math.cos(s.capA * RAD), sn = Math.sin(s.capA * RAD);
      sim.tilt = { x: ((ux * c - uy * sn) / k) * max, y: ((ux * sn + uy * c) / k) * max };
    } else if (this.stage === 1) {
      this.text = 'In the goal: turn the cap until the ball clicks into the ring';
      if (s.phase === 'clutch') { this.stage = 2; this.wait = 0; return; }
      sim.turn = 1;
    } else if (this.stage === 2) {
      this.text = 'Clutch engaged: the cap now turns the lock ring';
      this.wait += dt;
      if (this.wait > 0.6) sim.turn = 1;
      if (s.ringA >= b.openTurn - 1e-6) { this.stage = 3; this.wait = 0; }
    } else if (this.stage === 3) {
      this.text = 'Unlocked: lift the lid';
      this.wait += dt;
      if (this.wait > 0.5) sim.lift(true);
      if (s.open && s.lidZ >= sim.params.liftH - 1e-6) { this.stage = 4; this.wait = 0; }
    } else {
      this.text = 'Open';
      this.wait += dt;
      if (this.wait > 2) this.done = true;
    }
  }
}
