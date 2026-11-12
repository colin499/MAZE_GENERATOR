import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Poly, RotaryMaze } from '@core/rotary/model';
import { trenchAt } from '@core/rotary/model';
import { RotarySim } from '@core/rotary/sim';
import type { RotaryEvent } from '@core/rotary/sim';
import { DemoPlayer } from '@core/rotary/demo';
import type { RotaryCommand, RotarySettings, RotaryStatus } from './state';

const RAD = Math.PI / 180;

function shapesOf(polys: readonly Poly[]): THREE.Shape[] {
  return polys.map((p) => {
    const sh = new THREE.Shape(p.outer.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of p.holes) sh.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    return sh;
  });
}

function dispose(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
  });
}

export interface RotaryViewerCallbacks {
  onStatus(s: RotaryStatus): void;
  onEvent(e: RotaryEvent): void;
  onDemoEnd(): void;
}

/** three.js view of a rotary maze with a live ball simulation or a recorded demo. z is up; the board lies in xy. */
export class RotaryViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly board = new THREE.Group();
  private readonly dial = new THREE.Group();
  private readonly ball: THREE.Mesh;
  private readonly trail: THREE.Line;
  private trailPts: THREE.Vector3[] = [];
  private maze: RotaryMaze;
  private sim: RotarySim;
  private demo: { player: DemoPlayer; t: number } | null = null;
  private settings: RotarySettings = { maxTiltDeg: 6, speed: 1, showTilt: true };
  private keyTilt = { x: 0, y: 0 };
  private dragTilt: { x: number; y: number } | null = null;
  private shownTilt = { x: 0, y: 0 };
  private raf = 0;
  private last = 0;
  private readonly ro: ResizeObserver;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly host: HTMLElement, maze: RotaryMaze, private readonly cb: RotaryViewerCallbacks) {
    this.maze = maze;
    this.sim = new RotarySim(maze);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x1b2230);
    this.camera = new THREE.PerspectiveCamera(32, 1, 10, 2000);
    this.camera.up.set(0, 1, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: -1 as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.enablePan = false;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-60, -80, 220);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 50; sc.far = 500;
    this.scene.add(sun);
    this.scene.add(this.board);
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), new THREE.MeshStandardMaterial({ color: 0xe23b3b, roughness: 0.25, metalness: 0.3 }));
    this.ball.castShadow = true;
    this.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff7a7a }));
    this.build();
    this.viewTop();

    const el = this.renderer.domElement;
    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => { if (e.button === 0) { drag = { x: e.clientX, y: e.clientY }; this.dragTilt = { x: 0, y: 0 }; el.setPointerCapture(e.pointerId); } };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const k = 1 / 90;
      this.dragTilt = { x: Math.max(-1, Math.min(1, (e.clientX - drag.x) * k)), y: Math.max(-1, Math.min(1, -(e.clientY - drag.y) * k)) };
    };
    const up = (e: PointerEvent) => { if (e.button === 0) { drag = null; this.dragTilt = null; } };
    const menu = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('contextmenu', menu);
    this.cleanup.push(() => { el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.removeEventListener('contextmenu', menu); });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.last = performance.now();
    const loop = (now: number) => { this.raf = requestAnimationFrame(loop); this.frame(Math.min(0.05, (now - this.last) / 1000)); this.last = now; };
    this.raf = requestAnimationFrame(loop);
  }

  setMaze(maze: RotaryMaze): void {
    if (maze === this.maze) return;
    this.maze = maze;
    this.sim = new RotarySim(maze);
    this.demo = null;
    this.build();
    this.viewTop();
  }

  setSettings(s: RotarySettings): void { this.settings = s; }
  setKeyTilt(x: number, y: number): void { this.keyTilt = { x, y }; }

  command(cmd: RotaryCommand): void {
    if (cmd.kind === 'top') { this.viewTop(); return; }
    if (this.demo) return;
    if (cmd.kind === 'turn') this.sim.turn(cmd.delta);
    else { this.sim.reset(cmd.dial); this.trailPts = []; }
  }

  /** Start a recorded demo (index into maze.demos) or go back to live play with -1. */
  playDemo(index: number): void {
    const d = this.maze.demos[index];
    this.trailPts = [];
    if (!d) { this.demo = null; this.sim.reset(this.sim.position); return; }
    this.demo = { player: new DemoPlayer(this.maze, d), t: 0 };
  }

  viewTop(): void {
    const d = this.maze.outerR * 2 * 1.18 / (2 * Math.tan(this.camera.fov * RAD / 2));
    this.camera.position.set(0, -0.001, d);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.cleanup.forEach((f) => f());
    this.controls.dispose();
    dispose(this.board);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep the whole maze in view on narrow viewports
    this.camera.fov = w >= h ? 32 : Math.min(80, 2 * Math.atan(Math.tan(16 * RAD) * h / w) / RAD);
    this.camera.updateProjectionMatrix();
  }

  private build(): void {
    const m = this.maze;
    dispose(this.board);
    this.board.clear();
    this.dial.clear();
    const std = (color: number, rough = 0.7, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    const flat = (polys: readonly Poly[], z: number, mat: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shapesOf(polys), 6), mat);
      mesh.position.z = z; mesh.receiveShadow = true;
      return mesh;
    };
    const solid = (polys: readonly Poly[], h: number, mat: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shapesOf(polys), { depth: h, bevelEnabled: false, curveSegments: 6 }), mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      return mesh;
    };
    const top = std(0xe9ecf1);
    const brass = std(0xc8973b, 0.35, 0.75);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(m.rimR + 0.2, 128), std(0xd3d8e0));
    floor.receiveShadow = true;
    this.board.add(floor);
    if (m.slots.length) this.board.add(flat(m.slots, 0.02, std(0x566070)));
    // rotating floor rings of the dial (flush with the fixed floor)
    for (const f of m.dialFloor) {
      const ringMesh = new THREE.Mesh(new THREE.RingGeometry(f.r0, f.r1, 128), std(0xe2d2a4, 0.5, 0.35));
      ringMesh.position.z = 0.012; ringMesh.receiveShadow = true;
      this.dial.add(ringMesh);
    }
    // sunken areas: goal cup (green), return lane (blue-grey), pit traps (red); some ride on the dial
    const pitColor = { cup: 0x5bd39a, lane: 0xaebdd2, trap: 0xb5525c } as const;
    for (const reg of m.trench) {
      const sh = new THREE.Shape(reg.poly.map(([x, y]) => new THREE.Vector2(x, y)));
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(sh), std(pitColor[reg.kind]));
      mesh.position.z = reg.kind === 'cup' ? 0.04 : 0.03;
      (reg.frame === 'dial' ? this.dial : this.board).add(mesh);
    }
    const startRing = new THREE.Mesh(new THREE.RingGeometry(m.ballR + 0.3, m.ballR + 0.9, 32), std(0xe3a95a));
    startRing.position.set(m.start[0], m.start[1], 0.03);
    this.board.add(startRing);
    this.board.add(solid(m.walls, m.wallH, top));
    // rim
    const ring = new THREE.Shape();
    ring.absarc(0, 0, m.outerR, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, m.rimR, 0, Math.PI * 2, true);
    ring.holes.push(hole);
    const rim = new THREE.Mesh(new THREE.ExtrudeGeometry(ring, { depth: m.wallH + 2, bevelEnabled: false, curveSegments: 96 }), top);
    rim.castShadow = true; rim.receiveShadow = true;
    this.board.add(rim);
    // pointer on the rim at the start (south)
    const ptr = new THREE.Mesh(new THREE.ConeGeometry(1.6, 3.2, 3), std(0x35c9c0));
    ptr.rotation.z = Math.PI; ptr.position.set(0, -(m.outerR - 1.7), m.wallH + 2.05); ptr.scale.z = 0.05;
    this.board.add(ptr);
    // dial: shutters, fillers, and an edge ring drawn a little oversize so its start marks show from above
    this.dial.add(solid(m.shutters, m.shutterH, brass));
    if (m.fillers.length) this.dial.add(flat(m.fillers, 0.05, brass));
    const edgeR = m.outerR + 5;
    const edge = new THREE.Mesh(new THREE.CylinderGeometry(edgeR, edgeR, 5, 128), brass);
    edge.rotation.x = Math.PI / 2; edge.position.z = -6.4; edge.receiveShadow = true;
    this.dial.add(edge);
    const dark = std(0x2a1d05);
    const markAt = (deg: number, w: number, len: number) => {
      const mk = new THREE.Mesh(new THREE.BoxGeometry(len, w, 0.3), dark);
      const r = m.outerR + 2.6;
      mk.position.set(r * Math.cos(deg * RAD), r * Math.sin(deg * RAD), -3.85);
      mk.rotation.z = deg * RAD;
      this.dial.add(mk);
    };
    for (const [pos, n] of m.marks) {
      const at = 270 - pos * m.detentDeg;
      for (let i = 0; i < n; i++) markAt(at + (i - (n - 1) / 2) * 1.9, 0.9, 3.2);
    }
    markAt(270 - m.returnPos * m.detentDeg, 4.2, 3.2);
    this.board.add(this.dial);
    this.ball.scale.setScalar(m.ballR);
    this.board.add(this.ball);
    this.board.add(this.trail);
  }

  private frame(dt: number): void {
    const m = this.maze, st = this.settings;
    let status: RotaryStatus;
    let bx: number, by: number, bz: number, angle: number;
    if (this.demo) {
      this.demo.t += dt * st.speed;
      const f = this.demo.player.sample(this.demo.t);
      bx = f.x; by = f.y; angle = f.angle;
      bz = -(trenchAt(m, f.x, f.y, f.angle)?.depth ?? 0);
      status = { position: Math.round(f.angle / m.detentDeg), turning: false, clicks: f.clicks, wasted: f.wasted, elapsed: this.demo.t, phase: 'playing', traps: 0, jammed: false, demoText: f.text, wrong: f.wrong };
      (this.trail.material as THREE.LineBasicMaterial).color.set(f.wrong ? 0x5c8cff : 0xff7a7a);
      if (f.done) { this.demo = null; this.sim.reset(m.returnPos); this.cb.onDemoEnd(); }
    } else {
      const src = this.dragTilt ?? this.keyTilt;
      const max = st.maxTiltDeg * RAD;
      this.sim.tilt = { x: src.x * max, y: src.y * max };
      for (const e of this.sim.step(dt * st.speed)) this.cb.onEvent(e);
      const s = this.sim.state;
      bx = s.x; by = s.y; bz = this.sim.floorOffset(); angle = s.angle;
      status = { position: this.sim.position, turning: this.sim.turning, clicks: s.clicks, wasted: 0, elapsed: s.elapsed, phase: s.home ? 'home' : s.trapped ? 'trapped' : s.reachedGoal ? 'goal' : 'playing', traps: s.traps, jammed: s.jammed, demoText: '', wrong: false };
      (this.trail.material as THREE.LineBasicMaterial).color.set(0xff7a7a);
    }
    this.dial.rotation.z = angle * RAD;
    this.ball.position.set(bx, by, m.ballR + bz);
    const lastPt = this.trailPts[this.trailPts.length - 1];
    if (!lastPt || Math.hypot(lastPt.x - bx, lastPt.y - by) > 0.8) {
      this.trailPts.push(new THREE.Vector3(bx, by, 0.12));
      if (this.trailPts.length > 400) this.trailPts.shift();
      this.trail.geometry.dispose();
      this.trail.geometry = new THREE.BufferGeometry().setFromPoints(this.trailPts);
    }
    // show the tilt on the drawn board
    const want = this.demo || !st.showTilt ? { x: 0, y: 0 } : this.sim.tilt;
    const k = Math.min(1, dt * 10);
    this.shownTilt.x += (want.x - this.shownTilt.x) * k;
    this.shownTilt.y += (want.y - this.shownTilt.y) * k;
    this.board.rotation.set(-this.shownTilt.y * 1.5, this.shownTilt.x * 1.5, 0);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.cb.onStatus(status);
  }
}
