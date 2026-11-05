import type { CellId } from '../../model/ids';
import type { Maze } from '../../model/maze';
import { allCells } from '../../model/topology';
import { withGoal, withStart } from '../../model/ops';
import { solve } from '../../graph/solve';
import type { GenContext } from '../context';

/** Choose the start cell unless pinned. */
export function placeStart(ctx: GenContext, maze: Maze): Maze {
  if (ctx.pinned.start) return maze;
  const rng = ctx.rng.fork('start');
  const candidates = allCells(ctx.topo).filter((c) => ctx.topo.allowedStart(c) && !ctx.isLockedCell(c) && !maze.disabled.has(c));
  const pool = candidates.length ? candidates : allCells(ctx.topo).filter((c) => ctx.topo.allowedStart(c));
  if (!pool.length) return maze;
  return withStart(maze, rng.pick(pool));
}

/** Final pass: move the goal to the farthest allowed cell if that is strictly longer. */
export function refineGoal(ctx: GenContext, maze: Maze): Maze {
  if (ctx.pinned.goal) return maze;
  const rng = ctx.rng.fork('refine-goal');
  const s = solve(maze, ctx.topo);
  if (!s.solvable) return maze;
  let best: CellId[] = [];
  let bestD = s.length;
  for (const c of allCells(ctx.topo)) {
    if (c === maze.start || c === maze.goal || !ctx.topo.allowedGoal(c) || ctx.isLockedCell(c) || maze.traps.has(c) || maze.disabled.has(c)) continue;
    const d = s.distFromStart[c]!;
    if (d > bestD) { bestD = d; best = [c]; } else if (d === bestD && d > s.length) best.push(c);
  }
  if (!best.length) return maze;
  const next = withGoal(maze, rng.pick(best));
  const ns = solve(next, ctx.topo);
  return ns.solvable && !ns.stuckCells.length ? next : maze;
}
