import type { CellId } from '../../model/ids';
import { edgeKey } from '../../model/ids';
import type { Maze } from '../../model/maze';
import { makeEdge } from '../../model/maze';
import { SIDES, allCells, opposite } from '../../model/topology';
import type { Side } from '../../model/topology';
import { withEdge } from '../../model/ops';
import { bfs, graphOf } from '../../graph/index';
import { solve } from '../../graph/solve';
import type { GenContext } from '../context';

/** Would opening a<->b (lateral, side s from a) create a fully open 2x2 room? */
function makesRoom(m: Maze, ctx: GenContext, a: CellId, s: Side): boolean {
  const t = ctx.topo;
  const b = t.side(a, s)!;
  const open = (x: CellId, y: CellId) => m.edges.has(edgeKey(x, y)) || (x === a && y === b) || (x === b && y === a);
  for (const perp of [((s + 1) % 4) as Side, ((s + 3) % 4) as Side]) {
    const a2 = t.side(a, perp), b2 = t.side(b, perp);
    if (a2 === null || b2 === null) continue;
    if (open(a, a2) && open(b, b2) && open(a2, b2)) return true;
  }
  return false;
}

/**
 * Stage 7: open a fraction of dead ends into loops. Loops remove the "just follow the wall" strategy.
 * The partner wall is chosen to make the longest loop; anything that shortens the solution or creates
 * a 2x2 room is rejected.
 */
export function braid(ctx: GenContext, maze: Maze): Maze {
  const { topo, params } = ctx;
  if (params.braid <= 0) return maze;
  const rng = ctx.rng.fork('braid');
  let m = maze;
  const base = solve(m, topo);
  if (!base.solvable) return m;
  const deadEnds = allCells(topo).filter((c) => {
    const g = graphOf(m, topo.cellCount);
    return g.incident[c]!.filter((e) => e.kind === 'open' || e.kind === 'tunnel').length === 1 && !ctx.isLockedCell(c) && c !== m.start && c !== m.goal && !m.disabled.has(c) && !m.traps.has(c);
  });
  rng.shuffle(deadEnds);
  for (const c of deadEnds) {
    if (!rng.chance(params.braid)) continue;
    const g = graphOf(m, topo.cellCount);
    if (g.incident[c]!.length !== 1) continue; // may have changed
    const lateral = g.out.map((arr, x) => arr.filter((n) => topo.cell(n).layer === topo.cell(x as CellId).layer));
    const far = bfs(lateral, [c], topo.cellCount);
    let best: { nb: CellId; s: Side; d: number } | null = null;
    for (const s of SIDES) {
      const nb = topo.side(c, s);
      if (nb === null || m.disabled.has(nb) || m.traps.has(nb) || m.edges.has(edgeKey(c, nb)) || ctx.isLockedEdge(c, nb)) continue;
      if (makesRoom(m, ctx, c, s) || makesRoom(m, ctx, nb, opposite(s))) continue;
      const d = far[nb]! < 0 ? Number.MAX_SAFE_INTEGER : far[nb]!;
      if (!best || d > best.d) best = { nb, s, d };
    }
    if (!best) continue;
    const trial = withEdge(m, makeEdge(c, best.nb, 'open'));
    const ts = solve(trial, topo);
    if (!ts.solvable || ts.length < base.length || ts.stuckCells.length) continue;
    m = trial;
  }
  return m;
}
