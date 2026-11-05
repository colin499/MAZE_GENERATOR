import type { CellId, EdgeKey } from '../model/ids';
import { cellId, edgeKey } from '../model/ids';
import type { Edge, EdgeKind, Maze } from '../model/maze';
import { makeEdge } from '../model/maze';
import type { TopologySpec } from '../model/topology';
import { normalizeGenParams } from '../generate/params';
import type { GenParams } from '../generate/params';

/** On-disk shape. Only non-wall edges are stored; cells are implied by the topology spec. */
export interface MazeFileV1 {
  readonly formatVersion: 1;
  readonly topology: TopologySpec;
  readonly seed: string;
  readonly gen: GenParams;
  readonly start: number;
  readonly goal: number;
  readonly traps: readonly number[];
  readonly disabled: readonly number[];
  readonly locked: readonly number[];
  /** [a, b, kind, from?, via?] */
  readonly edges: readonly (readonly [number, number, EdgeKind] | readonly [number, number, EdgeKind, number | null] | readonly [number, number, EdgeKind, number | null, readonly number[]])[];
}

export function encodeMaze(m: Maze): MazeFileV1 {
  const edges = [...m.edges.values()]
    .sort((x, y) => x.a - y.a || x.b - y.b)
    .map((e): MazeFileV1['edges'][number] => {
      if (e.via && e.via.length) return [e.a, e.b, e.kind, e.from ?? null, [...e.via]];
      if (e.from !== undefined) return [e.a, e.b, e.kind, e.from];
      return [e.a, e.b, e.kind];
    });
  return {
    formatVersion: 1,
    topology: m.topology,
    seed: m.seed,
    gen: m.gen,
    start: m.start,
    goal: m.goal,
    traps: [...m.traps].sort((a, b) => a - b),
    disabled: [...m.disabled].sort((a, b) => a - b),
    locked: [...m.locked].sort((a, b) => a - b),
    edges,
  };
}

const KINDS: readonly EdgeKind[] = ['open', 'tunnel', 'dropout', 'ramp'];

function isSpec(x: unknown): x is TopologySpec {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  switch (o['kind']) {
    case 'flat': return typeof o['w'] === 'number' && typeof o['h'] === 'number';
    case 'stacked': return typeof o['w'] === 'number' && typeof o['h'] === 'number' && typeof o['layers'] === 'number';
    case 'cube': return typeof o['n'] === 'number';
    case 'cylinder': return typeof o['around'] === 'number' && typeof o['along'] === 'number';
    default: return false;
  }
}

export function decodeMaze(input: unknown): Maze {
  if (!input || typeof input !== 'object') throw new Error('maze file: not an object');
  const f = input as Record<string, unknown>;
  if (f['formatVersion'] !== 1) throw new Error(`maze file: unsupported formatVersion ${String(f['formatVersion'])}`);
  if (!isSpec(f['topology'])) throw new Error('maze file: bad topology');
  const num = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`maze file: bad ${what}`);
    return v;
  };
  const edges = new Map<EdgeKey, Edge>();
  if (!Array.isArray(f['edges'])) throw new Error('maze file: edges must be an array');
  for (const row of f['edges'] as unknown[]) {
    if (!Array.isArray(row) || row.length < 3) throw new Error('maze file: bad edge row');
    const a = cellId(num(row[0], 'edge cell')), b = cellId(num(row[1], 'edge cell'));
    const kind = row[2] as EdgeKind;
    if (!KINDS.includes(kind)) throw new Error(`maze file: bad edge kind ${String(row[2])}`);
    const extra: { from?: CellId; via?: CellId[] } = {};
    if (row.length > 3 && row[3] !== null && row[3] !== undefined) extra.from = cellId(num(row[3], 'edge from'));
    if (row.length > 4 && Array.isArray(row[4])) extra.via = (row[4] as unknown[]).map((v) => cellId(num(v, 'via cell')));
    const e = makeEdge(a, b, kind, extra);
    edges.set(edgeKey(e.a, e.b), e);
  }
  const cellSet = (key: string) => new Set<CellId>(Array.isArray(f[key]) ? (f[key] as unknown[]).map((v) => cellId(num(v, `${key} cell`))) : []);
  const locked = cellSet('locked');
  return {
    formatVersion: 1,
    topology: f['topology'],
    edges,
    start: cellId(num(f['start'], 'start')),
    goal: cellId(num(f['goal'], 'goal')),
    traps: cellSet('traps'),
    disabled: cellSet('disabled'),
    locked,
    seed: typeof f['seed'] === 'string' ? f['seed'] : '',
    gen: normalizeGenParams(f['gen'] as Partial<GenParams> | undefined),
  };
}

export const mazeToJson = (m: Maze): string => JSON.stringify(encodeMaze(m));
export const mazeFromJson = (s: string): Maze => decodeMaze(JSON.parse(s));
