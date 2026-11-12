/**
 * Maze lock box: a cylindrical box whose lid is a ball maze. The maze cap spins freely on a hidden lock ring that
 * holds the lid on with a bayonet. At the goal the ball drops through the cap floor into a pocket in the ring and
 * keys the two together, so turning the cap then turns the ring and frees the lid.
 * Geometry in mm, +y = north, angles in degrees CCW seen from above. The maze floor is z = 0.
 * Files are written by `lockbox_cells.py --app` in the MAZE_LOCK_BOX project (format "lock-box/1").
 */
export type Pt = readonly [number, number];

export interface LockBox {
  readonly format: 'lock-box/1';
  readonly name: string;
  readonly ballR: number;
  readonly outerR: number;
  /** Inner radius of the rim above the walls (the cover pocket). */
  readonly fieldR: number;
  readonly wallH: number;
  readonly coverD: number;
  /** Outline of all the lanes (one simple polygon, cap frame). Everything else inside fieldR is wall. */
  readonly lanes: readonly Pt[];
  readonly start: Pt;
  readonly goal: Pt;
  /** Radius of the goal hole and of the ring pockets. */
  readonly holeR: number;
  readonly capFloor: number;
  /** Gap between the cap underside and the ring top. */
  readonly seamGap: number;
  readonly pocketD: number;
  readonly pockets: number;
  /** Angle of the first pocket in the ring frame. */
  readonly pocketA0: number;
  readonly ring: { readonly r: number; readonly tabR: number; readonly t: number; readonly holeR: number; readonly tab: readonly [number, number] };
  readonly body: {
    readonly H: number; readonly boreR: number; readonly lugIn: number; readonly ledgeIn: number;
    readonly lug: readonly [number, number]; readonly stopLock: readonly [number, number]; readonly stopOpen: readonly [number, number];
  };
  /** Ring angle at the open stop (0 = locked stop). */
  readonly openTurn: number;
  /** Ring angle from which the tabs are clear of the lugs and the lid lifts. */
  readonly clearAt: number;
  /** How far a locked lid can be pulled up before the tabs hit the lugs. */
  readonly liftPlay: number;
  /** Solution as lane-centre points from start to goal (cap frame). */
  readonly path: readonly Pt[];
}

export function parseLockBox(text: string): LockBox {
  const raw = JSON.parse(text) as Partial<LockBox>;
  if (raw.format !== 'lock-box/1') throw new Error('Not a lock box file (expected format "lock-box/1")');
  for (const key of ['ballR', 'outerR', 'fieldR', 'wallH', 'holeR', 'capFloor', 'seamGap', 'pocketD', 'pockets', 'pocketA0', 'openTurn', 'clearAt'] as const) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw new Error(`Lock box: "${key}" missing`);
  }
  if (!Array.isArray(raw.lanes) || raw.lanes.length < 4 || !raw.start || !raw.goal || !raw.ring || !raw.body) throw new Error('Lock box: geometry missing');
  return { name: 'Lock box', coverD: 2, liftPlay: 0.7, path: [], ...raw } as LockBox;
}

/** Radius and angle (degrees) of the goal hole in the cap frame. */
export function goalPolar(b: LockBox): { readonly r: number; readonly a: number } {
  return { r: Math.hypot(b.goal[0], b.goal[1]), a: Math.atan2(b.goal[1], b.goal[0]) * 180 / Math.PI };
}

/** Half the angular play (degrees) of the cap against the ring when the ball keys them: it has slack in both holes. */
export function clutchBacklash(b: LockBox): number {
  return (2 * (b.holeR - b.ballR) / goalPolar(b).r) * 180 / Math.PI;
}

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDeg(d: number): number {
  const w = ((d + 180) % 360 + 360) % 360 - 180;
  return w === -180 ? 180 : w;
}
