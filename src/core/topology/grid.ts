import type { CellId } from '../model/ids';
import type { Frame } from '../math/vec';
import { SIDE_DELTA, isBoundary, surfaceFromPoint } from '../model/topology';
import type { CellInfo, PanelCrossing, PanelInfo, PanelMetrics, Side, Surface, SurfaceParams, Topology, TopologySpec } from '../model/topology';

type GridSpec = Extract<TopologySpec, { kind: 'flat' | 'stacked' }>;

/** Flat (1 layer) and stacked (N layers) rectangular grids. Cell id = layer*w*h + v*w + u. */
export class GridTopology implements Topology {
  readonly w: number;
  readonly h: number;
  readonly layerCount: number;
  readonly cellCount: number;
  readonly supportsGravity = true;
  private readonly perLayer: number;

  constructor(readonly spec: GridSpec) {
    if (!Number.isInteger(spec.w) || !Number.isInteger(spec.h) || spec.w < 2 || spec.h < 2) {
      throw new RangeError(`grid size must be integers >= 2, got ${spec.w}x${spec.h}`);
    }
    this.w = spec.w;
    this.h = spec.h;
    this.layerCount = spec.kind === 'stacked' ? spec.layers : 1;
    if (!Number.isInteger(this.layerCount) || this.layerCount < 1) {
      throw new RangeError(`layers must be an integer >= 1`);
    }
    this.perLayer = this.w * this.h;
    this.cellCount = this.perLayer * this.layerCount;
  }

  cell(id: CellId): CellInfo {
    const layer = Math.floor(id / this.perLayer);
    const r = id - layer * this.perLayer;
    const v = Math.floor(r / this.w);
    const u = r - v * this.w;
    return { panel: layer, u, v, layer };
  }

  cellAt(panel: number, u: number, v: number): CellId | null {
    if (panel < 0 || panel >= this.layerCount || u < 0 || u >= this.w || v < 0 || v >= this.h) return null;
    return (panel * this.perLayer + v * this.w + u) as CellId;
  }

  side(id: CellId, s: Side): CellId | null {
    const c = this.cell(id);
    const d = SIDE_DELTA[s]!;
    return this.cellAt(c.panel, c.u + d[0], c.v + d[1]);
  }

  below(id: CellId): CellId | null {
    return id >= this.perLayer ? ((id - this.perLayer) as CellId) : null;
  }

  above(id: CellId): CellId | null {
    return id + this.perLayer < this.cellCount ? ((id + this.perLayer) as CellId) : null;
  }

  panels(): readonly PanelInfo[] {
    return Array.from({ length: this.layerCount }, (_, k) => ({ id: k, w: this.w, h: this.h, layer: k }));
  }

  panelFrame(panel: number, m: PanelMetrics): Frame {
    return { origin: [0, 0, panel * m.layerH], x: [1, 0, 0], y: [0, 1, 0] };
  }

  private surfaces = new WeakMap<SurfaceParams, Surface>();
  surface(p: SurfaceParams): Surface {
    const hit = this.surfaces.get(p);
    if (hit) return hit;
    const pitch = p.chanW + p.wallT, layerH = p.floorT + p.wallH, half = p.wallT / 2;
    const s = surfaceFromPoint((panel, u, v, h) => [u * pitch, v * pitch, panel * layerH + p.floorT + h], {
      closed: false, curved: false, edgeInset: 0,
      bbox: { min: [-half, -half, 0], max: [this.w * pitch + half, this.h * pitch + half, (this.layerCount - 1) * layerH + p.floorT + p.wallH] },
    });
    this.surfaces.set(p, s);
    return s;
  }

  crossPanel(): PanelCrossing | null {
    return null; // layers are bounded by outer walls; nothing to cross into
  }

  allowedStart(id: CellId): boolean {
    if (this.layerCount === 1) return isBoundary(this, id);
    return this.cell(id).layer === this.layerCount - 1;
  }

  allowedGoal(id: CellId): boolean {
    if (this.layerCount === 1) return isBoundary(this, id);
    return this.cell(id).layer === 0;
  }
}
