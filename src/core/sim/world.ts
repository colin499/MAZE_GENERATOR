import type { CellId } from '../model/ids';
import { edgeKey } from '../model/ids';
import type { Maze } from '../model/maze';
import type { Topology } from '../model/topology';
import { SIDES, cellsOnLayer, wallSegment } from '../model/topology';
import type { PhysicalParams } from '../layout/physical';
import { layerHOf, pitchOf } from '../layout/physical';
import { mergeRuns } from '../layout/runs';
import type { UnitSeg } from '../layout/runs';

/** Axis-aligned wall box in mm (absolute z). */
export interface WallBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z0: number;
  readonly z1: number;
  readonly bridge: boolean;
}

export type HoleKind = 'dropout' | 'trap' | 'goal';

export interface Hole {
  readonly cell: CellId;
  readonly kind: HoleKind;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** Landing cell for dropouts. */
  readonly to: CellId | null;
}

export interface LayerWorld {
  readonly layer: number;
  /** Absolute z of the floor top (ball rests at floorZ + ballR). */
  readonly floorZ: number;
  readonly walls: readonly WallBox[];
  readonly holes: readonly Hole[];
  /** Wall indices overlapping each cell square (expanded by the ball radius), keyed v * w + u. */
  readonly buckets: ReadonlyArray<readonly number[]>;
}

/** Static collision world for a grid maze (flat or stacked), mm, z up, matching the renderer and the Fusion export. */
export interface World {
  readonly w: number;
  readonly h: number;
  readonly pitch: number;
  readonly layerH: number;
  readonly ballR: number;
  readonly layers: readonly LayerWorld[];
  readonly start: { readonly x: number; readonly y: number; readonly layer: number; readonly cell: CellId };
  cellAt(layer: number, x: number, y: number): CellId | null;
  center(cell: CellId): readonly [number, number];
}

export function buildWorld(maze: Maze, topo: Topology, phys: PhysicalParams): World {
  const pitch = pitchOf(phys);
  const layerH = layerHOf(phys);
  const ballR = phys.ballDia / 2;
  const panels = topo.panels();
  const w = panels[0]!.w, h = panels[0]!.h;
  const center = (c: CellId): readonly [number, number] => {
    const i = topo.cell(c);
    return [(i.u + 0.5) * pitch, (i.v + 0.5) * pitch];
  };
  const layers: LayerWorld[] = panels.map((panel) => {
    const k = panel.layer;
    const floorZ = k * layerH + phys.floorT;
    const wallSegs: UnitSeg[] = [];
    const bridgeSegs: UnitSeg[] = [];
    const cells = cellsOnLayer(topo, k);
    for (const c of cells) {
      const info = topo.cell(c);
      for (const s of SIDES) {
        const nb = topo.side(c, s);
        if (nb !== null && nb < c) continue;
        const seg = wallSegment(info, s);
        if (nb === null) { wallSegs.push(seg); continue; }
        const e = maze.edges.get(edgeKey(c, nb));
        if (!e) wallSegs.push(seg);
        else if (e.kind === 'tunnel') bridgeSegs.push(seg);
      }
    }
    const walls: WallBox[] = [];
    const push = (segs: UnitSeg[], z0: number, bridge: boolean) => {
      for (const r of mergeRuns(segs)) {
        const t = phys.wallT / 2;
        walls.push({
          x0: Math.min(r.from[0], r.to[0]) * pitch - t,
          x1: Math.max(r.from[0], r.to[0]) * pitch + t,
          y0: Math.min(r.from[1], r.to[1]) * pitch - t,
          y1: Math.max(r.from[1], r.to[1]) * pitch + t,
          z0, z1: floorZ + phys.wallH, bridge,
        });
      }
    };
    push(wallSegs, floorZ, false);
    push(bridgeSegs, floorZ + phys.bridgeLift, true);

    const holes: Hole[] = [];
    const hole = (c: CellId, kind: HoleKind, to: CellId | null) => {
      const [x, y] = center(c);
      holes.push({ cell: c, kind, x, y, r: phys.holeDia / 2, to });
    };
    for (const e of maze.edges.values()) {
      if (e.kind !== 'dropout') continue;
      const upper = e.from ?? (topo.cell(e.a).layer > topo.cell(e.b).layer ? e.a : e.b);
      if (topo.cell(upper).layer === k) hole(upper, 'dropout', upper === e.a ? e.b : e.a);
    }
    for (const c of maze.traps) if (topo.cell(c).layer === k) hole(c, 'trap', null);
    if (topo.cell(maze.goal).layer === k) hole(maze.goal, 'goal', null);

    const buckets: number[][] = Array.from({ length: w * h }, () => []);
    const margin = ballR + 0.01;
    walls.forEach((b, i) => {
      const u0 = Math.max(0, Math.floor((b.x0 - margin) / pitch)), u1 = Math.min(w - 1, Math.floor((b.x1 + margin) / pitch));
      const v0 = Math.max(0, Math.floor((b.y0 - margin) / pitch)), v1 = Math.min(h - 1, Math.floor((b.y1 + margin) / pitch));
      for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) buckets[v * w + u]!.push(i);
    });
    return { layer: k, floorZ, walls, holes, buckets };
  });
  const si = topo.cell(maze.start);
  const [sx, sy] = center(maze.start);
  return {
    w, h, pitch, layerH, ballR, layers,
    start: { x: sx, y: sy, layer: si.layer, cell: maze.start },
    cellAt: (layer, x, y) => {
      const u = Math.floor(x / pitch), v = Math.floor(y / pitch);
      if (u < 0 || v < 0 || u >= w || v >= h) return null;
      return topo.cellAt(layer, u, v);
    },
    center,
  };
}
