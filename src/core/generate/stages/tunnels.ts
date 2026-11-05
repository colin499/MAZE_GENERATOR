import { edgeKey } from '../../model/ids';
import type { Maze } from '../../model/maze';
import { makeEdge } from '../../model/maze';
import { sideTo } from '../../model/topology';
import { withEdge } from '../../model/ops';
import { solve } from '../../graph/solve';
import type { GenContext } from '../context';

/**
 * Stage 6 (bridges): hide solution-path passages under a lifted wall. From above the corridor looks
 * closed; the ball rolls under. Straight continuations are preferred because a wall that "ends" a
 * straight corridor is the most convincing dead end. Graph connectivity is unchanged.
 */
export function carveBridges(ctx: GenContext, maze: Maze): Maze {
  const { topo, params } = ctx;
  if (params.bridges === 0) return maze;
  const rng = ctx.rng.fork('bridges');
  const sol = solve(maze, topo);
  if (!sol.path || sol.path.length < 4) return maze;
  const path = sol.path;
  const candidates: { i: number; weight: number }[] = [];
  for (let i = 1; i < path.length - 2; i++) {
    const a = path[i]!, b = path[i + 1]!, prev = path[i - 1]!;
    const sAB = sideTo(topo, a, b);
    const sPA = sideTo(topo, prev, a);
    if (sAB === null || sPA === null) continue; // vertical move involved
    const e = maze.edges.get(edgeKey(a, b));
    if (!e || e.kind !== 'open' || ctx.isLockedEdge(a, b)) continue;
    const straight = sAB === sPA ? 2 : 1;
    candidates.push({ i, weight: straight * (0.5 + i / path.length) });
  }
  let m = maze;
  const used = new Set<number>();
  for (let k = 0; k < params.bridges && candidates.length; k++) {
    // weighted pick, then forbid neighbours so bridges don't cluster
    const total = candidates.reduce((s, c) => s + c.weight, 0);
    let r = rng.next() * total;
    let chosen = candidates[candidates.length - 1]!;
    for (const c of candidates) { r -= c.weight; if (r <= 0) { chosen = c; break; } }
    const a = path[chosen.i]!, b = path[chosen.i + 1]!;
    m = withEdge(m, makeEdge(a, b, 'tunnel'));
    used.add(chosen.i);
    for (let j = candidates.length - 1; j >= 0; j--) if (Math.abs(candidates[j]!.i - chosen.i) <= 1) candidates.splice(j, 1);
  }
  return m;
}
