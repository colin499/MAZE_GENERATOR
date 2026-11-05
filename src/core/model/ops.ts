import type { CellId } from './ids';
import { edgeKey } from './ids';
import type { Edge, EdgeKind, Maze } from './maze';
import { makeEdge } from './maze';
import type { Topology } from './topology';
import { relation, upperOf } from './topology';

/** Pure edit operations. Each returns a new Maze (structural sharing of untouched maps). */

export function withEdge(m: Maze, e: Edge): Maze {
  const edges = new Map(m.edges);
  edges.set(edgeKey(e.a, e.b), e);
  return { ...m, edges };
}

export function withEdges(m: Maze, es: Iterable<Edge>): Maze {
  const edges = new Map(m.edges);
  for (const e of es) edges.set(edgeKey(e.a, e.b), e);
  return { ...m, edges };
}

export function withoutEdge(m: Maze, a: CellId, b: CellId): Maze {
  const k = edgeKey(a, b);
  if (!m.edges.has(k)) return m;
  const edges = new Map(m.edges);
  edges.delete(k);
  return { ...m, edges };
}

/**
 * Set the passage between two neighbouring cells. `kind: null` restores the wall.
 * Lateral pairs accept open/tunnel; vertical pairs accept dropout (one-way, from the upper cell) or ramp.
 */
export function setPassage(m: Maze, t: Topology, a: CellId, b: CellId, kind: EdgeKind | null): Maze {
  if (kind === null) return withoutEdge(m, a, b);
  const rel = relation(t, a, b);
  if (rel === 'lateral') {
    if (kind !== 'open' && kind !== 'tunnel') throw new Error(`kind '${kind}' is not valid between lateral neighbours`);
    return withEdge(m, makeEdge(a, b, kind));
  }
  if (rel === 'vertical') {
    if (kind !== 'dropout' && kind !== 'ramp') throw new Error(`kind '${kind}' is not valid between stacked cells`);
    const upper = upperOf(t, a, b)!;
    return withEdge(m, kind === 'dropout' ? makeEdge(a, b, kind, { from: upper }) : makeEdge(a, b, kind));
  }
  throw new Error(`cells ${a} and ${b} are not neighbours`);
}

/** Toggle wall <-> default passage (open laterally, dropout vertically). */
export function togglePassage(m: Maze, t: Topology, a: CellId, b: CellId): Maze {
  if (m.edges.has(edgeKey(a, b))) return withoutEdge(m, a, b);
  const rel = relation(t, a, b);
  return setPassage(m, t, a, b, rel === 'lateral' ? 'open' : 'dropout');
}

export function withStart(m: Maze, start: CellId): Maze {
  return start === m.start ? m : { ...m, start };
}

export function withGoal(m: Maze, goal: CellId): Maze {
  return goal === m.goal ? m : { ...m, goal };
}

export function withLocked(m: Maze, cells: Iterable<CellId>, locked: boolean): Maze {
  const set = new Set(m.locked);
  for (const c of cells) {
    if (locked) set.add(c);
    else set.delete(c);
  }
  return { ...m, locked: set };
}

/** Set or clear a trap hole. In stacked topologies the column below becomes a shaft (disabled). */
export function withTrap(m: Maze, t: Topology, c: CellId, on: boolean): Maze {
  const traps = new Set(m.traps);
  const disabled = new Set(m.disabled);
  const column: CellId[] = [];
  for (let b = t.below(c); b !== null; b = t.below(b)) column.push(b);
  if (on) {
    traps.add(c);
    for (const b of column) disabled.add(b);
    let edges = m.edges;
    if (column.some((b) => [...m.edges.values()].some((e) => e.a === b || e.b === b))) {
      edges = new Map([...m.edges].filter(([, e]) => !column.includes(e.a) && !column.includes(e.b)));
    }
    return { ...m, traps, disabled, edges };
  }
  traps.delete(c);
  // free the shaft unless another trap above still needs it
  for (const b of column) {
    let stillNeeded = false;
    for (let a = t.above(b); a !== null; a = t.above(a)) if (traps.has(a)) stillNeeded = true;
    if (!stillNeeded) disabled.delete(b);
  }
  return { ...m, traps, disabled };
}

export function withSeed(m: Maze, seed: string): Maze {
  return { ...m, seed };
}
