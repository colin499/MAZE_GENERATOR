import type { CellId } from '../model/ids';
import type { Edge, Maze } from '../model/maze';
import { arcs } from '../model/maze';

/** Directed adjacency derived from a maze's edges. Memoised per Maze instance. */
export interface MazeGraph {
  readonly n: number;
  readonly out: ReadonlyArray<readonly CellId[]>;
  readonly inn: ReadonlyArray<readonly CellId[]>;
  /** Undirected incident edges per cell. */
  readonly incident: ReadonlyArray<readonly Edge[]>;
}

const memo = new WeakMap<Maze, MazeGraph>();

export function graphOf(m: Maze, cellCount: number): MazeGraph {
  const hit = memo.get(m);
  if (hit && hit.n === cellCount) return hit;
  const out: CellId[][] = Array.from({ length: cellCount }, () => []);
  const inn: CellId[][] = Array.from({ length: cellCount }, () => []);
  const incident: Edge[][] = Array.from({ length: cellCount }, () => []);
  for (const e of m.edges.values()) {
    incident[e.a]!.push(e);
    incident[e.b]!.push(e);
    for (const [f, t] of arcs(e)) {
      if (m.traps.has(f)) continue; // the ball cannot leave a trap cell except by falling
      out[f]!.push(t);
      inn[t]!.push(f);
    }
  }
  for (const c of m.traps) {
    if (c === m.start) continue;
    out[c]!.push(m.start);
    inn[m.start]!.push(c);
  }
  const g: MazeGraph = { n: cellCount, out, inn, incident };
  memo.set(m, g);
  return g;
}

/** Multi-source BFS over an adjacency list; -1 = unreachable. */
export function bfs(adj: ReadonlyArray<readonly CellId[]>, sources: readonly CellId[], n: number, parent?: Int32Array): Int32Array {
  const dist = new Int32Array(n).fill(-1);
  const queue: CellId[] = [];
  for (const s of sources) {
    if (dist[s] === -1) {
      dist[s] = 0;
      if (parent) parent[s] = -1;
      queue.push(s);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    const d = dist[c]! + 1;
    for (const nb of adj[c]!) {
      if (dist[nb] === -1) {
        dist[nb] = d;
        if (parent) parent[nb] = c;
        queue.push(nb);
      }
    }
  }
  return dist;
}
