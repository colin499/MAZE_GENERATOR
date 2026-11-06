import type { CellId } from '../../model/ids';
import { edgeKey } from '../../model/ids';
import type { Maze } from '../../model/maze';
import type { Surface, Topology } from '../../model/topology';
import { SIDES, allCells, wallSegment } from '../../model/topology';
import { FACES } from '../../topology/cube';
import type { Vec3 } from '../../math/vec';
import { add3, cross3, dot3, norm3, scale3 } from '../../math/vec';
import type { PhysicalParams } from '../physical';
import { paramDefs, round } from '../physical';
import type { Axis, BuildPlan, Expr, Feature, FeatureGroup, PlaneSpec, SectorSpec } from '../plan';
import { mergeRuns } from '../runs';
import type { Run, UnitSeg } from '../runs';
import type { GridPlanOptions } from './grid';

const R3 = (p: Vec3): Vec3 => [round(p[0]), round(p[1]), round(p[2])];
const E = (mm: number, expr: string): Expr => ({ mm: round(mm), expr });
const MM = (v: number): Expr => E(v, `${round(v)} mm`);
const AXES: Record<Axis, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
/** Normal of the base plane Fusion uses for angle planes about each axis (X, Y → XY; Z → XZ). */
const BASE_NORMAL: Record<Axis, Vec3> = { X: [0, 0, 1], Y: [0, 0, 1], Z: [0, 1, 0] };

/** The plane containing principal `axis` and point `p` (also the origin), as a Fusion angle plane. */
function anglePlane(axis: Axis, p: Vec3): PlaneSpec {
  const a = AXES[axis];
  const w = add3(p, scale3(a, -dot3(p, a))); // component of p perpendicular to the axis
  const nrm = norm3(cross3(a, w));
  const b = BASE_NORMAL[axis];
  const angle = Math.atan2(dot3(cross3(b, nrm), a), dot3(b, nrm));
  return { kind: 'angle', axis, angleDeg: round((angle * 180) / Math.PI, 3) };
}

/** Unit normal of an angle plane (for in-plane constructions). */
function anglePlaneNormal(axis: Axis, p: Vec3): Vec3 {
  const a = AXES[axis];
  const w = add3(p, scale3(a, -dot3(p, a)));
  return norm3(cross3(a, w));
}

/** Half-rectangle for a revolved hole: axis from `from` to `to`, width r in the plane containing `axis`. */
function holeQuad(axis: Axis, from: Vec3, to: Vec3, r: number): readonly [Vec3, Vec3, Vec3, Vec3] {
  const nrm = anglePlaneNormal(axis, from);
  const d = norm3([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
  const perp = norm3(cross3(nrm, d));
  return [R3(from), R3(to), R3(add3(to, scale3(perp, r))), R3(add3(from, scale3(perp, r)))];
}

interface Walls { wall: Run[]; bridge: Run[] }

/** Merged wall and bridge runs per panel (grid units); walls on shared panel edges are built once. */
function wallRuns(maze: Maze, topo: Topology): Walls[] {
  const segs = topo.panels().map(() => ({ wall: [] as UnitSeg[], bridge: [] as UnitSeg[] }));
  for (const c of allCells(topo)) {
    const info = topo.cell(c);
    for (const s of SIDES) {
      const nb = topo.side(c, s);
      const seg = wallSegment(info, s);
      if (nb === null) { segs[info.panel]!.wall.push(seg); continue; }
      const same = topo.cell(nb).panel === info.panel;
      if (same ? nb < c : nb < c) continue;
      const e = maze.edges.get(edgeKey(c, nb));
      if (!e) segs[info.panel]!.wall.push(seg);
      else if (e.kind === 'tunnel') segs[info.panel]!.bridge.push(seg);
    }
  }
  return segs.map((s) => ({ wall: mergeRuns(s.wall), bridge: mergeRuns(s.bridge) }));
}

function holeCells(maze: Maze): { cell: CellId; kind: 'trap' | 'goal' }[] {
  return [...[...maze.traps].sort((a, b) => a - b).map((cell) => ({ cell, kind: 'trap' as const })), { cell: maze.goal, kind: 'goal' as const }];
}

/** Split features into timeline groups small enough for the bridge's 30 s limit; later groups are marked by their last feature. */
function groupFeatures(first: FeatureGroup, rest: Feature[], perGroup: number, label: string): FeatureGroup[] {
  const groups = [first];
  for (let i = 0; i < rest.length; i += perGroup) {
    const feats = rest.slice(i, i + perGroup);
    const last = feats[feats.length - 1]!;
    const marker = last.op === 'radialHoles' ? `feature:${last.name} ${last.holes.length - 1}` : `feature:${last.name}`;
    groups.push({ name: `${label} ${groups.length}`, marker, features: feats });
  }
  return groups;
}

/**
 * Cylinder, cube and sphere planners. The maze surface sits at the nominal size (tube diameter, cube
 * side, sphere diameter); the shell is floorT thick on the far side of it and the walls are ribs on the
 * ball's side (outside by default, or inside). Wall thickness, shell thickness and tube/cap diameters
 * stay live Fusion parameters; the layout, wall height and hole positions are baked.
 */
export function planShell(maze: Maze, topo: Topology, phys: PhysicalParams, opts: GridPlanOptions = {}): BuildPlan {
  const kind = topo.spec.kind;
  const surf = topo.surface(phys);
  const runs = wallRuns(maze, topo);
  const shell: Feature[] = [];
  const walls: Feature[] = [];
  const holes: Feature[] = [];
  const body = 'Shell';
  let volume = 0;
  const half = phys.wallT / 2;
  const overlap = Math.min(0.5, phys.floorT / 2); // walls reach this far into the shell so they fuse with it
  const holeR = phys.holeDia / 2;
  const inside = phys.shellSide === 'inside';
  const sgn = inside ? -1 : 1; // direction of growing h (away from the shell material), as a sign on the radius
  const rAt = (R: number, h: number) => R + sgn * h;

  if (kind === 'cylinder') {
    const spec = topo.spec as { around: number; along: number };
    const R = phys.tubeDia / 2;
    const pv = phys.chanW + phys.wallT;
    const L = spec.along * pv;
    const z = (zz: number): PlaneSpec => ({ kind: 'xyOffset', offset: MM(zz) });
    const angle = (u: number) => (2 * Math.PI * u) / spec.around;
    const outerDia = E(phys.tubeDia + 2 * phys.floorT, 'tubeDia + 2 * floorT');
    const innerDia = inside ? E(phys.tubeDia, 'tubeDia') : E(phys.tubeDia - 2 * phys.floorT, 'tubeDia - 2 * floorT');
    const tubeOuter = inside ? outerDia : E(phys.tubeDia, 'tubeDia');
    shell.push({ op: 'ring', name: 'Tube', plane: z(0), center: [0, 0, 0], innerDia, outerDia: tubeOuter, distance: MM(L), mode: 'new', body });
    volume += Math.PI * (tubeOuter.mm ** 2 - innerDia.mm ** 2) / 4 * L;
    if (inside) {
      // closed start end; the goal exits through a hole in the far cap
      const gi = topo.cell(maze.goal);
      const ga = angle(gi.u + 0.5), gr = R - holeR - 0.2;
      shell.push({ op: 'disk', name: 'Start cap', plane: z(-phys.floorT), center: [0, 0, -phys.floorT], diameter: outerDia, holes: [], distance: E(phys.floorT, 'floorT'), mode: 'join', body });
      shell.push({ op: 'disk', name: 'Goal cap', plane: z(L), center: [0, 0, round(L)], diameter: outerDia, holes: [{ center: R3([gr * Math.cos(ga), gr * Math.sin(ga), L]), diameter: E(phys.holeDia, 'holeDia') }], distance: E(phys.floorT, 'floorT'), mode: 'join', body });
      volume += 2 * Math.PI * (R + phys.floorT) ** 2 * phys.floorT - Math.PI * holeR ** 2 * phys.floorT;
    }

    // axial walls (constant u): radial lines thin-extruded along z, grouped by start z and length
    const radial = (u: number, zz: number, rr: number): Vec3 => { const a = angle(u); return R3([rr * Math.cos(a), rr * Math.sin(a), zz]); };
    const axialRuns = (rs: Run[], h0: number, label: string) => {
      const groups = new Map<string, { z0: number; len: number; segs: (readonly [Vec3, Vec3])[] }>();
      for (const r of rs) {
        if (r.from[0] !== r.to[0]) continue;
        const v0 = Math.min(r.from[1], r.to[1]), v1 = Math.max(r.from[1], r.to[1]);
        const z0 = v0 * pv - half, len = (v1 - v0) * pv + phys.wallT;
        const key = `${round(z0)}:${round(len)}`;
        const g = groups.get(key) ?? groups.set(key, { z0, len, segs: [] }).get(key)!;
        g.segs.push([radial(r.from[0], z0, rAt(R, phys.wallH)), radial(r.from[0], z0, rAt(R, h0 - (h0 === 0 ? overlap : 0)))]);
        volume += (phys.wallH - h0 + overlap) * phys.wallT * len;
      }
      let i = 0;
      for (const g of [...groups.values()].sort((a, b) => a.z0 - b.z0)) {
        walls.push({ op: 'thin', name: `${label} axial ${i++}`, plane: z(g.z0), segments: g.segs, thickness: E(phys.wallT, 'wallT'), distance: MM(g.len), body });
      }
    };
    // ring walls (constant v): annular sectors on the plane z = v·pv, symmetric thickness
    const ringRuns = (rs: Run[], h0: number, label: string) => {
      const byV = new Map<number, SectorSpec[]>();
      for (const r of rs) {
        if (r.from[1] !== r.to[1]) continue;
        const v = r.from[1];
        const u0 = Math.min(r.from[0], r.to[0]), u1 = Math.max(r.from[0], r.to[0]);
        const full = u1 - u0 >= spec.around;
        const ext = half / R;
        const pieces: [number, number][] = full ? [[u0, u0 + spec.around / 2], [u0 + spec.around / 2, u1]] : [[u0, u1]];
        for (const [a, b] of pieces) {
          const a0 = angle(a) - (full ? 0 : ext), a1 = angle(b) + (full ? 0 : ext);
          const rIn = Math.min(rAt(R, phys.wallH), rAt(R, h0 - (h0 === 0 ? overlap : 0))), rOut = Math.max(rAt(R, phys.wallH), rAt(R, h0 - (h0 === 0 ? overlap : 0)));
          const pt = (rr: number, ang: number): Vec3 => R3([rr * Math.cos(ang), rr * Math.sin(ang), v * pv]);
          const mid = (a0 + a1) / 2;
          (byV.get(v) ?? byV.set(v, []).get(v)!).push({ innerStart: pt(rIn, a0), innerMid: pt(rIn, mid), innerEnd: pt(rIn, a1), outerStart: pt(rOut, a0), outerMid: pt(rOut, mid), outerEnd: pt(rOut, a1) });
          volume += (a1 - a0) * (rOut - rIn) * ((rOut + rIn) / 2) * phys.wallT;
        }
      }
      for (const [v, sectors] of [...byV.entries()].sort((x, y) => x[0] - y[0])) {
        walls.push({ op: 'sectors', name: `${label} ring v${v}`, plane: z(v * pv), sectors, thickness: E(phys.wallT, 'wallT'), body });
      }
    };
    axialRuns(runs[0]!.wall, 0, 'Walls');
    ringRuns(runs[0]!.wall, 0, 'Walls');
    axialRuns(runs[0]!.bridge, phys.bridgeLift, 'Bridges');
    ringRuns(runs[0]!.bridge, phys.bridgeLift, 'Bridges');
    // holes through the tube wall (traps; the goal too on the outside): revolve-cuts on the plane containing the axis
    for (const h of holeCells(maze)) {
      if (h.kind === 'goal' && inside) continue; // exits through the cap
      const i = topo.cell(h.cell);
      const from = surf.point(0, i.u + 0.5, i.v + 0.5, -(phys.floorT + 1));
      const to = surf.point(0, i.u + 0.5, i.v + 0.5, 1);
      holes.push({ op: 'radialHoles', name: `${h.kind === 'goal' ? 'Goal' : 'Trap'} ${h.cell}`, plane: anglePlane('Z', from), holes: [holeQuad('Z', from, to, holeR)], body });
      volume -= Math.PI * holeR ** 2 * phys.floorT;
    }
    const Ro = inside ? R + phys.floorT : R + phys.wallH;
    return finish(maze, topo, phys, opts, shell, walls, holes, volume, [[-Ro, -Ro, inside ? -phys.floorT : -half], [Ro, Ro, L + (inside ? phys.floorT : half)]], body);
  }

  const n = (topo.spec as { n: number }).n;
  if (kind === 'cube') {
    const S = phys.cubeSide / 2; // half side at the maze surface
    const Sout = inside ? S + phys.floorT : S, Sin = inside ? S : S - phys.floorT;
    const sq = (s: number, zz: number): Vec3[] => [[-s, -s, zz], [s, -s, zz], [s, s, zz], [-s, s, zz]];
    shell.push({ op: 'extrude', name: 'Shell outer', plane: { kind: 'xyOffset', offset: MM(-Sout) }, polygons: [sq(Sout, -Sout)], distance: MM(2 * Sout), mode: 'new', body });
    shell.push({ op: 'extrude', name: 'Shell cavity', plane: { kind: 'xyOffset', offset: MM(-Sin) }, polygons: [sq(Sin, -Sin)], distance: MM(2 * Sin), mode: 'cut', body });
    volume += (2 * Sout) ** 3 - (2 * Sin) ** 3;
    const pitch = phys.cubeSide / n;
    // face planes just inside the shell material, with the normal pointing toward the ball (where the walls grow)
    const facePlane = (panel: number): PlaneSpec => {
      const nrm = FACES[panel]!.n;
      const base = nrm[2] !== 0 ? 'XY' : nrm[0] !== 0 ? 'YZ' : 'XZ';
      const positive = nrm[0] + nrm[1] + nrm[2] > 0;
      const pos = (positive ? 1 : -1) * (S - sgn * overlap); // position of the plane along the face axis
      const dir = (positive ? 1 : -1) * sgn;               // wanted normal along that axis
      const flip = dir < 0;                                  // the base plane normal is +axis; flipping reverses it and the offset
      return { kind: 'offset', base, flip, offset: MM(flip ? -pos : pos) };
    };
    for (const panel of topo.panels()) {
      const plane = facePlane(panel.id);
      const toSeg = (r: Run): readonly [Vec3, Vec3] => {
        const dx = Math.sign(r.to[0] - r.from[0]), dy = Math.sign(r.to[1] - r.from[1]);
        const a = surf.point(panel.id, r.from[0] - (dx * half) / pitch, r.from[1] - (dy * half) / pitch, -overlap);
        const b = surf.point(panel.id, r.to[0] + (dx * half) / pitch, r.to[1] + (dy * half) / pitch, -overlap);
        return [R3(a), R3(b)];
      };
      const w = runs[panel.id]!;
      if (w.wall.length) {
        walls.push({ op: 'thin', name: `Face ${panel.id} walls`, plane, segments: w.wall.map(toSeg), thickness: E(phys.wallT, 'wallT'), distance: E(phys.wallH + overlap, `wallH + ${round(overlap)} mm`), body });
        volume += w.wall.reduce((a, r) => a + r.length * pitch + phys.wallT, 0) * phys.wallT * phys.wallH;
      }
      if (w.bridge.length) {
        walls.push({ op: 'thin', name: `Face ${panel.id} bridges`, plane, segments: w.bridge.map(toSeg), start: E(phys.bridgeLift + overlap, `bridgeLift + ${round(overlap)} mm`), distance: E(phys.wallH - phys.bridgeLift, 'wallH - bridgeLift'), thickness: E(phys.wallT, 'wallT'), body });
        volume += w.bridge.reduce((a, r) => a + r.length * pitch + phys.wallT, 0) * phys.wallT * (phys.wallH - phys.bridgeLift);
      }
    }
    addShellHoles(maze, topo, surf, phys, holes, body, (i) => {
      const nrm = FACES[i.panel]!.n;
      return nrm[0] !== 0 ? 'X' : nrm[1] !== 0 ? 'Y' : 'Z';
    });
    volume -= holeCells(maze).length * Math.PI * holeR ** 2 * phys.floorT;
    const So = inside ? Sout : S + phys.wallH;
    return finish(maze, topo, phys, opts, shell, walls, holes, volume, [[-So, -So, -So], [So, So, So]], body);
  }

  // sphere: hollow shell by revolving a half annulus about z; walls as sectors on great-circle planes
  const R = phys.sphereDia / 2; // radius at the maze surface
  const Rout = inside ? R + phys.floorT : R, Rin = inside ? R : R - phys.floorT;
  shell.push({
    op: 'revolve', name: 'Shell', plane: { kind: 'offset', base: 'XZ', flip: false, offset: MM(0) }, mode: 'new', body,
    arcs: [
      [R3([0, 0, -Rin]), R3([Rin, 0, 0]), R3([0, 0, Rin])],
      [R3([0, 0, -Rout]), R3([Rout, 0, 0]), R3([0, 0, Rout])],
    ],
    lines: [[R3([0, 0, -Rout]), R3([0, 0, -Rin])], [R3([0, 0, Rin]), R3([0, 0, Rout])]],
  });
  volume += (4 / 3) * Math.PI * (Rout ** 3 - Rin ** 3);
  const planes = new Map<string, { plane: PlaneSpec; sectors: SectorSpec[]; label: string }>();
  const addRun = (panel: number, r: Run, h0: number, label: string) => {
    const f = FACES[panel]!;
    const alongU = r.from[1] === r.to[1];
    const dir = alongU ? f.tu : f.tv; // the run's straight direction on the cube face: a principal axis
    const axis: Axis = dir[0] !== 0 ? 'X' : dir[1] !== 0 ? 'Y' : 'Z';
    const p0 = norm3(surf.point(panel, r.from[0], r.from[1], 0)), p1 = norm3(surf.point(panel, r.to[0], r.to[1], 0));
    const plane = anglePlane(axis, p0);
    const nrm = anglePlaneNormal(axis, p0);
    const key = `${label}:${axis}:${plane.kind === 'angle' ? ((plane.angleDeg % 180) + 180) % 180 : ''}`;
    const g = planes.get(key) ?? planes.set(key, { plane, sectors: [], label }).get(key)!;
    const ang = Math.acos(Math.max(-1, Math.min(1, dot3(p0, p1))));
    const ext = half / R;
    const e1 = norm3(cross3(nrm, p0));
    const dirSgn = dot3(e1, p1) >= 0 ? 1 : -1;
    const at = (t: number, rr: number): Vec3 => R3(scale3(add3(scale3(p0, Math.cos(t)), scale3(e1, dirSgn * Math.sin(t))), rr));
    const rA = rAt(R, phys.wallH), rB = rAt(R, h0 - (h0 === 0 ? overlap : 0));
    const rIn = Math.min(rA, rB), rOut = Math.max(rA, rB);
    const a0 = -ext, a1 = ang + ext, mid = (a0 + a1) / 2;
    g.sectors.push({ innerStart: at(a0, rIn), innerMid: at(mid, rIn), innerEnd: at(a1, rIn), outerStart: at(a0, rOut), outerMid: at(mid, rOut), outerEnd: at(a1, rOut) });
    volume += (a1 - a0) * (rOut - rIn) * ((rOut + rIn) / 2) * phys.wallT;
  };
  runs.forEach((w, panel) => { for (const r of w.wall) addRun(panel, r, 0, 'Walls'); for (const r of w.bridge) addRun(panel, r, phys.bridgeLift, 'Bridges'); });
  let pi = 0;
  for (const g of planes.values()) walls.push({ op: 'sectors', name: `${g.label} plane ${pi++}`, plane: g.plane, sectors: g.sectors, thickness: E(phys.wallT, 'wallT'), body });
  addShellHoles(maze, topo, surf, phys, holes, body, (i) => {
    const c = surf.point(i.panel, i.u + 0.5, i.v + 0.5, 0);
    return Math.hypot(c[0], c[1]) < 1e-6 ? 'X' : 'Z';
  });
  volume -= holeCells(maze).length * Math.PI * holeR ** 2 * phys.floorT;
  const Ro = inside ? Rout : R + phys.wallH;
  return finish(maze, topo, phys, opts, shell, walls, holes, volume, [[-Ro, -Ro, -Ro], [Ro, Ro, Ro]], body);
}

/** Trap and goal holes cut through the shell along the floor normal at the cell centre. */
function addShellHoles(maze: Maze, topo: Topology, surf: Surface, phys: PhysicalParams, out: Feature[], body: string, axisFor: (i: { panel: number; u: number; v: number }) => Axis): void {
  for (const h of holeCells(maze)) {
    const i = topo.cell(h.cell);
    const from = surf.point(i.panel, i.u + 0.5, i.v + 0.5, -(phys.floorT + 1));
    const to = surf.point(i.panel, i.u + 0.5, i.v + 0.5, 1);
    const axis = axisFor(i);
    out.push({ op: 'radialHoles', name: `${h.kind === 'goal' ? 'Goal' : 'Trap'} ${h.cell}`, plane: anglePlane(axis, from), holes: [holeQuad(axis, from, to, phys.holeDia / 2)], body });
  }
}

function finish(maze: Maze, topo: Topology, phys: PhysicalParams, opts: GridPlanOptions, shell: Feature[], walls: Feature[], holes: Feature[], volume: number, bbox: [Vec3, Vec3], body: string): BuildPlan {
  const groups = groupFeatures({ name: 'Shell', marker: body, features: shell }, [...walls, ...holes], 6, 'Walls');
  return {
    componentName: opts.componentName ?? `Maze ${maze.seed}`,
    params: paramDefs(phys),
    groups,
    expected: { bodies: 1, bboxMm: { min: R3(bbox[0]), max: R3(bbox[1]) }, volumeMm3: round(volume, 1) },
    meta: { seed: maze.seed, topology: JSON.stringify(topo.spec), generator: 'maze-builder 0.2' },
  };
}
