import type { CellId } from '../model/ids';
import type { Maze } from '../model/maze';
import type { Topology } from '../model/topology';
import { sideTo } from '../model/topology';
import { bfs, graphOf } from '../graph/index';
import { solve } from '../graph/solve';

export interface BranchInfo {
  /** Index along the solution path where the branch leaves it. */
  readonly attachIndex: number;
  readonly attach: CellId;
  readonly entry: CellId;
  /** Longest walk inside the branch from the attach cell (cells). */
  readonly depth: number;
  readonly size: number;
}

export interface DropoutInfo {
  readonly from: CellId;
  readonly to: CellId;
  readonly kind: 'dropout' | 'trap';
  /** Extra distance to the goal incurred by falling here (0 = on an optimal route). */
  readonly setback: number;
}

export interface StructuralMetrics {
  readonly cells: number;
  readonly reachable: number;
  readonly solutionLength: number;
  readonly coverage: number;
  readonly decisions: number;
  readonly turns: number;
  readonly branches: readonly BranchInfo[];
  readonly sumDepth: number;
  readonly maxDepth: number;
  readonly decoyNearGoal: number;
  readonly dropouts: readonly DropoutInfo[];
  readonly totalSetback: number;
  /** Reachable trap holes. */
  readonly traps: number;
  /** Traps adjacent to the solution path (one wrong move away). */
  readonly trapsOnRoute: number;
  readonly bridges: number;
  readonly loops: number;
  /** Per-cell depth of the dead-end branch containing the cell (0 on the solution path). */
  readonly branchDepthOf: Int32Array;
}

export function structuralMetrics(m: Maze, t: Topology): StructuralMetrics {
  const n = t.cellCount;
  const g = graphOf(m, n);
  const s = solve(m, t);
  const empty: StructuralMetrics = {
    cells: n, reachable: 0, solutionLength: -1, coverage: 0, decisions: 0, turns: 0, branches: [], sumDepth: 0, maxDepth: 0,
    decoyNearGoal: 0, dropouts: [], totalSetback: 0, traps: 0, trapsOnRoute: 0, bridges: 0, loops: 0, branchDepthOf: new Int32Array(n),
  };
  if (!s.path) return empty;
  const path = s.path;
  const onPath = new Int32Array(n).fill(-1);
  path.forEach((c, i) => (onPath[c] = i));
  const reachable = s.distFromStart.reduce((acc, d) => acc + (d >= 0 ? 1 : 0), 0);
  const playable = n - m.disabled.size;

  let decisions = 0;
  let turns = 0;
  const branches: BranchInfo[] = [];
  const branchDepthOf = new Int32Array(n);
  const claimed = new Uint8Array(n);
  for (let i = 0; i < path.length; i++) {
    const c = path[i]!;
    const exits = g.out[c]!.filter((x) => x !== path[i - 1] && x !== path[i + 1]);
    if (exits.length) decisions++;
    if (i > 0 && i < path.length - 1) {
      const a = sideTo(t, path[i - 1]!, c), b = sideTo(t, c, path[i + 1]!);
      if (a !== null && b !== null && a !== b) turns++;
    }
    for (const entry of exits) {
      if (onPath[entry]! >= 0 || claimed[entry]) continue;
      // explore the off-path region without re-entering the solution path
      const adj = g.out.map((arr) => arr.filter((x) => onPath[x]! < 0));
      const dist = bfs(adj, [entry], n);
      let depth = 0, size = 0;
      for (let x = 0; x < n; x++) if (dist[x]! >= 0) { size++; depth = Math.max(depth, dist[x]! + 1); claimed[x] = 1; }
      for (let x = 0; x < n; x++) if (dist[x]! >= 0) branchDepthOf[x] = Math.max(branchDepthOf[x]!, depth);
      branches.push({ attachIndex: i, attach: c, entry, depth, size });
    }
  }
  const sumDepth = branches.reduce((a, b) => a + b.depth, 0);
  const maxDepth = branches.reduce((a, b) => Math.max(a, b.depth), 0);
  const lateStart = 0.75 * (path.length - 1);
  const decoyNearGoal = branches.filter((b) => b.attachIndex >= lateStart).reduce((a, b) => Math.max(a, b.depth), 0);

  const dropouts: DropoutInfo[] = [];
  let bridges = 0;
  for (const e of m.edges.values()) {
    if (e.kind === 'tunnel') bridges++;
    if (e.kind !== 'dropout') continue;
    const from = e.from ?? e.a, to = from === e.a ? e.b : e.a;
    if (s.distFromStart[from]! < 0) continue;
    const setback = Math.max(0, s.distToGoal[to]! + 1 - s.distToGoal[from]!);
    dropouts.push({ from, to, kind: 'dropout', setback });
  }
  let trapsOnRoute = 0;
  for (const c of m.traps) {
    if (s.distFromStart[c]! < 0) continue;
    const setback = Math.max(0, s.distToGoal[m.start]! + 1 - s.distToGoal[c]!);
    dropouts.push({ from: c, to: m.start, kind: 'trap', setback });
    if (g.inn[c]!.some((p) => onPath[p]! >= 0)) trapsOnRoute++;
  }
  const totalSetback = dropouts.reduce((a, d) => a + d.setback, 0);
  const traps = dropouts.filter((d) => d.kind === 'trap').length;
  let undirected = 0;
  for (const e of m.edges.values()) if (s.distFromStart[e.a]! >= 0 || s.distFromStart[e.b]! >= 0) undirected++;
  const loops = Math.max(0, undirected - reachable + 1);

  return {
    cells: playable, reachable, solutionLength: path.length - 1, coverage: (path.length - 1) / playable, decisions, turns, branches, sumDepth, maxDepth,
    decoyNearGoal, dropouts, totalSetback, traps, trapsOnRoute, bridges, loops, branchDepthOf,
  };
}
