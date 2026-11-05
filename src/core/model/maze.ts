import type { CellId, EdgeKey } from './ids';
import { edgeKey } from './ids';
import type { TopologySpec } from './topology';
import type { GenParams } from '../generate/params';

/**
 * Physical passage kinds. A wall is the absence of an edge.
 * - open:    plain passage between lateral neighbours.
 * - tunnel:  passage hidden under a lifted wall (bridge) or under a cell (`via`).
 * - dropout: one-way hole in the floor, `from` is the upper cell.
 * - ramp:    two-way vertical connection (user-placed only).
 */
export type EdgeKind = 'open' | 'tunnel' | 'dropout' | 'ramp';

export interface Edge {
  readonly a: CellId;
  readonly b: CellId;
  readonly kind: EdgeKind;
  /** Upper cell for one-way kinds. */
  readonly from?: CellId;
  /** Cells passed under (underpass tunnels). */
  readonly via?: readonly CellId[];
}

/** Immutable maze state. Every edit produces a new Maze; undo/redo is a list of states. */
export interface Maze {
  readonly formatVersion: 1;
  readonly topology: TopologySpec;
  readonly edges: ReadonlyMap<EdgeKey, Edge>;
  readonly start: CellId;
  readonly goal: CellId;
  /**
   * Trap holes: the ball falls out of play and must restart. Graph-wise a one-way arc to `start`.
   * In stacked mazes the column below a trap becomes a shaft (see `disabled`).
   */
  readonly traps: ReadonlySet<CellId>;
  /** Cells removed from play (vertical shafts under traps). They carry no passages. */
  readonly disabled: ReadonlySet<CellId>;
  /** Cells whose passages must be preserved by regeneration. */
  readonly locked: ReadonlySet<CellId>;
  readonly seed: string;
  readonly gen: GenParams;
}

export const isOneWay = (k: EdgeKind): boolean => k === 'dropout';

/** Directed arcs induced by an edge. */
export function arcs(e: Edge): ReadonlyArray<readonly [CellId, CellId]> {
  if (isOneWay(e.kind)) {
    const from = e.from ?? e.a;
    const to = from === e.a ? e.b : e.a;
    return [[from, to]];
  }
  return [[e.a, e.b], [e.b, e.a]];
}

export function makeEdge(a: CellId, b: CellId, kind: EdgeKind, extra: { from?: CellId; via?: readonly CellId[] } = {}): Edge {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const e: { -readonly [K in keyof Edge]: Edge[K] } = { a: lo, b: hi, kind };
  if (extra.from !== undefined) e.from = extra.from;
  if (extra.via && extra.via.length) e.via = extra.via;
  return e;
}

export function edgeBetween(m: Maze, a: CellId, b: CellId): Edge | undefined {
  return m.edges.get(edgeKey(a, b));
}

export function otherEnd(e: Edge, c: CellId): CellId {
  return e.a === c ? e.b : e.a;
}

export function emptyMaze(topology: TopologySpec, seed: string, gen: GenParams, start: CellId, goal: CellId): Maze {
  return { formatVersion: 1, topology, edges: new Map(), start, goal, traps: new Set(), disabled: new Set(), locked: new Set(), seed, gen };
}
