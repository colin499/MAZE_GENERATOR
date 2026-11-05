import type { CellId } from '../model/ids';
import type { Maze } from '../model/maze';
import type { Topology } from '../model/topology';
import { bfs, graphOf } from './index';

export interface Solution {
  /** Directed distance from start; -1 unreachable. */
  readonly distFromStart: Int32Array;
  /** Directed distance to goal; -1 cannot reach goal. */
  readonly distToGoal: Int32Array;
  /** Shortest start→goal path (cells, inclusive), or null. */
  readonly path: readonly CellId[] | null;
  readonly length: number;
  readonly solvable: boolean;
  /** Reachable from start but unable to reach the goal (liveness violations). */
  readonly stuckCells: readonly CellId[];
  /** Not reachable from start at all. */
  readonly unreachableCells: readonly CellId[];
}

const memo = new WeakMap<Maze, Solution>();

export function solve(m: Maze, t: Topology): Solution {
  const hit = memo.get(m);
  if (hit) return hit;
  const n = t.cellCount;
  const g = graphOf(m, n);
  const parent = new Int32Array(n).fill(-1);
  const distFromStart = bfs(g.out, [m.start], n, parent);
  const distToGoal = bfs(g.inn, [m.goal], n);
  const solvable = distFromStart[m.goal]! >= 0;
  let path: CellId[] | null = null;
  if (solvable) {
    path = [];
    for (let c = m.goal as number; c !== -1; c = parent[c]!) path.push(c as CellId);
    path.reverse();
  }
  const stuckCells: CellId[] = [];
  const unreachableCells: CellId[] = [];
  for (let c = 0; c < n; c++) {
    if (distFromStart[c] === -1) unreachableCells.push(c as CellId);
    else if (distToGoal[c] === -1) stuckCells.push(c as CellId);
  }
  const s: Solution = {
    distFromStart,
    distToGoal,
    path,
    length: path ? path.length - 1 : -1,
    solvable,
    stuckCells,
    unreachableCells,
  };
  memo.set(m, s);
  return s;
}
