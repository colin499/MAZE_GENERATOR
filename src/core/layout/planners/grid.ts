import type { CellId } from '../../model/ids';
import { edgeKey } from '../../model/ids';
import type { Maze } from '../../model/maze';
import type { Topology } from '../../model/topology';
import { SIDES, cellsOnLayer, wallSegment } from '../../model/topology';
import type { Vec3 } from '../../math/vec';
import type { PhysicalParams } from '../physical';
import { layerHOf, paramDefs, pitchOf, round } from '../physical';
import type { BuildPlan, Expr, Feature, FeatureGroup, PlaneSpec } from '../plan';
import { mergeRuns } from '../runs';
import type { UnitSeg } from '../runs';

export interface GridPlanOptions {
  readonly componentName?: string;
}

/**
 * Turn a flat/stacked maze into a BuildPlan: per layer a floor plate, thin-extruded wall runs,
 * lifted bridge walls, round holes (dropouts, traps, goal) and square shaft cut-outs.
 */
export function planGrid(maze: Maze, topo: Topology, phys: PhysicalParams, opts: GridPlanOptions = {}): BuildPlan {
  if (topo.spec.kind !== 'flat' && topo.spec.kind !== 'stacked') throw new Error(`grid planner cannot handle topology '${topo.spec.kind}'`);
  const pitch = pitchOf(phys);
  const layerH = layerHOf(phys);
  const half = phys.wallT / 2;
  const mm = (v: number): Expr => ({ mm: round(v), expr: `${round(v)} mm` });
  const groups: FeatureGroup[] = [];
  let volume = 0;
  const panels = topo.panels();
  const W = panels[0]!.w * pitch;
  const H = panels[0]!.h * pitch;

  for (const panel of panels) {
    const k = panel.layer;
    const z = k * layerH;
    const plane: PlaneSpec = { kind: 'xyOffset', offset: { mm: round(z), expr: `layerH * ${k}` } };
    const body = `L${k}`;
    const P = (x: number, y: number): Vec3 => [round(x), round(y), round(z)];
    const cells = cellsOnLayer(topo, k);
    const features: Feature[] = [];

    // floor
    const outline: Vec3[] = [P(-half, -half), P(W + half, -half), P(W + half, H + half), P(-half, H + half)];
    features.push({ op: 'extrude', name: `${body} floor`, plane, polygons: [outline], distance: { mm: phys.floorT, expr: 'floorT' }, mode: 'new', body });
    volume += (W + 2 * half) * (H + 2 * half) * phys.floorT;

    // walls and bridges as unit segments on the grid
    const wallSegs: UnitSeg[] = [];
    const bridgeSegs: UnitSeg[] = [];
    for (const c of cells) {
      const info = topo.cell(c);
      for (const s of SIDES) {
        const nb = topo.side(c, s);
        if (nb !== null && nb < c) continue; // each lateral pair once
        const seg = wallSegment(info, s);
        if (nb === null) { wallSegs.push(seg); continue; }
        const e = maze.edges.get(edgeKey(c, nb));
        if (!e) wallSegs.push(seg);
        else if (e.kind === 'tunnel') bridgeSegs.push(seg);
      }
    }
    const toSeg = (r: { from: readonly [number, number]; to: readonly [number, number] }): readonly [Vec3, Vec3] => [P(r.from[0] * pitch, r.from[1] * pitch), P(r.to[0] * pitch, r.to[1] * pitch)];
    const wallRuns = mergeRuns(wallSegs);
    features.push({
      op: 'thin', name: `${body} walls`, plane, segments: wallRuns.map(toSeg),
      thickness: { mm: phys.wallT, expr: 'wallT' }, start: { mm: phys.floorT, expr: 'floorT' }, distance: { mm: phys.wallH, expr: 'wallH' }, body,
    });
    volume += wallRuns.reduce((a, r) => a + r.length * pitch, 0) * phys.wallT * phys.wallH;
    if (bridgeSegs.length) {
      const runs = mergeRuns(bridgeSegs);
      features.push({
        op: 'thin', name: `${body} bridges`, plane, segments: runs.map(toSeg),
        thickness: { mm: phys.wallT, expr: 'wallT' }, start: { mm: phys.floorT + phys.bridgeLift, expr: 'floorT + bridgeLift' },
        distance: { mm: phys.wallH - phys.bridgeLift, expr: 'wallH - bridgeLift' }, body,
      });
      volume += runs.reduce((a, r) => a + r.length * pitch, 0) * phys.wallT * (phys.wallH - phys.bridgeLift);
    }

    // round holes: dropouts (from the upper cell), traps, goal exit
    const holeCells = new Set<CellId>();
    for (const e of maze.edges.values()) {
      if (e.kind !== 'dropout' && e.kind !== 'ramp') continue;
      const upper = e.from ?? (topo.cell(e.a).layer > topo.cell(e.b).layer ? e.a : e.b);
      if (topo.cell(upper).layer === k) holeCells.add(upper);
    }
    for (const c of maze.traps) if (topo.cell(c).layer === k) holeCells.add(c);
    if (topo.cell(maze.goal).layer === k) holeCells.add(maze.goal);
    const center = (c: CellId): Vec3 => { const i = topo.cell(c); return P((i.u + 0.5) * pitch, (i.v + 0.5) * pitch); };
    if (holeCells.size) {
      features.push({ op: 'holes', name: `${body} holes`, plane, points: [...holeCells].sort((a, b) => a - b).map(center), diameter: { mm: phys.holeDia, expr: 'holeDia' }, depth: { mm: phys.floorT, expr: 'floorT' }, body });
      volume -= holeCells.size * Math.PI * (phys.holeDia / 2) ** 2 * phys.floorT;
    }

    // shafts: the whole channel square of a disabled cell is removed from the floor
    const shafts = cells.filter((c) => maze.disabled.has(c));
    if (shafts.length) {
      const polys = shafts.map((c) => {
        const i = topo.cell(c);
        const x0 = i.u * pitch + half, y0 = i.v * pitch + half, x1 = (i.u + 1) * pitch - half, y1 = (i.v + 1) * pitch - half;
        return [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
      });
      features.push({ op: 'extrude', name: `${body} shafts`, plane, polygons: polys, distance: { mm: phys.floorT, expr: 'floorT' }, mode: 'cut', body });
      volume -= shafts.length * phys.chanW * phys.chanW * phys.floorT;
    }

    groups.push({ name: `Layer ${k}`, marker: body, features });
  }

  const layers = panels.length;
  return {
    componentName: opts.componentName ?? `Maze ${maze.seed}`,
    params: paramDefs(phys),
    groups,
    expected: {
      bodies: layers,
      bboxMm: { min: [round(-half), round(-half), 0], max: [round(W + half), round(H + half), round((layers - 1) * layerH + phys.floorT + phys.wallH)] },
      volumeMm3: round(volume, 1),
    },
    meta: { seed: maze.seed, topology: JSON.stringify(topo.spec), generator: 'maze-builder 0.1' },
  };
}

export { mm as exprMm };
const mm = (v: number): Expr => ({ mm: round(v), expr: `${round(v)} mm` });
