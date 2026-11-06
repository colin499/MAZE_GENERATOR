import type { CellId } from './ids';
import type { Frame, Vec2, Vec3 } from '../math/vec';

/** Serialisable description of a topology; cells and adjacency are derived from it. */
export type TopologySpec =
  | { readonly kind: 'flat'; readonly w: number; readonly h: number }
  | { readonly kind: 'stacked'; readonly w: number; readonly h: number; readonly layers: number }
  | { readonly kind: 'cube'; readonly n: number }
  | { readonly kind: 'sphere'; readonly n: number }
  | { readonly kind: 'cylinder'; readonly around: number; readonly along: number };

/** Topologies whose maze lies on the inside of a closed (or tube) shell; the player rotates the object. */
export const isShell = (k: TopologyKind): boolean => k === 'cube' || k === 'sphere' || k === 'cylinder';

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
  /** The u axis wraps around (cylinder). */
  readonly wrapU?: boolean;
}

/** Physical sizes a surface needs (mm); a subset of layout/PhysicalParams. */
export interface SurfaceParams {
  readonly chanW: number;
  readonly wallT: number;
  readonly floorT: number;
  readonly wallH: number;
  readonly ballDia: number;
  readonly tubeDia: number;
  readonly cubeSide: number;
  readonly sphereDia: number;
  readonly shellSide: 'outside' | 'inside';
}

export interface SurfaceFrame {
  /** Unit tangents along +u and +v, and the unit normal pointing from the floor toward the ball. */
  readonly tu: Vec3;
  readonly tv: Vec3;
  readonly n: Vec3;
}

/**
 * Geometry of a topology in mm: maps panel grid coordinates to model space. Renderers, the physics
 * and pick targets only use this, so a new shape needs nothing but a `point` function.
 */
export interface Surface {
  /** Model point for (u, v) on a panel at height h above the floor surface (toward the ball). */
  point(panel: number, u: number, v: number, h: number): Vec3;
  frame(panel: number, u: number, v: number): SurfaceFrame;
  /** mm per grid unit along u and v at (u, v), measured at height h. */
  metric(panel: number, u: number, v: number, h: number): readonly [number, number];
  /** The ball rides on a shell (inside or outside): the player rotates the object. */
  readonly closed: boolean;
  /** The maze is on the inside of the shell: render with a cutaway. */
  readonly cutaway: boolean;
  /** Walls bend with the surface (sample runs finely). */
  readonly curved: boolean;
  readonly bbox: { readonly min: Vec3; readonly max: Vec3 };
  /** Distance (mm) from a panel edge at which the ball centre transfers to the neighbouring panel (concave corners). */
  readonly edgeInset: number;
}

/** Where a point just outside a panel lands on the neighbouring panel, with the 2×2 map for directions. */
export interface PanelCrossing {
  readonly panel: number;
  readonly u: number;
  readonly v: number;
  /** (du', dv') = (m[0]·du + m[1]·dv, m[2]·du + m[3]·dv). */
  readonly m: readonly [number, number, number, number];
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
  /** Real geometry, or the flat unfolded net when `unfolded` (for editing). */
  surface(p: SurfaceParams, unfolded?: boolean): Surface;
  /** Map a point just outside a panel onto its neighbour; null at a true boundary. */
  crossPanel(panel: number, u: number, v: number): PanelCrossing | null;
  allowedStart(id: CellId): boolean;
  allowedGoal(id: CellId): boolean;
}

/** Build a Surface from a point function; frame and metric come from finite differences. */
export function surfaceFromPoint(
  point: Surface['point'],
  opts: { closed: boolean; cutaway?: boolean; curved: boolean; bbox: Surface['bbox']; edgeInset: number },
): Surface {
  const EPS = 1e-3;
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
  const unit = (a: Vec3): Vec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return {
    point,
    closed: opts.closed,
    cutaway: !!opts.cutaway,
    curved: opts.curved,
    bbox: opts.bbox,
    edgeInset: opts.edgeInset,
    frame(panel, u, v) {
      const p0 = point(panel, u, v, 0);
      const tu = unit(sub(point(panel, u + EPS, v, 0), p0));
      const tv = unit(sub(point(panel, u, v + EPS, 0), p0));
      const n = unit(sub(point(panel, u, v, EPS), p0));
      // keep the frame orthonormal even where the finite differences are slightly off
      const n2 = unit(cross(tu, tv));
      const sign = n2[0] * n[0] + n2[1] * n[1] + n2[2] * n[2] >= 0 ? 1 : -1;
      return { tu, tv, n: [n2[0] * sign, n2[1] * sign, n2[2] * sign] };
    },
    metric(panel, u, v, h) {
      const p0 = point(panel, u, v, h);
      return [len(sub(point(panel, u + EPS, v, h), p0)) / EPS, len(sub(point(panel, u, v + EPS, h), p0)) / EPS];
    },
  };
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
