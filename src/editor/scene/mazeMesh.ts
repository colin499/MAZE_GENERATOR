import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CellId } from '@core/model/ids';
import { edgeKey } from '@core/model/ids';
import type { Maze } from '@core/model/maze';
import type { Surface, Topology } from '@core/model/topology';
import { SIDES, cellsOnLayer, wallSegment } from '@core/model/topology';
import type { PhysicalParams } from '@core/layout/physical';
import { mergeRuns } from '@core/layout/runs';
import type { Run, UnitSeg } from '@core/layout/runs';
import type { Vec3 } from '@core/math/vec';

export const COLORS = {
  floor: 0x3a4454,
  floorLocked: 0x2f4a55,
  wall: 0xc3cad6,
  bridge: 0xb38cf5,
  trap: 0xf2707a,
  dropout: 0x6fb7ff,
  goal: 0x5bd39a,
  start: 0xffffff,
  shaft: 0x141a24,
  solution: 0x5bd39a,
};

export interface LayerMeshes {
  readonly layer: number;
  readonly group: THREE.Group;
}

export interface SlotRef { a: CellId; b: CellId; layer: number }

export interface SceneBuild {
  readonly root: THREE.Group;
  readonly layers: LayerMeshes[];
  /** Invisible pick targets: one instance per lateral neighbour pair. */
  readonly slotPick: THREE.InstancedMesh;
  readonly slots: SlotRef[];
  /** Invisible pick targets: one instance per cell floor. */
  readonly cellPick: THREE.InstancedMesh;
  readonly cells: CellId[];
  readonly bbox: THREE.Box3;
  readonly surface: Surface;
  /** Materials that take part in the cutaway clipping (everything but the ball). */
  readonly clippable: THREE.Material[];
}

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

/** Quad-strip geometry from rows of points (each row the same length). */
function quadGrid(rows: Vec3[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const cols = rows[0]!.length;
  for (const row of rows) for (const p of row) pos.push(p[0], p[1], p[2]);
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, b, e, a, e, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A box swept along a grid-aligned run on the surface: thickness t (mm) across, from height h0 to h1. */
function sweepRun(surf: Surface, panel: number, run: Run, t: number, h0: number, h1: number, extend: number, curved: boolean): THREE.BufferGeometry {
  const horizontal = run.from[1] === run.to[1];
  const u0 = Math.min(run.from[0], run.to[0]), u1 = Math.max(run.from[0], run.to[0]);
  const vv0 = Math.min(run.from[1], run.to[1]), vv1 = Math.max(run.from[1], run.to[1]);
  const steps = curved ? Math.max(2, Math.ceil(run.length * 5) + 1) : 2;
  const along = (i: number): [number, number] => {
    const s = i / (steps - 1);
    return horizontal ? [u0 + s * (u1 - u0), vv0] : [u0, vv0 + s * (vv1 - vv0)];
  };
  const rings: Vec3[][] = [];
  for (let i = 0; i < steps; i++) {
    let [u, v] = along(i);
    const [pu, pv] = surf.metric(panel, u, v, (h0 + h1) / 2);
    if (i === 0) { if (horizontal) u -= extend / pu; else v -= extend / pv; }
    if (i === steps - 1) { if (horizontal) u += extend / pu; else v += extend / pv; }
    const ou = horizontal ? 0 : t / 2 / pu, ov = horizontal ? t / 2 / pv : 0;
    rings.push([
      surf.point(panel, u - ou, v - ov, h0),
      surf.point(panel, u + ou, v + ov, h0),
      surf.point(panel, u + ou, v + ov, h1),
      surf.point(panel, u - ou, v - ov, h1),
      surf.point(panel, u - ou, v - ov, h0),
    ]);
  }
  const side = quadGrid(rings);
  const cap = (ring: Vec3[]) => quadGrid([[ring[0]!, ring[1]!], [ring[3]!, ring[2]!]]);
  return mergeGeometries([side, cap(rings[0]!), cap(rings[rings.length - 1]!)])!;
}

/** Thick sheet of a panel's floor between heights −floorT and 0, with skirts at open edges. */
function floorSheet(surf: Surface, panel: number, w: number, h: number, floorT: number, ext: readonly [number, number, number, number], curved: boolean, wrapU: boolean): THREE.BufferGeometry {
  const segs = curved ? 3 : 1;
  const uA = -ext[0], uB = w + ext[1], vA = -ext[2], vB = h + ext[3];
  const nu = Math.ceil((uB - uA) * segs), nv = Math.ceil((vB - vA) * segs);
  const sheet = (hh: number): Vec3[][] => {
    const rows: Vec3[][] = [];
    for (let j = 0; j <= nv; j++) {
      const v = vA + ((vB - vA) * j) / nv;
      const row: Vec3[] = [];
      for (let i = 0; i <= nu; i++) row.push(surf.point(panel, uA + ((uB - uA) * i) / nu, v, hh));
      rows.push(row);
    }
    return rows;
  };
  const top = sheet(0), bottom = sheet(-floorT);
  const parts: THREE.BufferGeometry[] = [quadGrid(top), quadGrid(bottom.map((r) => [...r].reverse()))];
  const edge = (a: Vec3[], b: Vec3[]) => quadGrid([a, b]);
  parts.push(edge(top[0]!, bottom[0]!), edge(bottom[nv]!, top[nv]!));
  if (!wrapU) parts.push(edge(top.map((r) => r[0]!), bottom.map((r) => r[0]!)), edge(bottom.map((r) => r[nu]!), top.map((r) => r[nu]!)));
  return mergeGeometries(parts)!;
}

/** Matrix placing a unit cube at grid point (u, v, h) with scale (su along u, sv along v, sh along n). */
export function frameMatrix(surf: Surface, panel: number, u: number, v: number, h: number, su: number, sv: number, sh: number): THREE.Matrix4 {
  const f = surf.frame(panel, u, v);
  const p = surf.point(panel, u, v, h);
  const m = new THREE.Matrix4().makeBasis(v3(f.tu).multiplyScalar(su), v3(f.tv).multiplyScalar(sv), v3(f.n).multiplyScalar(sh));
  m.setPosition(p[0], p[1], p[2]);
  return m;
}

/** Build all visible geometry for a maze in mm (real shape, or the unfolded net for editing). */
export function buildMazeScene(maze: Maze, topo: Topology, phys: PhysicalParams, heat?: Int32Array | null, unfolded = false): SceneBuild {
  const surf = topo.surface(phys, unfolded);
  const curved = surf.curved;
  const root = new THREE.Group();
  const layers = new Map<number, THREE.Group>();
  const slots: SlotRef[] = [];
  const cells: CellId[] = [];
  const clippable: THREE.Material[] = [];
  const maxHeat = heat ? heat.reduce((a, b) => Math.max(a, b), 0) : 0;
  const half = phys.wallT / 2;
  const sideMode = surf.cutaway ? THREE.DoubleSide : THREE.FrontSide;
  const mat = (opts: THREE.MeshStandardMaterialParameters) => { const m = new THREE.MeshStandardMaterial({ side: sideMode, ...opts }); clippable.push(m); return m; };
  const basic = (opts: THREE.MeshBasicMaterialParameters) => { const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, ...opts }); clippable.push(m); return m; };

  for (const panel of topo.panels()) {
    const k = panel.layer;
    let group = layers.get(k);
    if (!group) { group = new THREE.Group(); group.name = `layer-${k}`; layers.set(k, group); root.add(group); }
    const wallMat = mat({ color: COLORS.wall, roughness: 0.8, metalness: 0.05 });
    const bridgeMat = mat({ color: COLORS.bridge, roughness: 0.7 });
    const floorMat = mat({ color: COLORS.floor, roughness: 0.95 });
    const panelCells = cellsOnLayer(topo, k).filter((c) => topo.cell(c).panel === panel.id);

    // floor: extend past the grid by half a wall where nothing is attached across the edge
    const open = (u: number, v: number) => topo.crossPanel(panel.id, u, v) === null;
    const ext: [number, number, number, number] = unfolded ? [0, 0, 0, 0] : [
      panel.wrapU ? 0 : (open(-0.5, panel.h / 2) ? half : 0) / surf.metric(panel.id, 0, panel.h / 2, 0)[0],
      panel.wrapU ? 0 : (open(panel.w + 0.5, panel.h / 2) ? half : 0) / surf.metric(panel.id, panel.w, panel.h / 2, 0)[0],
      (open(panel.w / 2, -0.5) ? half : 0) / surf.metric(panel.id, panel.w / 2, 0, 0)[1],
      (open(panel.w / 2, panel.h + 0.5) ? half : 0) / surf.metric(panel.id, panel.w / 2, panel.h, 0)[1],
    ];
    const floor = new THREE.Mesh(floorSheet(surf, panel.id, panel.w, panel.h, phys.floorT, ext, curved, !!panel.wrapU), floorMat);
    floor.receiveShadow = true;
    floor.name = 'floor';
    group.add(floor);

    // per-cell colour tiles for locks / heat / shafts
    const tiles: THREE.BufferGeometry[] = [];
    const tileColors: number[] = [];
    for (const c of panelCells) {
      const i = topo.cell(c);
      let color: number | null = null;
      if (maze.disabled.has(c)) color = COLORS.shaft;
      else if (maze.locked.has(c)) color = COLORS.floorLocked;
      else if (heat && maxHeat > 0 && heat[c]! > 0) color = new THREE.Color().setHSL(0.12 - 0.12 * (heat[c]! / maxHeat), 0.8, 0.3 + 0.2 * (heat[c]! / maxHeat)).getHex();
      if (color === null) continue;
      const [pu, pv] = surf.metric(panel.id, i.u + 0.5, i.v + 0.5, 0);
      const du = half / pu, dv = half / pv;
      const segs = curved ? 3 : 1;
      const rows: Vec3[][] = [];
      for (let b = 0; b <= segs; b++) {
        const row: Vec3[] = [];
        for (let a = 0; a <= segs; a++) row.push(surf.point(panel.id, i.u + du + (1 - 2 * du) * (a / segs), i.v + dv + (1 - 2 * dv) * (b / segs), 0.3));
        rows.push(row);
      }
      const g = quadGrid(rows);
      const col = new THREE.Color(color);
      const n = g.getAttribute('position').count;
      for (let j = 0; j < n; j++) tileColors.push(col.r, col.g, col.b);
      tiles.push(g);
    }
    if (tiles.length) {
      const merged = mergeGeometries(tiles)!;
      merged.setAttribute('color', new THREE.Float32BufferAttribute(tileColors, 3));
      group.add(new THREE.Mesh(merged, mat({ vertexColors: true, roughness: 1 })));
    }

    // walls
    const wallSegs: UnitSeg[] = [];
    const bridgeSegs: UnitSeg[] = [];
    for (const c of panelCells) {
      const info = topo.cell(c);
      for (const s of SIDES) {
        const nb = topo.side(c, s);
        const seg = wallSegment(info, s);
        if (nb === null) { wallSegs.push(seg); continue; }
        const samePanel = topo.cell(nb).panel === panel.id;
        if (samePanel && nb < c) continue; // each pair once per panel
        if (samePanel || nb > c) slots.push({ a: c, b: nb, layer: k });
        const e = maze.edges.get(edgeKey(c, nb));
        if (!e) wallSegs.push(seg); // walls on a shared panel edge are drawn by both panels (they coincide)
        else if (e.kind === 'tunnel') bridgeSegs.push(seg);
      }
    }
    const build = (segs: UnitSeg[], h0: number, h1: number) => mergeRuns(segs).map((r) => sweepRun(surf, panel.id, r, phys.wallT, h0, h1, half, curved));
    const wallGeom = build(wallSegs, 0, phys.wallH);
    if (wallGeom.length) {
      const m = new THREE.Mesh(mergeGeometries(wallGeom)!, wallMat);
      m.castShadow = true;
      m.userData.shadow = true;
      group.add(m);
    }
    const bridgeGeom = build(bridgeSegs, phys.bridgeLift, phys.wallH);
    if (bridgeGeom.length) group.add(new THREE.Mesh(mergeGeometries(bridgeGeom)!, bridgeMat));

    // holes and markers
    const ring = (c: CellId, color: number, r: number, zOff = 0) => {
      const i = topo.cell(c);
      const m = new THREE.Mesh(new THREE.RingGeometry(r * 0.72, r, 32), basic({ color }));
      m.matrixAutoUpdate = false;
      m.matrix.copy(frameMatrix(surf, panel.id, i.u + 0.5, i.v + 0.5, 0.4 + zOff, 1, 1, 1));
      group!.add(m);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(r * 0.72, 32), basic({ color: 0x0b0c10 }));
      hole.matrixAutoUpdate = false;
      hole.matrix.copy(m.matrix);
      group!.add(hole);
    };
    const onPanel = (c: CellId) => { const i = topo.cell(c); return i.layer === k && i.panel === panel.id; };
    for (const e of maze.edges.values()) {
      if (e.kind !== 'dropout' && e.kind !== 'ramp') continue;
      const upper = e.from ?? (topo.cell(e.a).layer > topo.cell(e.b).layer ? e.a : e.b);
      if (onPanel(upper)) ring(upper, COLORS.dropout, phys.holeDia / 2);
    }
    for (const c of maze.traps) if (onPanel(c)) ring(c, COLORS.trap, phys.holeDia / 2);
    if (onPanel(maze.goal)) ring(maze.goal, COLORS.goal, phys.holeDia / 2, 0.1);
    if (onPanel(maze.start)) {
      const i = topo.cell(maze.start);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(phys.ballDia / 2, 24, 16), new THREE.MeshStandardMaterial({ color: COLORS.start, metalness: 0.6, roughness: 0.3 }));
      ball.position.copy(v3(surf.point(panel.id, i.u + 0.5, i.v + 0.5, phys.ballDia / 2)));
      ball.name = 'startBall';
      group.add(ball);
    }
    for (const c of panelCells) cells.push(c);
  }

  // pick targets
  const slotPick = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }), Math.max(1, slots.length));
  slots.forEach((s, i) => {
    const info = topo.cell(s.a);
    const side = SIDES.find((sd) => topo.side(s.a, sd) === s.b)!;
    const seg = wallSegment(info, side);
    const horizontal = seg[0][1] === seg[1][1];
    const mu = (seg[0][0] + seg[1][0]) / 2, mv = (seg[0][1] + seg[1][1]) / 2;
    const [pu, pv] = surf.metric(info.panel, mu, mv, phys.wallH / 2);
    slotPick.setMatrixAt(i, frameMatrix(surf, info.panel, mu, mv, phys.wallH / 2, horizontal ? pu - phys.wallT : phys.wallT * 2, horizontal ? phys.wallT * 2 : pv - phys.wallT, phys.wallH));
  });
  slotPick.instanceMatrix.needsUpdate = true;
  const cellPick = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }), Math.max(1, cells.length));
  cells.forEach((c, i) => {
    const info = topo.cell(c);
    const [pu, pv] = surf.metric(info.panel, info.u + 0.5, info.v + 0.5, 0);
    cellPick.setMatrixAt(i, frameMatrix(surf, info.panel, info.u + 0.5, info.v + 0.5, -phys.floorT / 2 + 0.2, pu - phys.wallT, pv - phys.wallT, phys.floorT));
  });
  cellPick.instanceMatrix.needsUpdate = true;
  root.add(slotPick, cellPick);

  const bbox = new THREE.Box3(v3(surf.bbox.min), v3(surf.bbox.max));
  return { root, layers: [...layers.entries()].map(([layer, group]) => ({ layer, group })), slotPick, slots, cellPick, cells, bbox, surface: surf, clippable };
}

/** Polyline through the centres of the solution cells, following the surface within a panel. */
export function buildSolutionLine(path: readonly CellId[], topo: Topology, phys: PhysicalParams, unfolded = false): THREE.Object3D {
  const surf = topo.surface(phys, unfolded);
  const h = phys.ballDia * 0.6;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < path.length; i++) {
    const a = topo.cell(path[i]!);
    pts.push(v3(surf.point(a.panel, a.u + 0.5, a.v + 0.5, h)));
    if (i + 1 < path.length) {
      const b = topo.cell(path[i + 1]!);
      if (b.panel === a.panel && surf.curved) {
        for (let s = 1; s < 4; s++) pts.push(v3(surf.point(a.panel, a.u + 0.5 + ((b.u - a.u) * s) / 4, a.v + 0.5 + ((b.v - a.v) * s) / 4, h)));
      }
    }
  }
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.0);
  const tube = new THREE.TubeGeometry(curve, Math.max(8, pts.length * 2), phys.ballDia * 0.18, 8, false);
  return new THREE.Mesh(tube, new THREE.MeshBasicMaterial({ color: COLORS.solution }));
}

export type LayerMode = 'solid' | 'ghost' | 'hidden';

const GHOST_OPACITY = 0.15;
/** Ghosted floor plates nearly vanish so the layers underneath stay readable. */
const GHOST_FLOOR_OPACITY = 0.05;

/** Show a layer group solid, translucent (context while editing another layer) or hidden. */
export function applyLayerMode(group: THREE.Group, mode: LayerMode): void {
  group.visible = mode !== 'hidden';
  const ghost = mode === 'ghost';
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const opacity = ghost ? (m.name === 'floor' ? GHOST_FLOOR_OPACITY : GHOST_OPACITY) : 1;
    for (const mat of mats) {
      if (mat.transparent === ghost && mat.opacity === opacity) continue;
      mat.transparent = ghost;
      mat.opacity = opacity;
      mat.depthWrite = !ghost;
      mat.needsUpdate = true;
    }
    m.castShadow = !ghost && m.userData.shadow === true;
  });
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
  });
}
