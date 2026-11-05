import type { CellId } from '../model/ids';
import { edgeKey } from '../model/ids';
import type { Maze } from '../model/maze';
import type { Topology } from '../model/topology';
import type { Rng } from '../math/rng';
import type { GenParams } from './params';
import type { Diagnostic } from '../model/validate';

/** Shared, read-only context for every pipeline stage. */
export interface GenContext {
  readonly topo: Topology;
  readonly params: GenParams;
  readonly rng: Rng;
  readonly locked: ReadonlySet<CellId>;
  /** Cells whose start/goal position must not be changed. */
  readonly pinned: { readonly start: boolean; readonly goal: boolean };
  readonly diagnostics: Diagnostic[];
  isLockedCell(c: CellId): boolean;
  /** An edge is locked when both endpoints are locked (the "interior" of a locked region). */
  isLockedEdge(a: CellId, b: CellId): boolean;
}

export function makeContext(
  topo: Topology,
  params: GenParams,
  rng: Rng,
  locked: ReadonlySet<CellId>,
  pinned: { start: boolean; goal: boolean },
): GenContext {
  const lockedEdges = new Set<string>();
  return {
    topo,
    params,
    rng,
    locked,
    pinned,
    diagnostics: [],
    isLockedCell: (c) => locked.has(c),
    isLockedEdge: (a, b) => {
      const k = edgeKey(a, b);
      if (lockedEdges.has(k)) return true;
      const r = locked.has(a) && locked.has(b);
      if (r) lockedEdges.add(k);
      return r;
    },
  };
}

export type Stage = (ctx: GenContext, maze: Maze) => Maze;

/** Cells of a layer the generator may rewrite. */
export function freeCells(ctx: GenContext, cells: readonly CellId[]): CellId[] {
  return cells.filter((c) => !ctx.isLockedCell(c));
}
