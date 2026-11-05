import type { CellId } from '../../model/ids';
import { edgeKey } from '../../model/ids';
import type { Edge, Maze } from '../../model/maze';
import { makeEdge } from '../../model/maze';
import { SIDES, opposite } from '../../model/topology';
import type { Side } from '../../model/topology';
import { withEdges } from '../../model/ops';
import { UnionFind } from '../../graph/unionFind';
import type { Rng } from '../../math/rng';
import type { GenContext } from '../context';

/**
 * Carve a spanning tree over `cells` (one layer) using lateral adjacency.
 * Growing tree with newest-biased selection (long corridors, deep dead ends), honouring locked
 * cells/edges and skipping disabled cells, followed by a Kruskal pass that joins remaining pockets
 * so the layer is connected. Reports a 'sealed-region' diagnostic if that is impossible.
 */
export function carveLayerTree(ctx: GenContext, maze: Maze, cells: readonly CellId[], rng: Rng, label: string): Maze {
  const { topo, params } = ctx;
  const added: Edge[] = [];
  const existing = new Set(maze.edges.keys());
  const passable = (a: CellId, b: CellId) => existing.has(edgeKey(a, b));
  const usable = (c: CellId) => !maze.disabled.has(c);
  // existing traps are dead ends by construction and must stay that way
  const sealed = (c: CellId) => maze.traps.has(c);
  const live = cells.filter(usable);
  const liveSet = new Set(live);

  const visited = new Set<CellId>();
  for (const c of live) if (ctx.isLockedCell(c) || sealed(c)) visited.add(c);

  const unvisited = () => live.filter((c) => !visited.has(c));
  let pool = unvisited();
  while (pool.length) {
    const seed = rng.pick(pool);
    visited.add(seed);
    const active: { cell: CellId; from: Side | null }[] = [{ cell: seed, from: null }];
    while (active.length) {
      const idx = rng.chance(params.newestBias) ? active.length - 1 : rng.int(active.length);
      const cur = active[idx]!;
      const options: { nb: CellId; side: Side }[] = [];
      for (const s of SIDES) {
        const nb = topo.side(cur.cell, s);
        if (nb !== null && liveSet.has(nb) && !visited.has(nb) && !sealed(nb) && !ctx.isLockedEdge(cur.cell, nb)) options.push({ nb, side: s });
      }
      if (!options.length) {
        active.splice(idx, 1);
        continue;
      }
      let choice: { nb: CellId; side: Side } | undefined;
      if (cur.from !== null && params.straightBias > 0 && rng.chance(params.straightBias)) {
        const ahead = opposite(cur.from);
        choice = options.find((o) => o.side === ahead);
      }
      choice ??= rng.pick(options);
      visited.add(choice.nb);
      const e = makeEdge(cur.cell, choice.nb, 'open');
      added.push(e);
      existing.add(edgeKey(e.a, e.b));
      active.push({ cell: choice.nb, from: opposite(choice.side) });
    }
    pool = unvisited();
  }

  // Kruskal finish: connect separate trees (pockets around locked regions) through unlocked walls.
  const uf = new UnionFind(topo.cellCount);
  for (const c of live) {
    for (const s of SIDES) {
      const nb = topo.side(c, s);
      if (nb !== null && liveSet.has(nb) && passable(c, nb)) uf.union(c, nb);
    }
  }
  const walls: [CellId, CellId][] = [];
  for (const c of live) {
    for (const s of SIDES) {
      const nb = topo.side(c, s);
      if (nb !== null && nb > c && liveSet.has(nb) && !passable(c, nb) && !sealed(c) && !sealed(nb) && !ctx.isLockedEdge(c, nb)) walls.push([c, nb]);
    }
  }
  rng.shuffle(walls);
  for (const [a, b] of walls) {
    if (uf.union(a, b)) {
      const e = makeEdge(a, b, 'open');
      added.push(e);
      existing.add(edgeKey(e.a, e.b));
    }
  }
  if (live.length) {
    const root = uf.find(live[0]!);
    const stranded = live.filter((c) => uf.find(c) !== root);
    if (stranded.length) {
      ctx.diagnostics.push({
        level: 'error',
        code: 'sealed-region',
        message: `${label}: locked cells seal off ${stranded.length} cell(s); unlock a boundary cell`,
        cells: stranded,
      });
    }
  }
  return withEdges(maze, added);
}
