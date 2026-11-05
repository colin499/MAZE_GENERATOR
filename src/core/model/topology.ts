import type { CellId } from './ids';
import type { Frame, Vec2 } from '../math/vec';

/** Serialisable description of a topology; cells and adjacency are derived from it. */
export type TopologySpec =
  | { readonly kind: 'flat'; readonly w: number; readonly h: number }
  | { readonly kind: 'stacked'; readonly w: number; readonly h: number; readonly layers: number }
  | { readonly kind: 'cube'; readonly n: number }
  | { readonly kind: 'cylinder'; readonly around: number; readonly along: number };

export type TopologyKind = TopologySpec['kind'];

/** Lateral sides of a cell in panel coordinates: 0 = +u, 1 = +v, 2 = -u, 3 = -v. */
export type Side = 0 | 1 | 2 | 3;
export const SIDES: readonly Side[] = [0, 1, 2, 3];
export const SIDE_DELTA: readonly Vec2[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export const opposite = (s: Side): Side => ((s + 2) % 4) as Side;

export interface CellInfo {
  readonly panel: number;
  readonly u: number;
  readonly v: number;
  readonly layer: number;
}

export interface PanelInfo {
  readonly id: number;
  readonly w: number;
  readonly h: number;
  readonly layer: number;
}

/** The physical numbers a topology needs to place its panels in space (mm). */
export interface PanelMetrics {
  readonly pitch: number;
  readonly layerH: number;
}

/**
 * A topology is a stateless oracle: it enumerates cells, answers adjacency questions and
 * places its planar panels in 3D. Generators only use adjacency; renderers/planners use geometry.
 */
export interface Topology {
  readonly spec: TopologySpec;
  readonly cellCount: number;
  readonly layerCount: number;
  /** Whether a fixed "down" exists, i.e. whether one-way dropouts make physical sense. */
  readonly supportsGravity: boolean;
  cell(id: CellId): CellInfo;
  cellAt(panel: number, u: number, v: number): CellId | null;
  /** Lateral neighbour across a side, or null when that side is an outer boundary. */
  side(id: CellId, s: Side): CellId | null;
  below(id: CellId): CellId | null;
  above(id: CellId): CellId | null;
  panels(): readonly PanelInfo[];
  /** Placement of a panel's grid in mm: origin at grid corner (0,0); x, y are unit vectors along u, v. */
  panelFrame(panel: number, m: PanelMetrics): Frame;
  allowedStart(id: CellId): boolean;
  allowedGoal(id: CellId): boolean;
}

/** Grid-corner segment of the wall on `side` of a cell, in panel units. */
export function wallSegment(c: CellInfo, s: Side): readonly [Vec2, Vec2] {
  const { u, v } = c;
  switch (s) {
    case 0: return [[u + 1, v], [u + 1, v + 1]];
    case 1: return [[u, v + 1], [u + 1, v + 1]];
    case 2: return [[u, v], [u, v + 1]];
    case 3: return [[u, v], [u + 1, v]];
  }
}

export function lateralNeighbors(t: Topology, id: CellId): CellId[] {
  const out: CellId[] = [];
  for (const s of SIDES) {
    const n = t.side(id, s);
    if (n !== null) out.push(n);
  }
  return out;
}

/** Side of `a` that faces lateral neighbour `b`, or null when not lateral neighbours. */
export function sideTo(t: Topology, a: CellId, b: CellId): Side | null {
  for (const s of SIDES) if (t.side(a, s) === b) return s;
  return null;
}

export type Relation = 'lateral' | 'vertical' | 'none';
export function relation(t: Topology, a: CellId, b: CellId): Relation {
  if (sideTo(t, a, b) !== null) return 'lateral';
  if (t.below(a) === b || t.above(a) === b) return 'vertical';
  return 'none';
}

export function upperOf(t: Topology, a: CellId, b: CellId): CellId | null {
  if (t.below(a) === b) return a;
  if (t.below(b) === a) return b;
  return null;
}

export function allCells(t: Topology): CellId[] {
  return Array.from({ length: t.cellCount }, (_, i) => i as CellId);
}

export function cellsOnLayer(t: Topology, layer: number): CellId[] {
  return allCells(t).filter((c) => t.cell(c).layer === layer);
}

export function isBoundary(t: Topology, id: CellId): boolean {
  return SIDES.some((s) => t.side(id, s) === null);
}
