import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CellId } from '@core/model/ids';
import type { Maze } from '@core/model/maze';
import type { Topology } from '@core/model/topology';
import type { PhysicalParams } from '@core/layout/physical';
import { buildWorld } from '@core/sim/world';
import { BallSim, clampTilt, deg } from '@core/sim/ball';
import type { SimEvent, Tilt } from '@core/sim/ball';
import { Autopilot } from '@core/sim/autopilot';
import { applyLayerMode, buildMazeScene, buildSolutionLine, disposeObject } from './mazeMesh';
import type { LayerMode, SceneBuild } from './mazeMesh';

export interface ViewerCallbacks {
  onSlot(a: CellId, b: CellId): void;
  onCell(c: CellId): void;
  onHover(text: string): void;
  onPlay(status: PlayStatus, events: SimEvent[]): void;
}

export interface PlaySettings {
  readonly autopilot: boolean;
  readonly follow: boolean;
  /** Ghost the layers above the ball so it stays visible. */
  readonly xray: boolean;
  readonly maxTiltDeg: number;
  /** Simulation speed multiplier. */
  readonly speed: number;
  /** Camera: straight down over the ball, the whole maze from above, or wherever the user left it. */
  readonly view: 'ball' | 'maze' | 'free';
  /** Cells visible across the viewport in the 'ball' view. */
  readonly zoomCells: number;
}

export interface PlayStatus {
  readonly phase: 'rolling' | 'falling' | 'lost' | 'won';
  readonly layer: number;
  readonly elapsed: number;
  readonly drops: number;
  readonly traps: number;
  readonly tiltX: number;
  readonly tiltY: number;
}

export interface ViewState {
  readonly maze: Maze;
  readonly topo: Topology;
  readonly phys: PhysicalParams;
  readonly activeLayer: number;
  /** Effective display mode per layer. */
  readonly layerModes: readonly LayerMode[];
  readonly solution: readonly CellId[] | null;
  readonly heat: Int32Array | null;
  /** 'slot' tools pick walls, 'cell' tools pick floors. */
  readonly pickMode: 'slot' | 'cell';
  /** Non-null while in play mode. */
  readonly play: PlaySettings | null;
  /** Incremented to ask for the ball to be put back at the start. */
  readonly resetTick: number;
}

interface PlayRun {
  sim: BallSim;
  pilot: Autopilot;
  ball: THREE.Mesh;
  /** Glow ring on the floor and a beacon up through the layers above, so the ball reads through ghosted levels. */
  marker: THREE.Group;
  view: PlaySettings['view'];
  zoomCells: number;
  target: Tilt;
  dragStart: { x: number; y: number; tilt: Tilt } | null;
  lastStatus: number;
}

/** three.js viewport: owns renderer, camera, controls, picking, the maze meshes and the play-mode ball. */
export class MazeViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly clock = new THREE.Clock();
  /** Rotates about the maze centre to show the board tilt. */
  private readonly tiltGroup = new THREE.Group();
  private build: SceneBuild | null = null;
  private solutionObj: THREE.Object3D | null = null;
  private highlight: THREE.Mesh;
  private state: ViewState | null = null;
  private lastSize = '';
  private hover: { kind: 'slot' | 'cell'; index: number } | null = null;
  private downAt: { x: number; y: number } | null = null;
  private frame = 0;
  private run: PlayRun | null = null;
  private keyTilt: Tilt = { x: 0, y: 0 };
  private lastReset = 0;

  constructor(private readonly container: HTMLElement, private readonly cb: ViewerCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x1b2230);
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
    this.scene.add(hemi, key, this.tiltGroup);
    this.highlight = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x35c9c0, transparent: true, opacity: 0.5, depthTest: false }));
    this.highlight.visible = false;
    this.highlight.renderOrder = 10;
    this.scene.add(this.highlight);

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    el.addEventListener('pointerup', (e) => this.onPointerUp(e));
    el.addEventListener('pointerleave', () => { this.hover = null; this.highlight.visible = false; this.cb.onHover(''); if (this.run) this.run.dragStart = null; });
    this.loop();
  }

  setState(next: ViewState): void {
    const prev = this.state;
    this.state = next;
    const rebuild = !prev || prev.maze !== next.maze || prev.phys !== next.phys || prev.heat !== next.heat;
    if (rebuild) this.rebuild(next, !prev || prev.topo !== next.topo || prev.phys !== next.phys);
    if (next.play && (!this.run || rebuild)) this.startPlay(next);
    if (!next.play && this.run) this.stopPlay();
    if (this.run && next.resetTick !== this.lastReset) { this.lastReset = next.resetTick; this.run.sim.reset(); }
    this.applyLayerModes();
    this.applySolution(next);
  }

  private rebuild(s: ViewState, refit: boolean): void {
    if (this.build) { this.tiltGroup.remove(this.build.root); disposeObject(this.build.root); }
    this.build = buildMazeScene(s.maze, s.topo, s.phys, s.heat);
    // tilt about the centre of the maze
    const center = new THREE.Vector3(); this.build.bbox.getCenter(center);
    this.tiltGroup.position.copy(center);
    this.build.root.position.copy(center).negate();
    this.tiltGroup.add(this.build.root);
    if (refit) this.fit();
  }

  private applyLayerModes(): void {
    if (!this.build || !this.state) return;
    const s = this.state;
    for (const l of this.build.layers) {
      let mode = s.layerModes[l.layer] ?? 'solid';
      if (this.run && s.play) {
        const ballLayer = this.run.sim.state.layer;
        if (s.play.xray) mode = l.layer > ballLayer ? 'ghost' : 'solid';
        else if (mode !== 'hidden') mode = 'solid';
        if (l.layer === ballLayer) mode = 'solid';
      }
      applyLayerMode(l.group, mode);
    }
  }

  private applySolution(s: ViewState): void {
    if (this.solutionObj) { this.build?.root.remove(this.solutionObj); disposeObject(this.solutionObj); this.solutionObj = null; }
    if (s.solution && s.solution.length > 1 && this.build) {
      this.solutionObj = buildSolutionLine(s.solution, s.topo, s.phys);
      this.build.root.add(this.solutionObj);
    }
  }

  // ---- play mode ---------------------------------------------------------------------------
  private startPlay(s: ViewState): void {
    if (!this.build) return;
    const keep = this.run?.sim.state;
    this.stopPlay(false);
    const world = buildWorld(s.maze, s.topo, s.phys);
    const sim = new BallSim(world);
    if (keep && keep.phase === 'rolling' && world.cellAt(keep.layer, keep.x, keep.y) !== null && keep.layer < world.layers.length) {
      Object.assign(sim.state, keep, { z: world.layers[keep.layer]!.floorZ + world.ballR });
    }
    const pilot = new Autopilot(s.maze, s.topo, world);
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(world.ballR, 32, 20),
      new THREE.MeshStandardMaterial({ color: 0xffa23a, emissive: 0xff7a00, emissiveIntensity: 0.55, metalness: 0.3, roughness: 0.35 }),
    );
    ball.castShadow = true;
    ball.name = 'playBall';
    this.build.root.add(ball);
    const marker = new THREE.Group();
    const r = world.ballR;
    const ring = new THREE.Mesh(new THREE.RingGeometry(r * 1.6, r * 2.3, 40), new THREE.MeshBasicMaterial({ color: 0xffa23a, transparent: true, opacity: 0.8, depthTest: false, side: THREE.DoubleSide }));
    ring.renderOrder = 20;
    const beaconH = world.layerH * world.layers.length + world.layerH;
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.12, r * 0.12, beaconH, 8), new THREE.MeshBasicMaterial({ color: 0xffa23a, transparent: true, opacity: 0.35, depthTest: false }));
    beacon.rotation.x = Math.PI / 2;
    beacon.position.z = beaconH / 2;
    beacon.renderOrder = 20;
    marker.add(ring, beacon);
    this.build.root.add(marker);
    this.build.root.traverse((o) => { if (o.name === 'startBall') o.visible = false; });
    this.controls.mouseButtons.LEFT = null; // left drag tilts the board while playing
    this.run = { sim, pilot, ball, marker, view: 'free', zoomCells: 0, target: { x: 0, y: 0 }, dragStart: null, lastStatus: 0 };
    this.clock.getDelta();
    this.applyPlayView(s.play!, true);
  }

  /** Put the camera straight above the ball (or the whole maze) looking down. */
  private applyPlayView(p: PlaySettings, force: boolean): void {
    const run = this.run;
    if (!run || !this.build) return;
    const changed = force || run.view !== p.view || run.zoomCells !== p.zoomCells;
    run.view = p.view; run.zoomCells = p.zoomCells;
    if (!changed || p.view === 'free') return;
    const world = run.sim.world;
    const fov = (this.camera.fov * Math.PI) / 180;
    let focus: THREE.Vector3, span: number;
    if (p.view === 'maze') {
      const size = new THREE.Vector3(); this.build.bbox.getSize(size);
      focus = new THREE.Vector3(); this.build.bbox.getCenter(focus);
      span = Math.max(size.x, size.y / this.camera.aspect) * 1.08;
    } else {
      focus = run.ball.getWorldPosition(new THREE.Vector3());
      span = p.zoomCells * world.pitch;
    }
    const dist = span / 2 / Math.tan(fov / 2);
    this.controls.target.copy(focus);
    // a hair off vertical so the orbit controls keep a defined heading (north up)
    this.camera.position.set(focus.x, focus.y - dist * 0.001, focus.z + dist);
    this.camera.near = Math.max(0.1, dist / 100);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** Re-frame the current play view (f while playing). */
  reframe(): void {
    if (this.state?.play) this.applyPlayView(this.state.play, true);
    else this.fit();
  }

  private stopPlay(restore = true): void {
    if (!this.run) return;
    this.build?.root.remove(this.run.ball, this.run.marker);
    disposeObject(this.run.ball);
    disposeObject(this.run.marker);
    this.run = null;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this.tiltGroup.rotation.set(0, 0, 0);
    if (restore) this.build?.root.traverse((o) => { if (o.name === 'startBall') o.visible = true; });
  }

  /** Held-key direction (−1..1 per axis) from the keyboard. */
  setKeyTilt(x: number, y: number): void {
    this.keyTilt = { x, y };
  }

  private tickPlay(): void {
    const run = this.run, s = this.state;
    if (!run || !s || !s.play) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    this.applyPlayView(s.play, false);
    const max = deg(s.play.maxTiltDeg);
    let target: Tilt;
    if (s.play.autopilot) {
      target = clampTilt(run.pilot.control(run.sim.state), max);
    } else if (run.dragStart) {
      target = run.target;
    } else {
      target = { x: this.keyTilt.x * max, y: this.keyTilt.y * max };
    }
    // the board tilts at a finite rate so the input feels like a real hand on the box
    const rate = deg(s.play.autopilot ? 240 : 90) * dt;
    const cur = run.sim.tilt;
    const ease = (c: number, t: number) => c + Math.max(-rate, Math.min(rate, t - c));
    run.sim.tilt = { x: ease(cur.x, target.x), y: ease(cur.y, target.y) };
    const events = run.sim.step(dt * s.play.speed);
    const b = run.sim.state;
    run.ball.position.set(b.x, b.y, b.z);
    run.ball.visible = b.phase !== 'lost';
    run.marker.visible = run.ball.visible;
    run.marker.position.set(b.x, b.y, run.sim.world.layers[b.layer]!.floorZ + 0.3);
    this.tiltGroup.rotation.set(-run.sim.tilt.y, run.sim.tilt.x, 0);
    if (s.play.follow && s.play.view !== 'maze') {
      const wp = run.ball.getWorldPosition(new THREE.Vector3());
      const delta = wp.sub(this.controls.target).multiplyScalar(Math.min(1, 6 * dt));
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
    if (events.length || b.layer !== this.lastBallLayer) { this.lastBallLayer = b.layer; this.applyLayerModes(); }
    const now = performance.now();
    if (events.length || now - run.lastStatus > 120) {
      run.lastStatus = now;
      this.cb.onPlay({ phase: b.phase, layer: b.layer, elapsed: b.elapsed, drops: b.drops, traps: b.traps, tiltX: run.sim.tilt.x, tiltY: run.sim.tilt.y }, events);
    }
  }
  private lastBallLayer = -1;

  // ---- camera ------------------------------------------------------------------------------
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
    this.tickPlay();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // ---- picking -----------------------------------------------------------------------------
  private pick(e: PointerEvent): { kind: 'slot' | 'cell'; index: number; point: THREE.Vector3 } | null {
    if (!this.build || !this.state || this.run) return null;
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
      if ((this.state.layerModes[layer] ?? 'solid') !== 'solid') continue; // ghosted / hidden layers are context only
      return { kind: mode, index: h.instanceId, point: h.point };
    }
    return null;
  }

  private onPointerDown(e: PointerEvent): void {
    this.downAt = { x: e.clientX, y: e.clientY };
    if (this.run && e.button === 0 && this.state?.play && !this.state.play.autopilot) {
      this.run.dragStart = { x: e.clientX, y: e.clientY, tilt: this.run.sim.tilt };
      this.run.target = this.run.sim.tilt;
      this.renderer.domElement.setPointerCapture(e.pointerId);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.run) {
      const d = this.run.dragStart;
      if (d && this.state?.play) {
        const max = deg(this.state.play.maxTiltDeg);
        const gain = max / 140; // full tilt after 140 px of drag
        // screen x → +x tilt, screen y (down) → −y tilt, rotated by the camera's heading so "drag right" means right on screen
        const dx = (e.clientX - d.x) * gain, dy = -(e.clientY - d.y) * gain;
        const heading = Math.atan2(this.camera.position.y - this.controls.target.y, this.camera.position.x - this.controls.target.x) + Math.PI / 2;
        const c = Math.cos(heading), sn = Math.sin(heading);
        this.run.target = clampTilt({ x: d.tilt.x + dx * c - dy * sn, y: d.tilt.y + dx * sn + dy * c }, max);
      }
      return;
    }
    const hit = this.pick(e);
    if (!hit || !this.build || !this.state) {
      this.hover = null; this.highlight.visible = false; this.cb.onHover('');
      return;
    }
    this.hover = { kind: hit.kind, index: hit.index };
    const m = new THREE.Matrix4();
    (hit.kind === 'slot' ? this.build.slotPick : this.build.cellPick).getMatrixAt(hit.index, m);
    this.highlight.matrixAutoUpdate = false;
    this.highlight.matrix.copy(m).premultiply(this.build.root.matrixWorld);
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
    if (this.run) {
      if (this.run.dragStart) { this.run.dragStart = null; this.run.target = { x: 0, y: 0 }; }
      this.downAt = null;
      return;
    }
    const d = this.downAt; this.downAt = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return; // a drag, not a click
    const hit = this.pick(e);
    if (!hit || !this.build) return;
    if (hit.kind === 'slot') { const s = this.build.slots[hit.index]!; this.cb.onSlot(s.a, s.b); }
    else this.cb.onCell(this.build.cells[hit.index]!);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.stopPlay(false);
    if (this.build) disposeObject(this.build.root);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
