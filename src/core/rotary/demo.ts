import type { Demo, RotaryMaze } from './model';

export interface DemoFrame {
  readonly x: number; readonly y: number;
  /** Dial angle, degrees. */
  readonly angle: number;
  readonly clicks: number;
  readonly wasted: number;
  readonly wrong: boolean;
  readonly text: string;
  readonly done: boolean;
}

interface Span { t0: number; t1: number; ev: Demo['events'][number]; len: number; cum: number[]; clicks: number; wasted: number }

/** Plays a recorded solution: the ball follows the recorded path, the dial turns when the recording says so. */
export class DemoPlayer {
  readonly duration: number;
  private readonly spans: Span[] = [];
  constructor(private readonly maze: RotaryMaze, readonly demo: Demo, ballSpeed = 75, dialDegPerS = 40) {
    let t = 0, clicks = 0, wasted = 0;
    for (const ev of demo.events) {
      let dur = 0, len = 0;
      const cum: number[] = [0];
      if (ev.t === 'move') {
        for (let i = 1; i < ev.pts.length; i++) {
          len += Math.hypot(ev.pts[i]![0] - ev.pts[i - 1]![0], ev.pts[i]![1] - ev.pts[i - 1]![1]);
          cum.push(len);
        }
        dur = len / ballSpeed;
      } else if (ev.t === 'turn') {
        dur = Math.abs(ev.k1 - ev.k0) * maze.detentDeg / dialDegPerS;
        clicks += Math.abs(ev.k1 - ev.k0);
        if (ev.wrong) wasted += Math.abs(ev.k1 - ev.k0);
      } else dur = ev.s;
      this.spans.push({ t0: t, t1: t + dur, ev, len, cum, clicks, wasted });
      t += dur;
    }
    this.duration = t;
  }

  sample(time: number): DemoFrame {
    const m = this.maze;
    let x = m.start[0], y = m.start[1], angle = 0, clicks = 0, wasted = 0, wrong = false, text = '';
    let seenK = false;
    for (const sp of this.spans) {
      const ev = sp.ev;
      const active = time < sp.t1;
      const f = sp.t1 > sp.t0 ? Math.max(0, Math.min(1, (time - sp.t0) / (sp.t1 - sp.t0))) : 1;
      if (ev.t === 'move') {
        if (!seenK) { angle = ev.k * m.detentDeg; seenK = true; }
        const want = f * sp.len;
        let i = 1;
        while (i < sp.cum.length - 1 && sp.cum[i]! < want) i++;
        const a = ev.pts[i - 1] ?? ev.pts[0]!, b = ev.pts[i] ?? a;
        const seg = (sp.cum[i] ?? 0) - (sp.cum[i - 1] ?? 0);
        const u = seg > 0 ? (want - sp.cum[i - 1]!) / seg : 1;
        x = a[0] + (b[0] - a[0]) * u; y = a[1] + (b[1] - a[1]) * u;
        angle = ev.k * m.detentDeg;
      } else if (ev.t === 'turn') {
        seenK = true;
        angle = (ev.k0 + (ev.k1 - ev.k0) * f) * m.detentDeg;
      } else if (active) text = ev.text;
      wrong = ev.wrong;
      if (active) return { x, y, angle, clicks, wasted, wrong, text, done: false };
      clicks = sp.clicks; wasted = sp.wasted;
    }
    return { x, y, angle, clicks, wasted, wrong: false, text: 'done', done: true };
  }
}
