import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LockBox } from '@core/lockbox/model';
import { LockBoxSim } from '@core/lockbox/sim';
import type { LockBoxEvent } from '@core/lockbox/sim';
import { LockBoxAutopilot } from '@core/lockbox/autopilot';
import type { LockBoxDemoKind } from '@core/lockbox/autopilot';
import type { LockBoxCommand, LockBoxSettings, LockBoxStatus } from './state';

const RAD = Math.PI / 180;

function dispose(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
  });
}

function disc(r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  return s;
}

function circleHole(x: number, y: number, r: number): THREE.Path {
  const p = new THREE.Path();
  p.absarc(x, y, r, 0, Math.PI * 2, true);
  return p;
}

/** Annular sector from angle a0 to a1 (degrees). */
function sector(r0: number, r1: number, a0: number, a1: number): THREE.Shape {
  const s = new THREE.Shape();
  s.absarc(0, 0, r1, a0 * RAD, a1 * RAD, false);
  s.absarc(0, 0, r0, a1 * RAD, a0 * RAD, true);
  s.closePath();
  return s;
}

export interface LockBoxViewerCallbacks {
  onStatus(s: LockBoxStatus): void;
  onEvent(e: LockBoxEvent): void;
  onDemoEnd(): void;
}

/**
 * three.js view of the maze lock box with a live simulation. z is up, the maze floor is z = 0.
 * Fixed body; the lid group (lock ring + maze cap + ball) lifts; ring and cap turn separately inside it.
 */
export class LockBoxViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly root = new THREE.Group();
  private readonly lid = new THREE.Group();
  private readonly cap = new THREE.Group();
  private readonly ring = new THREE.Group();
  private readonly ball: THREE.Mesh;
  private bodyMats: THREE.MeshStandardMaterial[] = [];
  private capMats: THREE.MeshStandardMaterial[] = [];
  private box: LockBox;
  private sim: LockBoxSim;
  private pilot: LockBoxAutopilot | null = null;
  private settings: LockBoxSettings = { maxTiltDeg: 10, speed: 1, showTilt: true, seeThroughBody: true, seeThroughCap: false };
  private keyTilt = { x: 0, y: 0 };
  private dragTilt: { x: number; y: number } | null = null;
  private shownTilt = { x: 0, y: 0 };
  private turnInput = 0;
  private raf = 0;
  private last = 0;
  private readonly ro: ResizeObserver;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly host: HTMLElement, box: LockBox, private readonly cb: LockBoxViewerCallbacks) {
    this.box = box;
    this.sim = new LockBoxSim(box);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x1b2230);
    this.camera = new THREE.PerspectiveCamera(32, 1, 5, 2000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: -1 as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.enablePan = false;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-60, -80, 220);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 50; sc.far = 500;
    this.scene.add(sun);
    this.scene.add(this.root);
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), new THREE.MeshStandardMaterial({ color: 0xe23b3b, roughness: 0.25, metalness: 0.3 }));
    this.ball.castShadow = true;
    this.build();
    this.view('side');

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

  setBox(box: LockBox): void {
    if (box === this.box) return;
    this.box = box;
    this.sim = new LockBoxSim(box);
    this.pilot = null;
    this.build();
    this.view('side');
  }

  setSettings(s: LockBoxSettings): void {
    this.settings = s;
    const apply = (mats: THREE.MeshStandardMaterial[], through: boolean, opacity: number) => {
      for (const m of mats) { m.transparent = through; m.opacity = through ? opacity : 1; m.depthWrite = !through; m.needsUpdate = true; }
    };
    apply(this.bodyMats, s.seeThroughBody, 0.22);
    apply(this.capMats, s.seeThroughCap, 0.3);
  }

  setKeyTilt(x: number, y: number): void { this.keyTilt = { x, y }; }
  /** Cap turn input, -1..1 (positive = counter-clockwise from above). */
  setTurn(v: number): void { this.turnInput = v; }

  command(cmd: LockBoxCommand): void {
    if (cmd.kind === 'view') { this.view(cmd.view); return; }
    if (this.pilot) return;
    if (cmd.kind === 'resetBall') this.sim.resetBall();
    else if (cmd.kind === 'resetAll') this.sim.resetAll();
    else this.sim.lift(!(this.sim.state.lifting || this.sim.state.lidZ > 0));
  }

  /** Start a scripted demo, or go back to live play with null. */
  playDemo(kind: LockBoxDemoKind | null): void {
    if (!kind) { if (this.pilot) { this.pilot = null; this.sim.turn = 0; this.sim.tilt = { x: 0, y: 0 }; } return; }
    this.pilot = new LockBoxAutopilot(this.sim, kind, this.settings.maxTiltDeg);
  }

  view(which: 'top' | 'side'): void {
    const b = this.box;
    const d = b.outerR * 2 * 1.5 / (2 * Math.tan(this.camera.fov * RAD / 2));
    const lift = this.sim.state.lidZ;                         // keep a lifted lid in frame
    if (which === 'top') { this.camera.position.set(0, -0.001 * d, d + lift); this.controls.target.set(0, 0, lift); }
    else { const zc = (lift - b.body.H) * 0.3; this.camera.position.set(0, -d * 1.05, d * 0.95 + zc); this.controls.target.set(0, 0, zc); }
    this.controls.update();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.cleanup.forEach((f) => f());
    this.controls.dispose();
    dispose(this.root);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w >= h ? 32 : Math.min(80, 2 * Math.atan(Math.tan(16 * RAD) * h / w) / RAD);
    this.camera.updateProjectionMatrix();
  }

  private build(): void {
    const b = this.box;
    dispose(this.root);
    this.root.clear(); this.lid.clear(); this.cap.clear(); this.ring.clear();
    this.bodyMats = []; this.capMats = [];
    const std = (color: number, rough = 0.7, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    const solid = (shape: THREE.Shape, z0: number, h: number, mat: THREE.Material, segs = 48) => {
      const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: segs }), mat);
      mesh.position.z = z0; mesh.castShadow = true; mesh.receiveShadow = true;
      return mesh;
    };
    const zSeat = -b.capFloor;                               // body rim top = cap underside
    const zRingTop = zSeat - b.seamGap, zRingBot = zRingTop - b.ring.t;
    const tabH = Math.min(2.1, b.ring.t * 0.55);

    // ---- body (fixed): wall, floor, ledge, bayonet lugs and stops
    const bodyMat = std(0x56627a, 0.8); this.bodyMats.push(bodyMat);
    const wall = disc(b.outerR); wall.holes.push(circleHole(0, 0, b.body.boreR));
    this.root.add(solid(wall, zSeat - b.body.H, b.body.H, bodyMat, 96));
    const floorMat = std(0x48536a, 0.85); this.bodyMats.push(floorMat);
    this.root.add(solid(disc(b.body.boreR), zSeat - b.body.H, 2, floorMat, 96));
    const ledge = disc(b.body.boreR + 0.01); ledge.holes.push(circleHole(0, 0, b.body.boreR - b.body.ledgeIn));
    this.root.add(solid(ledge, zRingBot - 1.4, 1.4, std(0x6f7c95, 0.8), 96));
    const lugMat = std(0xe58a3c, 0.6), stopMat = std(0x9aa6bd, 0.7);
    for (let k = 0; k < 3; k++) {
      const a = 120 * k, ri = b.body.boreR - b.body.lugIn, ro = b.body.boreR + 0.01;
      this.root.add(solid(sector(ri, ro, a + b.body.lug[0], a + b.body.lug[1]), zRingBot + tabH + 0.35, zSeat - 0.3 - (zRingBot + tabH + 0.35), lugMat, 12));
      this.root.add(solid(sector(ri, ro, a + b.body.stopLock[0], a + b.body.stopLock[1]), zRingBot, zSeat - 0.5 - zRingBot, stopMat, 4));
      this.root.add(solid(sector(ri, ro, a + b.body.stopOpen[0], a + b.body.stopOpen[1]), zRingBot, zSeat - 0.5 - zRingBot, stopMat, 4));
    }

    // ---- lock ring: disc with pockets, three bayonet tabs
    const brass = std(0xc8973b, 0.4, 0.7);
    const ringShape = disc(b.ring.r); ringShape.holes.push(circleHole(0, 0, b.ring.holeR));
    const gr = Math.hypot(b.goal[0], b.goal[1]);
    const pocketFloor = std(0x35c9c0, 0.5);
    for (let k = 0; k < b.pockets; k++) {
      const a = (b.pocketA0 + (k * 360) / b.pockets) * RAD;
      ringShape.holes.push(circleHole(gr * Math.cos(a), gr * Math.sin(a), b.holeR));
      const f = new THREE.Mesh(new THREE.CircleGeometry(b.holeR, 24), pocketFloor);
      f.position.set(gr * Math.cos(a), gr * Math.sin(a), zRingTop - b.pocketD);
      this.ring.add(f);
    }
    this.ring.add(solid(ringShape, zRingTop - b.pocketD, b.pocketD, brass, 96));
    const ringLow = disc(b.ring.r); ringLow.holes.push(circleHole(0, 0, b.ring.holeR));
    this.ring.add(solid(ringLow, zRingBot, b.ring.t - b.pocketD, brass, 96));
    const tabMat = std(0xf2c14e, 0.4, 0.6);
    for (let k = 0; k < 3; k++) this.ring.add(solid(sector(b.ring.r - 0.2, b.ring.tabR, 120 * k + b.ring.tab[0], 120 * k + b.ring.tab[1]), zRingBot, tabH, tabMat, 12));
    // a line on the ring so its rotation reads from above through the goal hole and from the side
    const mark = new THREE.Mesh(new THREE.BoxGeometry(b.ring.r - b.ring.holeR - 1, 0.5, 0.06), std(0x2a1d05));
    mark.position.set((b.ring.r + b.ring.holeR) / 2, 0, zRingTop + 0.03);
    this.ring.add(mark);

    // ---- maze cap: floor with the goal hole, walls (everything that is not lane), rim, markers
    const capMat = std(0xe9ecf1), floorCapMat = std(0xd3d8e0);
    this.capMats.push(capMat, floorCapMat);
    const capFloor = disc(b.outerR); capFloor.holes.push(circleHole(b.goal[0], b.goal[1], b.holeR));
    this.cap.add(solid(capFloor, zSeat, b.capFloor, floorCapMat, 96));
    const walls = disc(b.fieldR + 0.01);
    walls.holes.push(new THREE.Path(b.lanes.map(([x, y]) => new THREE.Vector2(x, y))));
    this.cap.add(solid(walls, 0, b.wallH, capMat, 96));
    const rim = disc(b.outerR); rim.holes.push(circleHole(0, 0, b.fieldR));
    this.cap.add(solid(rim, 0, b.wallH + b.coverD, capMat, 96));
    const startRing = new THREE.Mesh(new THREE.RingGeometry(b.ballR * 0.55, b.ballR * 0.95, 32), std(0xe3a95a));
    startRing.position.set(b.start[0], b.start[1], 0.03);
    this.cap.add(startRing);
    const goalRing = new THREE.Mesh(new THREE.RingGeometry(b.holeR, b.holeR + 0.55, 32), std(0x35c9c0));
    goalRing.position.set(b.goal[0], b.goal[1], b.wallH + 0.04);
    this.cap.add(goalRing);
    // pointer on the rim at the start side: shows how far the cap has been turned
    const sa = Math.atan2(b.start[1], b.start[0]);
    const ptr = new THREE.Mesh(new THREE.ConeGeometry(1.3, 2.6, 3), std(0x35c9c0));
    const pr = (b.outerR + b.fieldR) / 2;
    ptr.rotation.z = sa + Math.PI / 2; ptr.scale.z = 0.05;
    ptr.position.set(pr * Math.cos(sa), pr * Math.sin(sa), b.wallH + b.coverD + 0.05);
    this.cap.add(ptr);
    // retainer bushing under the ring (screwed to the cap, so it turns with it)
    const ret = new THREE.Mesh(new THREE.CylinderGeometry(b.ring.holeR + 1.75, b.ring.holeR + 1.75, 2.5, 32), std(0x8f99ad));
    ret.rotation.x = Math.PI / 2; ret.position.z = zRingBot - 0.3 - 1.25;
    this.cap.add(ret);
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(b.ring.holeR - 0.25, b.ring.holeR - 0.25, b.ring.t + 0.5, 24), std(0x8f99ad));
    sleeve.rotation.x = Math.PI / 2; sleeve.position.z = (zSeat + zRingBot - 0.3) / 2;
    this.cap.add(sleeve);
    this.ball.scale.setScalar(b.ballR);
    this.cap.add(this.ball);

    this.lid.add(this.ring, this.cap);
    this.root.add(this.lid);
    this.setSettings(this.settings);
  }

  private frame(dt: number): void {
    const st = this.settings, sim = this.sim, s = sim.state, b = this.box;
    const sdt = dt * st.speed;
    if (this.pilot) {
      // the autopilot is tuned for 120 Hz updates
      const n = Math.max(1, Math.round(sdt * 120));
      for (let i = 0; i < n; i++) { this.pilot.update(sdt / n); for (const e of sim.step(sdt / n)) this.cb.onEvent(e); }
      if (this.pilot.done) { this.pilot = null; sim.turn = 0; sim.tilt = { x: 0, y: 0 }; this.cb.onDemoEnd(); }
    } else {
      // tilt relative to the screen: "right" on screen rolls the ball to the right whatever the camera angle
      const src = this.dragTilt ?? this.keyTilt;
      const max = st.maxTiltDeg * RAD;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const rl = Math.hypot(right.x, right.y) || 1, ul = Math.hypot(up.x, up.y) || 1;
      sim.tilt = {
        x: (src.x * right.x / rl + src.y * up.x / ul) * max,
        y: (src.x * right.y / rl + src.y * up.y / ul) * max,
      };
      sim.turn = this.turnInput;
      for (const e of sim.step(sdt)) this.cb.onEvent(e);
    }
    this.lid.position.z = s.lidZ;
    this.cap.rotation.z = s.capA * RAD;
    this.ring.rotation.z = s.ringA * RAD;
    this.ball.position.set(s.x, s.y, b.ballR + sim.ballZ());
    const want = !st.showTilt ? { x: 0, y: 0 } : sim.tilt;
    const k = Math.min(1, dt * 10);
    this.shownTilt.x += (want.x - this.shownTilt.x) * k;
    this.shownTilt.y += (want.y - this.shownTilt.y) * k;
    this.root.rotation.set(-this.shownTilt.y * 1.5, this.shownTilt.x * 1.5, 0);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.cb.onStatus({
      phase: s.phase, capA: s.capA, ringA: s.ringA, locked: sim.locked, lidZ: s.lidZ, open: s.open, atStop: s.atStop,
      refused: s.sinceLocked >= 0 && s.sinceLocked < 1.6, elapsed: s.elapsed, demoText: this.pilot?.text ?? '',
    });
  }
}
