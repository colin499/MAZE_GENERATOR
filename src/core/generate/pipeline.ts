import type { CellId } from '../model/ids';
import { cellId, edgeKey } from '../model/ids';
import type { Maze } from '../model/maze';
import { emptyMaze } from '../model/maze';
import type { TopologySpec } from '../model/topology';
import { createTopology } from '../topology/registry';
import { Rng } from '../math/rng';
import type { Diagnostic } from '../model/validate';
import { validate } from '../model/validate';
import { makeContext } from './context';
import type { Stage } from './context';
import type { GenParams } from './params';
import { normalizeGenParams } from './params';
import { carveLayers } from './stages/layers';
import { placeStart, refineGoal } from './stages/endpoints';
import { carveBridges } from './stages/tunnels';
import { braid } from './stages/braid';

export interface GenerateOptions {
  readonly topology: TopologySpec;
  readonly seed: string;
  readonly params?: Partial<GenParams>;
  /**
   * Regeneration base: locked cells keep their passages, and start/goal are kept when they lie
   * inside the locked region (or when `pin` says so).
   */
  readonly base?: Maze;
  readonly pin?: { start?: boolean; goal?: boolean };
}

export interface GenerateResult {
  readonly maze: Maze;
  readonly diagnostics: readonly Diagnostic[];
}

const STAGES: readonly Stage[] = [placeStart, carveLayers, refineGoal, carveBridges, braid];

/** Run the full pipeline deterministically. */
export function generate(opts: GenerateOptions): GenerateResult {
  const topo = createTopology(opts.topology);
  const params = normalizeGenParams(opts.params);
  const rng = new Rng(`maze:${opts.seed}`);
  const base = opts.base;
  const locked: ReadonlySet<CellId> = base && base.topology === opts.topology ? base.locked : new Set();
  const pinned = {
    start: !!(opts.pin?.start || (base && locked.has(base.start))),
    goal: !!(opts.pin?.goal || (base && locked.has(base.goal))),
  };
  const ctx = makeContext(topo, params, rng, locked, pinned);

  let maze: Maze = emptyMaze(opts.topology, opts.seed, params, base?.start ?? cellId(0), base?.goal ?? cellId(topo.cellCount - 1));
  if (base) {
    // keep passages, traps and shafts of the locked interior
    const edges = new Map(maze.edges);
    for (const e of base.edges.values()) if (ctx.isLockedEdge(e.a, e.b)) edges.set(edgeKey(e.a, e.b), e);
    const traps = new Set([...base.traps].filter((c) => locked.has(c)));
    const disabled = new Set<CellId>();
    for (const c of traps) for (let b = topo.below(c); b !== null; b = topo.below(b)) disabled.add(b);
    maze = { ...maze, edges, traps, disabled, locked: new Set(locked) };
  }
  for (const stage of STAGES) maze = stage(ctx, maze);
  const diagnostics = [...ctx.diagnostics, ...validate(maze, topo)];
  return { maze, diagnostics };
}

/** Regenerate everything that is not locked, with a new seed. */
export function regenerate(base: Maze, seed: string, params?: Partial<GenParams>): GenerateResult {
  return generate({ topology: base.topology, seed, params: params ?? base.gen, base });
}
