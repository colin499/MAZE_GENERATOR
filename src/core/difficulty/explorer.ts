import type { CellId } from '../model/ids';
import type { Maze } from '../model/maze';
import type { Topology } from '../model/topology';
import { bfs, graphOf } from '../graph/index';
import { Rng } from '../math/rng';

export interface ExplorerStats {
  readonly runs: number;
  readonly meanSteps: number;
  readonly medianSteps: number;
  readonly maxSteps: number;
  readonly meanRestarts: number;
  readonly failures: number;
}

export interface ExplorerOptions {
  readonly runs?: number;
  /** 0 = uniformly random exits; 1 = always take the exit that points most toward the goal. */
  readonly goalBias?: number;
  readonly seedLabel?: string;
}

/**
 * Simulated player with perfect memory. At a cell with unexplored exits it picks one (optionally
 * biased toward the goal's direction, like a human would); otherwise it walks the shortest known
 * route to the nearest cell that still has unexplored exits. Falling into a trap puts the ball back
 * at the start, from where the walk to the frontier is paid again. Steps are ball moves between cells.
 */
export function simulateExplorer(m: Maze, t: Topology, opts: ExplorerOptions = {}): ExplorerStats {
  const runs = opts.runs ?? 64;
  const goalBias = opts.goalBias ?? 0.5;
  const n = t.cellCount;
  const g = graphOf(m, n);
  const goalInfo = t.cell(m.goal);
  const dirScore = (from: CellId, to: CellId): number => {
    const a = t.cell(from), b = t.cell(to);
    const da = Math.hypot(a.u - goalInfo.u, a.v - goalInfo.v) + 2 * Math.abs(a.layer - goalInfo.layer);
    const db = Math.hypot(b.u - goalInfo.u, b.v - goalInfo.v) + 2 * Math.abs(b.layer - goalInfo.layer);
    return da - db; // positive when moving toward the goal
  };
  const results: number[] = [];
  const restartsPerRun: number[] = [];
  let failures = 0;
  const cap = n * 30;
  for (let r = 0; r < runs; r++) {
    const rng = new Rng(`${opts.seedLabel ?? 'explorer'}:${m.seed}:${r}`);
    const visited = new Uint8Array(n);
    visited[m.start] = 1;
    let cur: CellId = m.start;
    let steps = 0;
    let restarts = 0;
    let ok = false;
    while (steps < cap) {
      if (cur === m.goal) { ok = true; break; }
      if (m.traps.has(cur)) {
        // the ball falls out; back to the start, memory intact
        restarts++;
        steps++;
        cur = m.start;
        continue;
      }
      const exits = g.out[cur]!.filter((x) => !visited[x]);
      if (exits.length) {
        let next: CellId;
        if (exits.length > 1 && rng.chance(goalBias)) {
          let best = exits[0]!, bestS = -Infinity;
          for (const x of exits) { const sc = dirScore(cur, x) + rng.next() * 0.01; if (sc > bestS) { bestS = sc; best = x; } }
          next = best;
        } else next = rng.pick(exits);
        visited[next] = 1;
        steps++;
        cur = next;
        continue;
      }
      // walk through known cells (never into a known trap) to the nearest frontier cell
      const known = g.out.map((arr, c) => (visited[c] && !m.traps.has(c as CellId) ? arr.filter((x) => visited[x] && !m.traps.has(x)) : []));
      const dist = bfs(known, [cur], n);
      let target: CellId | null = null;
      let best = Infinity;
      for (let c = 0; c < n; c++) {
        if (dist[c]! < 0 || dist[c]! >= best) continue;
        if (!m.traps.has(c as CellId) && g.out[c]!.some((x) => !visited[x])) { best = dist[c]!; target = c as CellId; }
      }
      if (target === null) break;
      steps += best;
      cur = target;
    }
    if (!ok) failures++;
    results.push(steps);
    restartsPerRun.push(restarts);
  }
  results.sort((a, b) => a - b);
  return {
    runs,
    meanSteps: results.reduce((a, b) => a + b, 0) / runs,
    medianSteps: results[Math.floor(runs / 2)] ?? 0,
    maxSteps: results[runs - 1] ?? 0,
    meanRestarts: restartsPerRun.reduce((a, b) => a + b, 0) / runs,
    failures,
  };
}
