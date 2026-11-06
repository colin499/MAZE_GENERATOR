import type { TopologySpec } from '../model/topology';
import { createTopology } from '../topology/registry';
/** Physical dimensions in millimetres. These become Fusion user parameters. */
export interface PhysicalParams {
  readonly ballDia: number;
  /** Channel width between wall faces. */
  readonly chanW: number;
  readonly wallT: number;
  readonly floorT: number;
  /** Wall height above the floor top. */
  readonly wallH: number;
  /** Diameter of dropout / trap / goal holes. */
  readonly holeDia: number;
  /** Gap under a bridge wall (hidden passage). */
  readonly bridgeLift: number;
  /** Inner diameter of a cylinder maze tube (the ball rolls on the inside). */
  readonly tubeDia: number;
  /** Inner side length of a cube maze shell. */
  readonly cubeSide: number;
  /** Inner diameter of a sphere maze shell. */
  readonly sphereDia: number;
  /** Shell shapes: maze on the outer surface (ball held on by a clear sleeve) or on the inside. */
  readonly shellSide: 'outside' | 'inside';
}

export const DEFAULT_PHYSICAL: PhysicalParams = {
  ballDia: 6,
  chanW: 8,
  wallT: 1.6,
  floorT: 2,
  wallH: 9,
  holeDia: 7,
  bridgeLift: 7,
  tubeDia: 30.1,
  cubeSide: 60,
  sphereDia: 60,
  shellSide: 'outside',
};

/** Grid pitch: wall centre-line to wall centre-line. */
export const pitchOf = (p: PhysicalParams): number => p.chanW + p.wallT;
/** Layer-to-layer height. */
export const layerHOf = (p: PhysicalParams): number => p.floorT + p.wallH;

export interface PhysicalIssue {
  readonly level: 'error' | 'warning';
  readonly message: string;
}

export function validatePhysical(p: PhysicalParams, spec?: TopologySpec): PhysicalIssue[] {
  const out: PhysicalIssue[] = [];
  const pos = (k: keyof PhysicalParams) => { const v = p[k]; if (typeof v === 'number' && (!(v > 0) || !Number.isFinite(v))) out.push({ level: 'error', message: `${k} must be a positive number` }); };
  (Object.keys(p) as (keyof PhysicalParams)[]).forEach(pos);
  if (out.length) return out;
  if (spec) {
    const ch = shellChannel(p, spec);
    if (ch) {
      if (ch.min <= p.ballDia) out.push({ level: 'error', message: `${ch.what} leaves only ${ch.min.toFixed(1)} mm between walls at the ball; the ball (${p.ballDia} mm) cannot pass — use fewer cells or a bigger shell` });
      else if (ch.min < p.ballDia + 1) out.push({ level: 'warning', message: `${ch.what} leaves ${ch.min.toFixed(1)} mm between walls at the ball (tight)` });
      if (ch.wallLimit !== null && p.wallH >= ch.wallLimit) out.push({ level: 'error', message: `wallH must stay below ${ch.wallLimit.toFixed(1)} mm or the walls meet in the middle of the shell` });
    }
  }
  if (p.chanW <= p.ballDia) out.push({ level: 'error', message: 'chanW must exceed ballDia or the ball cannot roll' });
  else if (p.chanW < p.ballDia + 1) out.push({ level: 'warning', message: 'chanW gives less than 0.5 mm clearance per side' });
  if (p.holeDia <= p.ballDia) out.push({ level: 'error', message: 'holeDia must exceed ballDia or the ball never falls' });
  if (p.holeDia > p.chanW) out.push({ level: 'error', message: 'holeDia cannot exceed chanW (hole would cut the walls)' });
  if (p.wallH < p.ballDia + 1) out.push({ level: 'error', message: 'wallH must be at least ballDia + 1 mm so the ball fits under the next layer' });
  if (p.bridgeLift <= p.ballDia) out.push({ level: 'error', message: 'bridgeLift must exceed ballDia or the ball cannot pass under a bridge wall' });
  if (p.bridgeLift >= p.wallH) out.push({ level: 'error', message: 'bridgeLift must be smaller than wallH or the bridge wall vanishes' });
  if (p.wallT < 1.2) out.push({ level: 'warning', message: 'wallT below 1.2 mm is fragile for FDM printing' });
  if (p.floorT < 1.2) out.push({ level: 'warning', message: 'floorT below 1.2 mm is fragile for FDM printing' });
  return out;
}

/** Narrowest channel at the ball's height on a shell topology (walls are radial, so channels narrow inward). */
export function shellChannel(p: PhysicalParams, spec: TopologySpec): { min: number; max: number; what: string; wallLimit: number | null } | null {
  const r = p.ballDia / 2;
  const inside = p.shellSide === 'inside';
  const sgn = inside ? -1 : 1;
  switch (spec.kind) {
    case 'cylinder': {
      const R = p.tubeDia / 2;
      const arc = (2 * Math.PI * (R + sgn * r)) / spec.around - p.wallT; // around; along is chanW
      return { min: Math.min(arc, p.chanW), max: Math.max(arc, p.chanW), what: `${spec.around} cells around a ${p.tubeDia} mm tube (${p.shellSide})`, wallLimit: inside ? R - r : null };
    }
    case 'cube': {
      const cell = p.cubeSide / spec.n;
      return { min: cell - p.wallT, max: cell - p.wallT, what: `${spec.n} cells per ${p.cubeSide} mm face (${p.shellSide})`, wallLimit: inside ? p.cubeSide / 2 - r : null };
    }
    case 'sphere': {
      // equiangular cubed sphere: sample the metric at the ball's height; the channel across a wall is the
      // cell pitch times the sine of the angle between the grid directions (cells are rhombi near corners)
      const surf = createTopology(spec).surface(p);
      let min = Infinity, max = 0;
      const n = spec.n;
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
        const u = 0.5 + ((n - 1) * i) / 4, v = 0.5 + ((n - 1) * j) / 4;
        const [pu, pv] = surf.metric(0, u, v, r);
        const f = surf.frame(0, u, v);
        const cosA = f.tu[0] * f.tv[0] + f.tu[1] * f.tv[1] + f.tu[2] * f.tv[2];
        const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
        for (const w of [pu * sinA - p.wallT, pv * sinA - p.wallT]) { min = Math.min(min, w); max = Math.max(max, w); }
      }
      return { min, max, what: `${n} cells per face of a ${p.sphereDia} mm sphere (${p.shellSide})`, wallLimit: inside ? p.sphereDia / 2 - r : null };
    }
    default: return null;
  }
}

/** Fusion user-parameter definitions in dependency order. */
export interface ParamDef {
  readonly name: string;
  readonly expr: string;
  readonly mm: number;
  readonly comment: string;
}

export function paramDefs(p: PhysicalParams): ParamDef[] {
  const mm = (v: number) => `${round(v)} mm`;
  return [
    { name: 'ballDia', expr: mm(p.ballDia), mm: p.ballDia, comment: 'ball diameter (layout is baked for this value)' },
    { name: 'chanW', expr: mm(p.chanW), mm: p.chanW, comment: 'channel width between walls (baked into layout)' },
    { name: 'wallT', expr: mm(p.wallT), mm: p.wallT, comment: 'wall thickness (live)' },
    { name: 'floorT', expr: mm(p.floorT), mm: p.floorT, comment: 'floor thickness (live)' },
    { name: 'wallH', expr: mm(p.wallH), mm: p.wallH, comment: 'wall height above floor (live)' },
    { name: 'layerH', expr: 'floorT + wallH', mm: layerHOf(p), comment: 'layer stack-up (live)' },
    { name: 'holeDia', expr: mm(p.holeDia), mm: p.holeDia, comment: 'dropout / trap / goal hole diameter (live)' },
    { name: 'bridgeLift', expr: mm(p.bridgeLift), mm: p.bridgeLift, comment: 'gap under bridge walls (live)' },
    { name: 'tubeDia', expr: mm(p.tubeDia), mm: p.tubeDia, comment: 'cylinder maze: inner tube diameter (baked into layout)' },
    { name: 'cubeSide', expr: mm(p.cubeSide), mm: p.cubeSide, comment: 'cube maze: inner side (baked into layout)' },
    { name: 'sphereDia', expr: mm(p.sphereDia), mm: p.sphereDia, comment: 'sphere maze: inner diameter (baked into layout)' },
  ];
}

export const round = (v: number, d = 4): number => Math.round(v * 10 ** d) / 10 ** d;
