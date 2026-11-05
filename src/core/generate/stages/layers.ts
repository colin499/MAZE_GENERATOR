import type { CellId } from '../../model/ids';
import type { Maze } from '../../model/maze';
import { makeEdge } from '../../model/maze';
import { allCells, cellsOnLayer, lateralNeighbors } from '../../model/topology';
import { withEdge, withGoal, withTrap } from '../../model/ops';
import { bfs, graphOf } from '../../graph/index';
import type { GenContext } from '../context';
import { carveLayerTree } from './tree';

/**
 * Stage: build the maze layer by layer from the top (where the ball starts) down to the bottom.
 * For each layer: carve its tree, pick the TRUE exit (dropout to the layer below, or the goal on
 * the bottom layer) as far as possible from where the ball enters, then place TRAP holes close to
 * the late part of that layer's route. Traps need a free column below them (it becomes a shaft),
 * which is why lower layers are carved after the traps above them are known.
 */
export function carveLayers(ctx: GenContext, maze: Maze): Maze {
  const { topo, params } = ctx;
  const rng = ctx.rng.fork('layers');
  let m = maze;
  let entry: CellId = m.start;
  const top = topo.layerCount - 1;

  for (let layer = top; layer >= 0; layer--) {
    const lrng = rng.fork(`L${layer}`);
    const cells = cellsOnLayer(topo, layer);
    m = carveLayerTree(ctx, m, cells, lrng.fork('tree'), `layer ${layer}`);

    const g = graphOf(m, topo.cellCount);
    const dist = bfs(g.out, [entry], topo.cellCount);
    const isDeadEnd = (c: CellId) => g.out[c]!.length === 1;

    // --- exit of this layer -------------------------------------------------------------
    let exit: CellId;
    if (layer === 0) {
      if (ctx.pinned.goal) exit = m.goal;
      else {
        exit = pickFar(cells.filter((c) => c !== entry && dist[c]! >= 0 && topo.allowedGoal(c) && !ctx.isLockedCell(c) && !m.disabled.has(c)), dist, isDeadEnd, lrng.fork('goal'), ctx, 'goal');
        if (exit === entry) return m;
        m = withGoal(m, exit);
      }
    } else {
      const lockedDrop = [...m.edges.values()].find((e) => e.kind === 'dropout' && topo.cell(e.from ?? e.a).layer === layer && ctx.isLockedEdge(e.a, e.b));
      if (lockedDrop) exit = lockedDrop.from ?? lockedDrop.a;
      else {
        const free = cells.filter((c) => {
          const b = topo.below(c);
          return c !== entry && dist[c]! >= 0 && b !== null && !ctx.isLockedCell(c) && !m.disabled.has(c) && !m.disabled.has(b) && !m.traps.has(c) && !hasVertical(m, c);
        });
        exit = pickFar(free, dist, isDeadEnd, lrng.fork('exit'), ctx, `layer ${layer} exit`);
        if (exit === entry) return m;
        m = withEdge(m, makeEdge(exit, topo.below(exit)!, 'dropout', { from: exit }));
      }
    }

    // --- traps near the late part of this layer's route ---------------------------------------
    if (params.trapsPerLayer > 0) {
      const parent = new Int32Array(topo.cellCount).fill(-1);
      bfs(g.out, [entry], topo.cellCount, parent);
      const route: CellId[] = [];
      for (let c = exit as number; c !== -1; c = parent[c]!) route.push(c as CellId);
      route.reverse();
      const onRoute = new Map<CellId, number>();
      route.forEach((c, i) => onRoute.set(c, i));
      const lateral = g.out.map((arr, c) => arr.filter((n) => topo.cell(n).layer === topo.cell(c as CellId).layer));
      const near = bfs(lateral, route, topo.cellCount);
      const trng = lrng.fork('traps');
      const scored: { c: CellId; w: number }[] = [];
      for (const c of cells) {
        if (onRoute.has(c) || c === m.start || c === m.goal || m.traps.has(c) || m.disabled.has(c) || ctx.isLockedCell(c)) continue;
        // a trap must be a dead end: the ball cannot pass through it, so a corridor trap would cut the maze
        if (near[c]! < 1 || near[c]! > params.trapRadius || hasVertical(m, c) || !isDeadEnd(c)) continue;
        // the shaft column below must be free of everything that matters
        let columnOk = true;
        for (let b = topo.below(c); b !== null; b = topo.below(b)) {
          if (ctx.isLockedCell(b) || b === m.start || b === m.goal || m.traps.has(b) || hasVertical(m, b)) { columnOk = false; break; }
        }
        if (!columnOk) continue;
        let late = 0;
        for (const n of lateralNeighbors(topo, c)) {
          const i = onRoute.get(n);
          if (i !== undefined) late = Math.max(late, (i + 1) / route.length);
        }
        // weight: late along the route, close to it, and sitting at a dead-end tip (looks like "the way")
        const w = (0.2 + late) * (1 / near[c]!) + trng.next() * 0.05;
        scored.push({ c, w });
      }
      scored.sort((a, b) => b.w - a.w);
      let placed = 0;
      const taken: CellId[] = [];
      for (const { c } of scored) {
        if (placed >= params.trapsPerLayer) break;
        // keep traps apart so they do not cluster on one branch
        if (taken.some((t2) => lateralNeighbors(topo, c).includes(t2))) continue;
        m = withTrap(m, topo, c, true);
        taken.push(c);
        placed++;
      }
    }

    entry = layer === 0 ? exit : topo.below(exit)!;
  }
  return m;
}

function hasVertical(m: Maze, c: CellId): boolean {
  for (const e of m.edges.values()) if ((e.kind === 'dropout' || e.kind === 'ramp') && (e.a === c || e.b === c)) return true;
  return false;
}

function pickFar(
  cands: readonly CellId[],
  dist: Int32Array,
  isDeadEnd: (c: CellId) => boolean,
  rng: { pick<T>(a: readonly T[]): T },
  ctx: GenContext,
  what: string,
): CellId {
  if (!cands.length) {
    ctx.diagnostics.push({ level: 'error', code: 'no-exit-site', message: `no free cell available for the ${what}` });
    return allCells(ctx.topo)[0]!;
  }
  const sorted = [...cands].sort((a, b) => dist[b]! - dist[a]!);
  const top = sorted.slice(0, Math.max(3, Math.ceil(sorted.length * 0.1)));
  const deadEnds = top.filter(isDeadEnd);
  return rng.pick(deadEnds.length ? deadEnds : top);
}
