import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CellId } from '@core/model/ids';
import type { Maze } from '@core/model/maze';
import type { Topology } from '@core/model/topology';
import type { PhysicalParams } from '@core/layout/physical';
import { buildMazeScene, buildSolutionLine, disposeObject } from './mazeMesh';
import type { SceneBuild } from './mazeMesh';

export interface ViewerCallbacks {
  onSlot(a: CellId, b: CellId): void;
  onCell(c: CellId): void;
  onHover(text: string): void;
}

export interface ViewState {
  readonly maze: Maze;
  readonly topo: Topology;
  readonly phys: PhysicalParams;
  readonly activeLayer: number;
  readonly solution: readonly CellId[] | null;
  readonly heat: Int32Array | null;
  /** 'slot' tools pick walls, 'cell' tools pick floors. */
  readonly pickMode: 'slot' | 'cell';
}

/** three.js viewport: owns renderer, camera, controls, picking and the current maze meshes. */
export class MazeViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private build: SceneBuild | null = null;
  private solutionObj: THREE.Object3D | null = null;
  private highlight: THREE.Mesh;
  private state: ViewState | null = null;
  private lastSize = '';
  private hover: { kind: 'slot' | 'cell'; index: number } | null = null;
  private downAt: { x: number; y: number } | null = null;
  private frame = 0;

  constructor(private readonly container: HTMLElement, private readonly cb: ViewerCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x15171c);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x334, 0.9);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(120, -160, 260);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    this.scene.add(hemi, key);
    this.highlight = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.45, depthTest: false }));
    this.highlight.visible = false;
    this.highlight.renderOrder = 10;
    this.scene.add(this.highlight);

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    el.addEventListener('pointerdown', (e) => { this.downAt = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => this.onPointerUp(e));
    el.addEventListener('pointerleave', () => { this.hover = null; this.highlight.visible = false; this.cb.onHover(''); });
    this.loop();
  }

  setState(next: ViewState): void {
    const prev = this.state;
    this.state = next;
    const rebuild = !prev || prev.maze !== next.maze || prev.phys !== next.phys || prev.heat !== next.heat;
    if (rebuild) this.rebuild(next, !prev || prev.topo !== next.topo || prev.phys !== next.phys);
    this.applyLayerVisibility(next.activeLayer);
    this.applySolution(next);
  }

  private rebuild(s: ViewState, refit: boolean): void {
    if (this.build) { this.scene.remove(this.build.root); disposeObject(this.build.root); }
    this.build = buildMazeScene(s.maze, s.topo, s.phys, s.heat);
    this.scene.add(this.build.root);
    if (refit) this.fit();
  }

  private applyLayerVisibility(active: number): void {
    if (!this.build) return;
    for (const l of this.build.layers) l.group.visible = active < 0 || l.layer === active;
  }

  private applySolution(s: ViewState): void {
    if (this.solutionObj) { this.scene.remove(this.solutionObj); disposeObject(this.solutionObj); this.solutionObj = null; }
    if (s.solution && s.solution.length > 1) {
      this.solutionObj = buildSolutionLine(s.solution, s.topo, s.phys);
      this.scene.add(this.solutionObj);
    }
  }

  fit(): void {
    if (!this.build) return;
    const b = this.build.bbox;
    const size = new THREE.Vector3(); b.getSize(size);
    const center = new THREE.Vector3(); b.getCenter(center);
    const radius = Math.max(size.x, size.y, size.z) * 0.9;
    this.controls.target.copy(center);
    this.camera.position.set(center.x - radius * 0.9, center.y - radius * 1.3, center.z + radius * 1.2);
    this.camera.near = radius / 100;
    this.camera.far = radius * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  viewTop(): void {
    if (!this.build) return;
    const b = this.build.bbox;
    const size = new THREE.Vector3(); b.getSize(size);
    const center = new THREE.Vector3(); b.getCenter(center);
    this.controls.target.copy(center);
    this.camera.position.set(center.x, center.y - 0.001, center.z + Math.max(size.x, size.y) * 1.5);
    this.controls.update();
  }

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const key = `${w}x${h}`;
    if (key === this.lastSize || w === 0 || h === 0) return;
    this.lastSize = key;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (): void => {
    this.frame = requestAnimationFrame(this.loop);
    this.resize();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private pick(e: PointerEvent): { kind: 'slot' | 'cell'; index: number; point: THREE.Vector3 } | null {
    if (!this.build || !this.state) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const mode = this.state.pickMode;
    const target = mode === 'slot' ? this.build.slotPick : this.build.cellPick;
    const refs = mode === 'slot' ? this.build.slots : this.build.cells;
    const hits = this.raycaster.intersectObject(target, false);
    const active = this.state.activeLayer;
    for (const h of hits) {
      if (h.instanceId === undefined) continue;
      const layer = mode === 'slot' ? (refs as { layer: number }[])[h.instanceId]!.layer : this.state.topo.cell((refs as CellId[])[h.instanceId]!).layer;
      if (active >= 0 && layer !== active) continue;
      return { kind: mode, index: h.instanceId, point: h.point };
    }
    return null;
  }

  private onPointerMove(e: PointerEvent): void {
    const hit = this.pick(e);
    if (!hit || !this.build || !this.state) {
      this.hover = null; this.highlight.visible = false; this.cb.onHover('');
      return;
    }
    this.hover = { kind: hit.kind, index: hit.index };
    const m = new THREE.Matrix4();
    (hit.kind === 'slot' ? this.build.slotPick : this.build.cellPick).getMatrixAt(hit.index, m);
    this.highlight.matrixAutoUpdate = false;
    this.highlight.matrix.copy(m);
    this.highlight.visible = true;
    const t = this.state.topo;
    if (hit.kind === 'slot') {
      const s = this.build.slots[hit.index]!;
      const ia = t.cell(s.a), ib = t.cell(s.b);
      this.cb.onHover(`wall between (${ia.u},${ia.v}) and (${ib.u},${ib.v}) on layer ${ia.layer}`);
    } else {
      const c = this.build.cells[hit.index]!;
      const i = t.cell(c);
      const flags = [this.state.maze.traps.has(c) ? 'trap' : '', this.state.maze.locked.has(c) ? 'locked' : '', this.state.maze.disabled.has(c) ? 'shaft' : '', c === this.state.maze.start ? 'start' : '', c === this.state.maze.goal ? 'goal' : ''].filter(Boolean).join(', ');
      this.cb.onHover(`cell (${i.u},${i.v}) layer ${i.layer}${flags ? ` — ${flags}` : ''}`);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.downAt; this.downAt = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return; // a drag, not a click
    const hit = this.pick(e);
    if (!hit || !this.build) return;
    if (hit.kind === 'slot') { const s = this.build.slots[hit.index]!; this.cb.onSlot(s.a, s.b); }
    else this.cb.onCell(this.build.cells[hit.index]!);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    if (this.build) disposeObject(this.build.root);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
