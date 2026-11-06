import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CellId } from '@core/model/ids';
import type { Maze } from '@core/model/maze';
import type { Topology } from '@core/model/topology';
import type { PhysicalParams } from '@core/layout/physical';
import { buildWorld } from '@core/sim/world';
import { BallSim, clampTilt, deg } from '@core/sim/ball';
import type { SimEvent, Tilt } from '@core/sim/ball';
import { Autopilot, ShellAutopilot } from '@core/sim/autopilot';
import { ShellController, ShellSim } from '@core/sim/shell';
import { applyLayerMode, buildMazeScene, buildSolutionLine, disposeObject, frameMatrix } from './mazeMesh';
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
  /** Boards: maximum tilt. */
  readonly maxTiltDeg: number;
  /** Shells: how fast the keys turn the object, degrees per second. */
  readonly turnDegPerS: number;
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
  /** Show the unfolded net instead of the real shape (shells, editing only). */
  readonly unfolded: boolean;
  /** Clip away the half of a closed shell nearest the camera. */
  readonly cutaway: boolean;
  /** Non-null while in play mode. */
  readonly play: PlaySettings | null;
  /** Incremented to ask for the ball to be put back at the start. */
  readonly resetTick: number;
}

interface BoardRun { kind: 'board'; sim: BallSim; pilot: Autopilot; target: Tilt }
interface ShellRun { kind: 'shell'; sim: ShellSim; ctl: ShellController; pilot: ShellAutopilot }

interface PlayRun {
  body: BoardRun | ShellRun;
  ball: THREE.Mesh;
  /** Glow ring under the ball (and a beacon through the layers above on boards). */
  marker: THREE.Group;
  view: PlaySettings['view'];
  zoomCells: number;
  dragStart: { x: number; y: number; tilt: Tilt } | null;
  dragLast: { x: number; y: number } | null;
  lastStatus: number;
  cellSize: number;
}

const UP = new THREE.Vector3(0, 0, 1);

/** three.js viewport: owns renderer, camera, controls, picking, the maze meshes and the play-mode ball. */
export class MazeViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly clock = new THREE.Clock();
  /** Rotates about the maze centre to show the board tilt / the shell's orientation. */
  private readonly tiltGroup = new THREE.Group();
  private readonly clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private clipping = false;
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
  private lastBallLayer = -1;

  constructor(private readonly container: HTMLElement, private readonly cb: ViewerCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.localClippingEnabled = true;
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
    el.addEventListener('pointerleave', () => { this.hover = null; this.highlight.visible = false; this.cb.onHover(''); if (this.run) { this.run.dragStart = null; this.run.dragLast = null; } });
    this.loop();
  }

  setState(next: ViewState): void {
    const prev = this.state;
    this.state = next;
    const unfolded = next.unfolded && !next.play;
    const prevUnfolded = !!prev && prev.unfolded && !prev.play;
    const rebuild = !prev || prev.maze !== next.maze || prev.phys !== next.phys || prev.heat !== next.heat || unfolded !== prevUnfolded;
    if (rebuild) this.rebuild(next, unfolded, !prev || prev.topo !== next.topo || prev.phys !== next.phys || unfolded !== prevUnfolded);
    if (next.play && (!this.run || rebuild)) this.startPlay(next);
    if (!next.play && this.run) this.stopPlay();
    if (this.run && next.resetTick !== this.lastReset) { this.lastReset = next.resetTick; this.resetBall(); }
    this.clipping = !!this.build && this.build.surface.closed && next.cutaway;
    for (const m of this.build?.clippable ?? []) m.clippingPlanes = this.clipping ? [this.clipPlane] : null;
    this.applyLayerModes();
    this.applySolution(next, unfolded);
  }

  private rebuild(s: ViewState, unfolded: boolean, refit: boolean): void {
    if (this.build) { this.tiltGroup.remove(this.build.root); disposeObject(this.build.root); }
    this.build = buildMazeScene(s.maze, s.topo, s.phys, s.heat, unfolded);
    const center = new THREE.Vector3(); this.build.bbox.getCenter(center);
    this.tiltGroup.position.copy(center);
    this.build.root.position.copy(center).negate();
    this.tiltGroup.add(this.build.root);
    this.tiltGroup.quaternion.copy(this.editPose(s, unfolded));
    if (refit) this.fit();
  }

  /** How the object sits while editing: a tube lies on its side (axis along x), everything else as modelled. */
  private editPose(s: ViewState, unfolded: boolean): THREE.Quaternion {
    const q = new THREE.Quaternion();
    if (s.topo.spec.kind === 'cylinder' && !unfolded) q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    return q;
  }

  /** World direction of the object's z axis (the tube axis for cylinders). */
  private axisWorld(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, 1).applyQuaternion(this.tiltGroup.quaternion);
  }

  private applyLayerModes(): void {
    if (!this.build || !this.state) return;
    const s = this.state;
    for (const l of this.build.layers) {
      let mode = s.layerModes[l.layer] ?? 'solid';
      if (this.run && s.play) {
        const ballLayer = this.ballLayer();
        if (s.play.xray) mode = l.layer > ballLayer ? 'ghost' : 'solid';
        else if (mode !== 'hidden') mode = 'solid';
        if (l.layer === ballLayer) mode = 'solid';
      }
      applyLayerMode(l.group, mode);
    }
  }

  private applySolution(s: ViewState, unfolded: boolean): void {
    if (this.solutionObj) { this.solutionObj.parent?.remove(this.solutionObj); disposeObject(this.solutionObj); this.solutionObj = null; }
    if (s.solution && s.solution.length > 1 && this.build) {
      this.solutionObj = buildSolutionLine(s.solution, s.topo, s.phys, unfolded);
      const m = (this.solutionObj as THREE.Mesh).material as THREE.Material;
      this.build.clippable.push(m);
      m.clippingPlanes = this.clipping ? [this.clipPlane] : null;
      this.build.root.add(this.solutionObj);
    }
  }

  // ---- play mode ---------------------------------------------------------------------------
  private ballLayer(): number {
    const b = this.run?.body;
    return b && b.kind === 'board' ? b.sim.state.layer : 0;
  }

  private resetBall(): void {
    const b = this.run?.body;
    if (!b) return;
    b.sim.reset();
    if (b.kind === 'shell') b.ctl.sync();
  }

  private startPlay(s: ViewState): void {
    if (!this.build) return;
    const prevBody = this.run?.body;
    this.stopPlay(false);
    const surf = this.build.surface;
    let body: BoardRun | ShellRun;
    let cellSize: number;
    if (surf.closed) {
      const sim = new ShellSim(s.maze, s.topo, s.phys);
      const ctl = new ShellController(sim);
      if (prevBody?.kind === 'shell' && prevBody.sim.state.phase === 'rolling') { Object.assign(sim.state, prevBody.sim.state); ctl.R = prevBody.ctl.R; ctl.sync(); }
      body = { kind: 'shell', sim, ctl, pilot: new ShellAutopilot(s.maze, s.topo, sim) };
      cellSize = surf.metric(sim.state.panel, sim.state.u, sim.state.v, sim.ballR)[0];
    } else {
      const world = buildWorld(s.maze, s.topo, s.phys);
      const sim = new BallSim(world);
      const keep = prevBody?.kind === 'board' ? prevBody.sim.state : null;
      if (keep && keep.phase === 'rolling' && keep.layer < world.layers.length && world.cellAt(keep.layer, keep.x, keep.y) !== null) {
        Object.assign(sim.state, keep, { z: world.layers[keep.layer]!.floorZ + world.ballR });
      }
      body = { kind: 'board', sim, pilot: new Autopilot(s.maze, s.topo, world), target: { x: 0, y: 0 } };
      cellSize = world.pitch;
    }
    const r = s.phys.ballDia / 2;
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(r, 32, 20),
      new THREE.MeshStandardMaterial({ color: 0xffa23a, emissive: 0xff7a00, emissiveIntensity: 0.55, metalness: 0.3, roughness: 0.35 }),
    );
    ball.castShadow = true;
    ball.name = 'playBall';
    this.build.root.add(ball);
    const marker = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(r * 1.6, r * 2.3, 40), new THREE.MeshBasicMaterial({ color: 0xffa23a, transparent: true, opacity: 0.8, depthTest: false, side: THREE.DoubleSide }));
    ring.renderOrder = 20;
    marker.add(ring);
    if (body.kind === 'board') {
      const world = body.sim.world;
      const beaconH = world.layerH * world.layers.length + world.layerH;
      const beacon = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.12, r * 0.12, beaconH, 8), new THREE.MeshBasicMaterial({ color: 0xffa23a, transparent: true, opacity: 0.35, depthTest: false }));
      beacon.rotation.x = Math.PI / 2;
      beacon.position.z = beaconH / 2;
      beacon.renderOrder = 20;
      marker.add(beacon);
    }
    this.build.root.add(marker);
    this.build.root.traverse((o) => { if (o.name === 'startBall') o.visible = false; });
    this.controls.mouseButtons.LEFT = null; // left drag steers while playing
    this.run = { body, ball, marker, view: 'free', zoomCells: 0, dragStart: null, dragLast: null, lastStatus: 0, cellSize };
    this.clock.getDelta();
    this.placeBall();
    this.applyPlayView(s.play!, true);
  }

  /** Put the camera straight above the ball (or the whole maze) looking down. */
  private applyPlayView(p: PlaySettings, force: boolean): void {
    const run = this.run;
    if (!run || !this.build) return;
    const changed = force || run.view !== p.view || run.zoomCells !== p.zoomCells;
    run.view = p.view; run.zoomCells = p.zoomCells;
    if (!changed || p.view === 'free') return;
    const fov = (this.camera.fov * Math.PI) / 180;
    let focus: THREE.Vector3, span: number;
    if (p.view === 'maze') {
      const size = new THREE.Vector3(); this.build.bbox.getSize(size);
      focus = this.tiltGroup.position.clone();
      span = this.build.surface.closed ? Math.max(size.x, size.y, size.z) * 1.08 : Math.max(size.x, size.y / this.camera.aspect) * 1.08;
    } else {
      focus = run.ball.getWorldPosition(new THREE.Vector3());
      span = p.zoomCells * run.cellSize;
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
    if (this.state) this.tiltGroup.quaternion.copy(this.editPose(this.state, this.state.unfolded));
    if (restore) this.build?.root.traverse((o) => { if (o.name === 'startBall') o.visible = true; });
  }

  /** Held-key direction (−1..1 per axis) from the keyboard. */
  setKeyTilt(x: number, y: number): void {
    this.keyTilt = { x, y };
  }

  /** Screen-right and screen-up as horizontal world directions (so controls feel the same from any heading). */
  private screenAxes(): { right: THREE.Vector3; up: THREE.Vector3 } {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0); right.z = 0;
    let up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1); up.z = 0;
    if (up.lengthSq() < 1e-6) { up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 2).negate(); up.z = 0; }
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    if (up.lengthSq() < 1e-6) up.set(0, 1, 0);
    return { right: right.normalize(), up: up.normalize() };
  }

  private placeBall(): void {
    const run = this.run;
    if (!run) return;
    const body = run.body;
    if (body.kind === 'board') {
      const b = body.sim.state;
      run.ball.position.set(b.x, b.y, b.z);
      run.marker.position.set(b.x, b.y, body.sim.world.layers[b.layer]!.floorZ + 0.3);
      run.marker.quaternion.identity();
      run.ball.visible = b.phase !== 'lost';
    } else {
      const b = body.sim.state;
      const p = body.sim.ballPoint();
      run.ball.position.set(p[0], p[1], p[2]);
      const m = frameMatrix(body.sim.surface, b.panel, b.u, b.v, 0.3, 1, 1, 1);
      run.marker.position.setFromMatrixPosition(m);
      run.marker.quaternion.setFromRotationMatrix(m);
      run.ball.visible = b.phase !== 'lost';
    }
    run.marker.visible = run.ball.visible;
  }

  private tickPlay(): void {
    const run = this.run, s = this.state;
    if (!run || !s || !s.play) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    this.applyPlayView(s.play, false);
    const body = run.body;
    let events: SimEvent[];
    let tilt: Tilt;
    if (body.kind === 'board') {
      const max = deg(s.play.maxTiltDeg);
      let target: Tilt;
      if (s.play.autopilot) target = clampTilt(body.pilot.control(body.sim.state), max);
      else if (run.dragStart) target = body.target;
      else target = { x: this.keyTilt.x * max, y: this.keyTilt.y * max };
      // the board tilts at a finite rate so the input feels like a real hand on the box
      const rate = deg(s.play.autopilot ? 240 : 90) * dt;
      const cur = body.sim.tilt;
      const ease = (c: number, t: number) => c + Math.max(-rate, Math.min(rate, t - c));
      body.sim.tilt = { x: ease(cur.x, target.x), y: ease(cur.y, target.y) };
      events = body.sim.step(dt * s.play.speed);
      this.tiltGroup.rotation.set(-body.sim.tilt.y, body.sim.tilt.x, 0);
      tilt = body.sim.tilt;
    } else {
      if (s.play.autopilot) {
        const st = body.pilot.worldSteer(body.ctl.R);
        body.ctl.steer(st.ref, st.d, st.angle, dt);
      } else if (!run.dragStart && (this.keyTilt.x !== 0 || this.keyTilt.y !== 0)) {
        const { right, up } = this.screenAxes();
        const d = right.multiplyScalar(this.keyTilt.x).add(up.multiplyScalar(this.keyTilt.y)).normalize();
        const axis = UP.clone().cross(d);
        body.ctl.rotate([axis.x, axis.y, axis.z], deg(s.play.turnDegPerS) * dt);
      }
      events = body.sim.step(dt * s.play.speed);
      const R = body.ctl.R;
      this.tiltGroup.quaternion.set(R[0], R[1], R[2], R[3]);
      // report how far the ball's floor is from level
      const n = body.sim.ballNormal();
      const nw = new THREE.Vector3(n[0], n[1], n[2]).applyQuaternion(this.tiltGroup.quaternion);
      tilt = { x: Math.acos(Math.max(-1, Math.min(1, nw.z))), y: 0 };
    }
    this.placeBall();
    if (s.play.follow && s.play.view !== 'maze') {
      const wp = run.ball.getWorldPosition(new THREE.Vector3());
      const delta = wp.sub(this.controls.target).multiplyScalar(Math.min(1, 6 * dt));
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
    const layer = this.ballLayer();
    if (events.length || layer !== this.lastBallLayer) { this.lastBallLayer = layer; this.applyLayerModes(); }
    const now = performance.now();
    if (events.length || now - run.lastStatus > 120) {
      run.lastStatus = now;
      const st = body.sim.state;
      const drops = body.kind === 'board' ? body.sim.state.drops : 0;
      this.cb.onPlay({ phase: st.phase, layer, elapsed: st.elapsed, drops, traps: st.traps, tiltX: tilt.x, tiltY: tilt.y }, events);
    }
  }

  // ---- camera ------------------------------------------------------------------------------
  fit(): void {
    if (!this.build) return;
    this.tiltGroup.updateMatrixWorld(true);
    const b = this.build.bbox.clone().applyMatrix4(this.build.root.matrixWorld);
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

  private updateClip(): void {
    if (!this.clipping) return;
    const c = this.tiltGroup.position;
    const n = c.clone().sub(this.camera.position).normalize();
    if (this.state?.topo.spec.kind === 'cylinder') {
      // keep the tube's axis in the cutting plane so the far half-pipe stays whole
      const a = this.axisWorld();
      n.sub(a.multiplyScalar(n.dot(a)));
      if (n.lengthSq() < 1e-6) n.set(0, 0, -1);
      n.normalize();
    }
    this.clipPlane.setFromNormalAndCoplanarPoint(n, c);
  }

  private loop = (): void => {
    this.frame = requestAnimationFrame(this.loop);
    this.resize();
    this.tickPlay();
    this.controls.update();
    this.updateClip();
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
      if (this.clipping && this.clipPlane.distanceToPoint(h.point) < 0) continue; // cut away
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
      const body = this.run.body;
      this.run.dragStart = { x: e.clientX, y: e.clientY, tilt: body.kind === 'board' ? body.sim.tilt : { x: 0, y: 0 } };
      this.run.dragLast = { x: e.clientX, y: e.clientY };
      if (body.kind === 'board') body.target = body.sim.tilt;
      this.renderer.domElement.setPointerCapture(e.pointerId);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.run) {
      const d = this.run.dragStart;
      if (d && this.state?.play) {
        const body = this.run.body;
        const { right, up } = this.screenAxes();
        if (body.kind === 'board') {
          const max = deg(this.state.play.maxTiltDeg);
          const gain = max / 140; // full tilt after 140 px of drag
          const dx = (e.clientX - d.x) * gain, dy = -(e.clientY - d.y) * gain;
          const dir = right.clone().multiplyScalar(dx).add(up.clone().multiplyScalar(dy));
          body.target = clampTilt({ x: d.tilt.x + dir.x, y: d.tilt.y + dir.y }, max);
        } else if (this.run.dragLast) {
          const dx = e.clientX - this.run.dragLast.x, dy = -(e.clientY - this.run.dragLast.y);
          this.run.dragLast = { x: e.clientX, y: e.clientY };
          const dir = right.multiplyScalar(dx).add(up.multiplyScalar(dy));
          const len = dir.length();
          if (len > 0) {
            const axis = UP.clone().cross(dir.normalize());
            body.ctl.rotate([axis.x, axis.y, axis.z], deg(0.35) * len);
          }
        }
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
    const where = (i: { layer: number; panel: number }) => (t.layerCount > 1 ? `layer ${i.layer}` : t.panels().length > 1 ? `face ${i.panel}` : '');
    if (hit.kind === 'slot') {
      const s = this.build.slots[hit.index]!;
      const ia = t.cell(s.a), ib = t.cell(s.b);
      this.cb.onHover(`wall between (${ia.u},${ia.v}) and (${ib.u},${ib.v}) ${where(ia)}`.trim());
    } else {
      const c = this.build.cells[hit.index]!;
      const i = t.cell(c);
      const flags = [this.state.maze.traps.has(c) ? 'trap' : '', this.state.maze.locked.has(c) ? 'locked' : '', this.state.maze.disabled.has(c) ? 'shaft' : '', c === this.state.maze.start ? 'start' : '', c === this.state.maze.goal ? 'goal' : ''].filter(Boolean).join(', ');
      this.cb.onHover(`cell (${i.u},${i.v}) ${where(i)}${flags ? ` — ${flags}` : ''}`.trim());
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.run) {
      if (this.run.dragStart) {
        this.run.dragStart = null; this.run.dragLast = null;
        if (this.run.body.kind === 'board') this.run.body.target = { x: 0, y: 0 };
      }
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
