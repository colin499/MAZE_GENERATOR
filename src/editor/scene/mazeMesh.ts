import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CellId } from '@core/model/ids';
import { edgeKey } from '@core/model/ids';
import type { Maze } from '@core/model/maze';
import type { Topology } from '@core/model/topology';
import { SIDES, cellsOnLayer, wallSegment } from '@core/model/topology';
import type { PhysicalParams } from '@core/layout/physical';
import { layerHOf, pitchOf } from '@core/layout/physical';
import { mergeRuns } from '@core/layout/runs';
import type { UnitSeg } from '@core/layout/runs';

export const COLORS = {
  floor: 0x3b4048,
  floorLocked: 0x4a4330,
  wall: 0xb9bec8,
  bridge: 0xffb454,
  trap: 0xff5a5a,
  dropout: 0x6fb7ff,
  goal: 0x5ad17a,
  start: 0xffffff,
  shaft: 0x15171c,
  solution: 0x5ad17a,
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
}

const box = (w: number, d: number, h: number) => new THREE.BoxGeometry(w, d, h);

function place(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  return g.translate(x, y, z);
}

/** Build all visible geometry for a maze in mm, z up. */
export function buildMazeScene(maze: Maze, topo: Topology, phys: PhysicalParams, heat?: Int32Array | null): SceneBuild {
  const pitch = pitchOf(phys);
  const layerH = layerHOf(phys);
  const root = new THREE.Group();
  const layers: LayerMeshes[] = [];
  const slots: SlotRef[] = [];
  const cells: CellId[] = [];
  const wallMat = new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.8, metalness: 0.05 });
  const bridgeMat = new THREE.MeshStandardMaterial({ color: COLORS.bridge, roughness: 0.7 });
  const floorMat = new THREE.MeshStandardMaterial({ color: COLORS.floor, roughness: 0.95 });
  const maxHeat = heat ? heat.reduce((a, b) => Math.max(a, b), 0) : 0;

  for (const panel of topo.panels()) {
    const k = panel.layer;
    const z0 = k * layerH;
    const group = new THREE.Group();
    group.name = `layer-${k}`;
    const W = panel.w * pitch, H = panel.h * pitch;
    const layerCells = cellsOnLayer(topo, k);

    // floor: one plate, plus per-cell colour tiles for locks / heat / shafts
    const floor = new THREE.Mesh(place(box(W + phys.wallT, H + phys.wallT, phys.floorT), W / 2, H / 2, z0 + phys.floorT / 2), floorMat);
    floor.receiveShadow = true;
    group.add(floor);
    const tiles: THREE.BufferGeometry[] = [];
    const tileColors: number[] = [];
    for (const c of layerCells) {
      const i = topo.cell(c);
      let color: number | null = null;
      if (maze.disabled.has(c)) color = COLORS.shaft;
      else if (maze.locked.has(c)) color = COLORS.floorLocked;
      else if (heat && maxHeat > 0 && heat[c]! > 0) {
        const tcol = new THREE.Color().setHSL(0.12 - 0.12 * (heat[c]! / maxHeat), 0.8, 0.3 + 0.2 * (heat[c]! / maxHeat));
        color = tcol.getHex();
      }
      if (color === null) continue;
      const g = place(box(phys.chanW, phys.chanW, 0.3), (i.u + 0.5) * pitch, (i.v + 0.5) * pitch, z0 + phys.floorT + 0.15);
      const col = new THREE.Color(color);
      const n = g.getAttribute('position').count;
      for (let j = 0; j < n; j++) tileColors.push(col.r, col.g, col.b);
      tiles.push(g);
    }
    if (tiles.length) {
      const merged = mergeGeometries(tiles)!;
      merged.setAttribute('color', new THREE.Float32BufferAttribute(tileColors, 3));
      group.add(new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));
    }

    // walls
    const wallSegs: UnitSeg[] = [];
    const bridgeSegs: UnitSeg[] = [];
    for (const c of layerCells) {
      const info = topo.cell(c);
      for (const s of SIDES) {
        const nb = topo.side(c, s);
        if (nb !== null && nb < c) continue;
        const seg = wallSegment(info, s);
        if (nb === null) { wallSegs.push(seg); continue; }
        slots.push({ a: c, b: nb, layer: k });
        const e = maze.edges.get(edgeKey(c, nb));
        if (!e) wallSegs.push(seg);
        else if (e.kind === 'tunnel') bridgeSegs.push(seg);
      }
    }
    const runGeoms = (segs: UnitSeg[], zBase: number, height: number) =>
      mergeRuns(segs).map((r) => {
        const horizontal = r.from[1] === r.to[1];
        const len = r.length * pitch + phys.wallT;
        const cx = ((r.from[0] + r.to[0]) / 2) * pitch;
        const cy = ((r.from[1] + r.to[1]) / 2) * pitch;
        return place(horizontal ? box(len, phys.wallT, height) : box(phys.wallT, len, height), cx, cy, zBase + height / 2);
      });
    const wallGeom = runGeoms(wallSegs, z0 + phys.floorT, phys.wallH);
    if (wallGeom.length) {
      const m = new THREE.Mesh(mergeGeometries(wallGeom)!, wallMat);
      m.castShadow = true;
      group.add(m);
    }
    const bridgeGeom = runGeoms(bridgeSegs, z0 + phys.floorT + phys.bridgeLift, phys.wallH - phys.bridgeLift);
    if (bridgeGeom.length) group.add(new THREE.Mesh(mergeGeometries(bridgeGeom)!, bridgeMat));

    // holes and markers
    const ring = (c: CellId, color: number, r: number, zOff = 0) => {
      const i = topo.cell(c);
      const g = new THREE.RingGeometry(r * 0.72, r, 32);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.position.set((i.u + 0.5) * pitch, (i.v + 0.5) * pitch, z0 + phys.floorT + 0.4 + zOff);
      group.add(m);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(r * 0.72, 32), new THREE.MeshBasicMaterial({ color: 0x0b0c10 }));
      hole.position.copy(m.position);
      group.add(hole);
    };
    for (const e of maze.edges.values()) {
      if (e.kind !== 'dropout' && e.kind !== 'ramp') continue;
      const upper = e.from ?? (topo.cell(e.a).layer > topo.cell(e.b).layer ? e.a : e.b);
      if (topo.cell(upper).layer === k) ring(upper, COLORS.dropout, phys.holeDia / 2);
    }
    for (const c of maze.traps) if (topo.cell(c).layer === k) ring(c, COLORS.trap, phys.holeDia / 2);
    if (topo.cell(maze.goal).layer === k) ring(maze.goal, COLORS.goal, phys.holeDia / 2, 0.1);
    if (topo.cell(maze.start).layer === k) {
      const i = topo.cell(maze.start);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(phys.ballDia / 2, 24, 16), new THREE.MeshStandardMaterial({ color: COLORS.start, metalness: 0.6, roughness: 0.3 }));
      ball.position.set((i.u + 0.5) * pitch, (i.v + 0.5) * pitch, z0 + phys.floorT + phys.ballDia / 2);
      group.add(ball);
    }

    for (const c of layerCells) cells.push(c);
    root.add(group);
    layers.push({ layer: k, group });
  }

  // pick targets
  const slotGeom = box(1, 1, 1);
  const slotPick = new THREE.InstancedMesh(slotGeom, new THREE.MeshBasicMaterial({ visible: false }), Math.max(1, slots.length));
  const mat = new THREE.Matrix4();
  slots.forEach((s, i) => {
    const info = topo.cell(s.a);
    const side = SIDES.find((sd) => topo.side(s.a, sd) === s.b)!;
    const seg = wallSegment(info, side);
    const horizontal = seg[0][1] === seg[1][1];
    const cx = ((seg[0][0] + seg[1][0]) / 2) * pitch, cy = ((seg[0][1] + seg[1][1]) / 2) * pitch;
    const z0 = s.layer * layerH + phys.floorT;
    mat.makeScale(horizontal ? pitch - phys.wallT : phys.wallT * 2, horizontal ? phys.wallT * 2 : pitch - phys.wallT, phys.wallH);
    mat.setPosition(cx, cy, z0 + phys.wallH / 2);
    slotPick.setMatrixAt(i, mat);
  });
  slotPick.instanceMatrix.needsUpdate = true;
  const cellPick = new THREE.InstancedMesh(box(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }), Math.max(1, cells.length));
  cells.forEach((c, i) => {
    const info = topo.cell(c);
    mat.makeScale(phys.chanW, phys.chanW, phys.floorT);
    mat.setPosition((info.u + 0.5) * pitch, (info.v + 0.5) * pitch, info.layer * layerH + phys.floorT / 2 + 0.2);
    cellPick.setMatrixAt(i, mat);
  });
  cellPick.instanceMatrix.needsUpdate = true;
  root.add(slotPick, cellPick);

  const bbox = new THREE.Box3().setFromObject(root);
  return { root, layers, slotPick, slots, cellPick, cells, bbox };
}

/** Polyline through the centres of the solution cells. */
export function buildSolutionLine(path: readonly CellId[], topo: Topology, phys: PhysicalParams): THREE.Object3D {
  const pitch = pitchOf(phys), layerH = layerHOf(phys);
  const pts = path.map((c) => {
    const i = topo.cell(c);
    return new THREE.Vector3((i.u + 0.5) * pitch, (i.v + 0.5) * pitch, i.layer * layerH + phys.floorT + phys.ballDia * 0.6);
  });
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.0);
  const tube = new THREE.TubeGeometry(curve, Math.max(8, pts.length * 3), phys.ballDia * 0.18, 8, false);
  return new THREE.Mesh(tube, new THREE.MeshBasicMaterial({ color: COLORS.solution }));
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
