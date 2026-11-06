import type { CellId } from '../model/ids';
import type { Frame } from '../math/vec';
import { SIDE_DELTA, surfaceFromPoint } from '../model/topology';
import type { CellInfo, PanelCrossing, PanelInfo, Side, Surface, SurfaceParams, Topology, TopologySpec } from '../model/topology';

type CylSpec = Extract<TopologySpec, { kind: 'cylinder' }>;

/**
 * Maze on the inside of a tube. One panel `around × along`; u runs around the circumference and
 * wraps, v runs along the axis (z). The ball enters at the v = 0 end and must reach the far end.
 * Cell id = v * around + u.
 */
export class CylinderTopology implements Topology {
  readonly around: number;
  readonly along: number;
  readonly layerCount = 1;
  readonly cellCount: number;
  readonly supportsGravity = false;

  constructor(readonly spec: CylSpec) {
    if (!Number.isInteger(spec.around) || !Number.isInteger(spec.along) || spec.around < 3 || spec.along < 2) {
      throw new RangeError(`cylinder needs integer around >= 3 and along >= 2, got ${spec.around}x${spec.along}`);
    }
    this.around = spec.around;
    this.along = spec.along;
    this.cellCount = spec.around * spec.along;
  }

  cell(id: CellId): CellInfo {
    const v = Math.floor(id / this.around);
    return { panel: 0, u: id - v * this.around, v, layer: 0 };
  }

  cellAt(panel: number, u: number, v: number): CellId | null {
    if (panel !== 0 || v < 0 || v >= this.along) return null;
    const uu = ((u % this.around) + this.around) % this.around;
    return (v * this.around + uu) as CellId;
  }

  side(id: CellId, s: Side): CellId | null {
    const c = this.cell(id);
    const d = SIDE_DELTA[s]!;
    return this.cellAt(0, c.u + d[0], c.v + d[1]);
  }

  below(): CellId | null { return null; }
  above(): CellId | null { return null; }

  panels(): readonly PanelInfo[] {
    return [{ id: 0, w: this.around, h: this.along, layer: 0, wrapU: true }];
  }

  panelFrame(): Frame {
    return { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] };
  }

  /** Pitch along the axis (mm per cell); around, the pitch is 2πR / around. */
  static pitchV(p: SurfaceParams): number { return p.chanW + p.wallT; }

  private surfaces = new WeakMap<SurfaceParams, Surface>();
  private nets = new WeakMap<SurfaceParams, Surface>();
  surface(p: SurfaceParams, unfolded = false): Surface {
    const cache = unfolded ? this.nets : this.surfaces;
    const hit = cache.get(p);
    if (hit) return hit;
    const R = p.tubeDia / 2;
    const pv = CylinderTopology.pitchV(p);
    const L = this.along * pv;
    const half = p.wallT / 2;
    let s: Surface;
    if (unfolded) {
      const pu = (2 * Math.PI * R) / this.around;
      s = surfaceFromPoint((_panel, u, v, h) => [u * pu, v * pv, p.floorT + h], {
        closed: false, curved: false, edgeInset: 0,
        bbox: { min: [0, -half, 0], max: [this.around * pu, L + half, p.floorT + p.wallH] },
      });
    } else {
      s = surfaceFromPoint((_panel, u, v, h) => {
        const a = (2 * Math.PI * u) / this.around;
        const r = R - h;
        return [r * Math.cos(a), r * Math.sin(a), v * pv];
      }, {
        closed: true, curved: true, edgeInset: 0,
        bbox: { min: [-R - p.floorT, -R - p.floorT, -p.floorT], max: [R + p.floorT, R + p.floorT, L + p.floorT] },
      });
    }
    cache.set(p, s);
    return s;
  }

  crossPanel(panel: number, u: number, v: number): PanelCrossing | null {
    if (panel !== 0 || v < 0 || v > this.along) return null;
    if (u >= 0 && u <= this.around) return null;
    return { panel: 0, u: ((u % this.around) + this.around) % this.around, v, m: [1, 0, 0, 1] };
  }

  allowedStart(id: CellId): boolean { return this.cell(id).v === 0; }
  allowedGoal(id: CellId): boolean { return this.cell(id).v === this.along - 1; }
}
