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
}

export const DEFAULT_PHYSICAL: PhysicalParams = {
  ballDia: 6,
  chanW: 8,
  wallT: 1.6,
  floorT: 2,
  wallH: 9,
  holeDia: 7,
  bridgeLift: 7,
};

/** Grid pitch: wall centre-line to wall centre-line. */
export const pitchOf = (p: PhysicalParams): number => p.chanW + p.wallT;
/** Layer-to-layer height. */
export const layerHOf = (p: PhysicalParams): number => p.floorT + p.wallH;

export interface PhysicalIssue {
  readonly level: 'error' | 'warning';
  readonly message: string;
}

export function validatePhysical(p: PhysicalParams): PhysicalIssue[] {
  const out: PhysicalIssue[] = [];
  const pos = (k: keyof PhysicalParams) => { if (!(p[k] > 0) || !Number.isFinite(p[k])) out.push({ level: 'error', message: `${k} must be a positive number` }); };
  (Object.keys(p) as (keyof PhysicalParams)[]).forEach(pos);
  if (out.length) return out;
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
  ];
}

export const round = (v: number, d = 4): number => Math.round(v * 10 ** d) / 10 ** d;
