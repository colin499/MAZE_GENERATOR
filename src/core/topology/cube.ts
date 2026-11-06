import type { CellId } from '../model/ids';
import type { Frame, Vec3 } from '../math/vec';
import { SIDE_DELTA, surfaceFromPoint } from '../model/topology';
import type { CellInfo, PanelCrossing, PanelInfo, Side, Surface, SurfaceParams, Topology, TopologySpec } from '../model/topology';

type ShellSpec = Extract<TopologySpec, { kind: 'cube' | 'sphere' }>;

interface Face {
  readonly n: Vec3;   // outward normal
  readonly tu: Vec3;  // tu × tv = n
  readonly tv: Vec3;
}

/** Six faces of the unit cube (half-side 1), frames chosen so tu × tv is the outward normal. */
export const FACES: readonly Face[] = [
  { n: [0, 0, 1], tu: [1, 0, 0], tv: [0, 1, 0] },    // 0 +Z
  { n: [0, 0, -1], tu: [1, 0, 0], tv: [0, -1, 0] },  // 1 −Z
  { n: [1, 0, 0], tu: [0, 1, 0], tv: [0, 0, 1] },    // 2 +X
  { n: [-1, 0, 0], tu: [0, -1, 0], tv: [0, 0, 1] },  // 3 −X
  { n: [0, 1, 0], tu: [0, 0, 1], tv: [1, 0, 0] },    // 4 +Y
  { n: [0, -1, 0], tu: [0, 0, -1], tv: [1, 0, 0] },  // 5 −Y
];

/** Net (unfolded cross) placement of each face in units of face width: origin plus 2D directions of tu and tv. */
const NET: readonly { o: readonly [number, number]; tu: readonly [number, number]; tv: readonly [number, number] }[] = [
  { o: [0, 0], tu: [1, 0], tv: [0, 1] },      // +Z centre
  { o: [3, 1], tu: [-1, 0], tv: [0, -1] },    // −Z right of +X (u = n edge touches +X's v = 0 edge)
  { o: [2, 0], tu: [0, 1], tv: [-1, 0] },     // +X right
  { o: [-1, 1], tu: [0, -1], tv: [1, 0] },    // −X left
  { o: [0, 2], tu: [0, -1], tv: [1, 0] },     // +Y above
  { o: [0, 0], tu: [0, -1], tv: [1, 0] },     // −Y below
];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const axpy = (p: Vec3, s: number, d: Vec3): Vec3 => [p[0] + s * d[0], p[1] + s * d[1], p[2] + s * d[2]];

/**
 * Maze on the inside of a hollow cube (6 faces of n×n cells) or of a sphere (the same six faces
 * projected radially: an equiangular cubed sphere, whose grid lines are great circles).
 * Cell id = face * n² + v * n + u. Adjacency across face edges is derived geometrically.
 */
export class CubeTopology implements Topology {
  readonly n: number;
  readonly layerCount = 1;
  readonly cellCount: number;
  readonly supportsGravity = false;
  private readonly adj: Int32Array;

  constructor(readonly spec: ShellSpec) {
    if (!Number.isInteger(spec.n) || spec.n < 2) throw new RangeError(`cube/sphere needs integer n >= 2, got ${spec.n}`);
    this.n = spec.n;
    this.cellCount = 6 * spec.n * spec.n;
    this.adj = new Int32Array(this.cellCount * 4);
    for (let c = 0; c < this.cellCount; c++) {
      const info = this.cell(c as CellId);
      for (let s = 0; s < 4; s++) {
        const d = SIDE_DELTA[s]!;
        const u = info.u + d[0], v = info.v + d[1];
        let id = this.cellAt(info.panel, u, v);
        if (id === null) {
          const x = this.crossPanel(info.panel, u + 0.5, v + 0.5)!;
          id = this.cellAt(x.panel, Math.floor(x.u), Math.floor(x.v));
        }
        this.adj[c * 4 + s] = id ?? -1;
      }
    }
  }

  cell(id: CellId): CellInfo {
    const per = this.n * this.n;
    const panel = Math.floor(id / per);
    const r = id - panel * per;
    const v = Math.floor(r / this.n);
    return { panel, u: r - v * this.n, v, layer: 0 };
  }

  cellAt(panel: number, u: number, v: number): CellId | null {
    if (panel < 0 || panel > 5 || u < 0 || u >= this.n || v < 0 || v >= this.n) return null;
    return (panel * this.n * this.n + v * this.n + u) as CellId;
  }

  side(id: CellId, s: Side): CellId | null {
    const r = this.adj[id * 4 + s]!;
    return r < 0 ? null : (r as CellId);
  }

  below(): CellId | null { return null; }
  above(): CellId | null { return null; }

  panels(): readonly PanelInfo[] {
    return FACES.map((_, i) => ({ id: i, w: this.n, h: this.n, layer: 0 }));
  }

  panelFrame(): Frame {
    return { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] };
  }

  /** Point on the unit cube's face for grid coordinates (may lie outside the face when u, v are out of range). */
  private cubePoint(panel: number, u: number, v: number): Vec3 {
    const f = FACES[panel]!;
    const x = (2 * u) / this.n - 1, y = (2 * v) / this.n - 1;
    return axpy(axpy(f.n, x, f.tu), y, f.tv);
  }

  /** Inverse of cubePoint for a point on face `panel`. */
  private faceCoords(panel: number, p: Vec3): readonly [number, number] {
    const f = FACES[panel]!;
    return [((dot(p, f.tu) + 1) * this.n) / 2, ((dot(p, f.tv) + 1) * this.n) / 2];
  }

  crossPanel(panel: number, u: number, v: number): PanelCrossing | null {
    const f = FACES[panel]!;
    const n = this.n;
    const inU = u >= 0 && u <= n, inV = v >= 0 && v <= n;
    if (inU && inV) return null;
    // leave across one edge (corners: resolve u first)
    let dir: Vec3, over: number;
    if (!inU) { over = u < 0 ? -u : u - n; dir = u < 0 ? [-f.tu[0], -f.tu[1], -f.tu[2]] : f.tu; }
    else { over = v < 0 ? -v : v - n; dir = v < 0 ? [-f.tv[0], -f.tv[1], -f.tv[2]] : f.tv; }
    const target = FACES.findIndex((g) => dot(g.n, dir) > 0.5);
    // fold the overshoot onto the neighbouring face: it continues inward along −n of the face we left
    const edge = this.cubePoint(panel, Math.min(n, Math.max(0, u)), Math.min(n, Math.max(0, v)));
    const inward: Vec3 = [-f.n[0], -f.n[1], -f.n[2]];
    const p = axpy(edge, (2 * over) / n, inward);
    const [nu, nv] = this.faceCoords(target, p);
    // direction map: on the new face the travel direction becomes `inward`, the along-edge direction is unchanged
    const g = FACES[target]!;
    const mapDir = (d: Vec3): Vec3 => {
      const along = dot(d, dir); // component that was heading across the edge
      const rest = axpy(d, -along, dir);
      return axpy(rest, along, inward);
    };
    const mu = mapDir(f.tu), mv = mapDir(f.tv);
    return { panel: target, u: nu, v: nv, m: [Math.round(dot(mu, g.tu)) + 0, Math.round(dot(mv, g.tu)) + 0, Math.round(dot(mu, g.tv)) + 0, Math.round(dot(mv, g.tv)) + 0] };
  }

  private surfaces = new WeakMap<SurfaceParams, Surface>();
  private nets = new WeakMap<SurfaceParams, Surface>();
  surface(p: SurfaceParams, unfolded = false): Surface {
    const cache = unfolded ? this.nets : this.surfaces;
    const hit = cache.get(p);
    if (hit) return hit;
    const n = this.n;
    let s: Surface;
    if (unfolded) {
      const pitch = this.spec.kind === 'cube' ? p.cubeSide / n : ((p.sphereDia / 2) * (Math.PI / 2)) / n;
      const W = n * pitch;
      s = surfaceFromPoint((panel, u, v, h) => {
        const f = NET[panel]!;
        return [f.o[0] * W + (f.tu[0] * u + f.tv[0] * v) * pitch, f.o[1] * W + (f.tu[1] * u + f.tv[1] * v) * pitch, p.floorT + h];
      }, { closed: false, curved: false, edgeInset: 0, bbox: { min: [-W, -W, 0], max: [4 * W, 3 * W, p.floorT + p.wallH] } });
    } else if (this.spec.kind === 'cube') {
      const S = p.cubeSide / 2;
      s = surfaceFromPoint((panel, u, v, h) => {
        const q = this.cubePoint(panel, u, v);
        const f = FACES[panel]!;
        return axpy([q[0] * S, q[1] * S, q[2] * S], -h, f.n);
      }, { closed: true, curved: false, edgeInset: p.ballDia / 2, bbox: { min: [-S - p.floorT, -S - p.floorT, -S - p.floorT], max: [S + p.floorT, S + p.floorT, S + p.floorT] } });
    } else {
      const R = p.sphereDia / 2;
      s = surfaceFromPoint((panel, u, v, h) => {
        // equiangular: equal angle steps across the face give near-uniform cells
        const f = FACES[panel]!;
        const x = Math.tan(((u / n) - 0.5) * (Math.PI / 2)), y = Math.tan(((v / n) - 0.5) * (Math.PI / 2));
        const q = axpy(axpy(f.n, x, f.tu), y, f.tv);
        const l = Math.hypot(q[0], q[1], q[2]);
        const r = (R - h) / l;
        return [q[0] * r, q[1] * r, q[2] * r];
      }, { closed: true, curved: true, edgeInset: 0, bbox: { min: [-R - p.floorT, -R - p.floorT, -R - p.floorT], max: [R + p.floorT, R + p.floorT, R + p.floorT] } });
    }
    cache.set(p, s);
    return s;
  }

  allowedStart(): boolean { return true; }
  allowedGoal(): boolean { return true; }
}
