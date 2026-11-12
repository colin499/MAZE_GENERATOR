/**
 * Rotary ball maze: a fixed top piece (walls on a round floor) over a dial whose arc walls ("shutters") come up
 * through floor slots and slide when the dial is turned. Geometry is plain polygons in mm, +y = north, angles CCW.
 * Files are produced by `export_app.py` in the ROTARY_BALL_MAZE project (format "rotary-maze/1").
 */
export type Pt = readonly [number, number];

export interface Poly {
  readonly outer: readonly Pt[];
  readonly holes: readonly (readonly Pt[])[];
}

export type DemoEvent =
  | { readonly t: 'move'; readonly k: number; readonly pts: readonly Pt[]; readonly wrong: boolean }
  | { readonly t: 'turn'; readonly k0: number; readonly k1: number; readonly wrong: boolean }
  | { readonly t: 'pause'; readonly s: number; readonly text: string; readonly wrong: boolean };

export interface Demo {
  readonly name: string;
  readonly maze: number;
  readonly wrong: boolean;
  readonly events: readonly DemoEvent[];
}

export interface RotaryRoute {
  /** Maze number (= number of grooves marking its start position on the dial edge). */
  readonly maze: number;
  /** Dial position at which this maze's entry door is open. */
  readonly startPos: number;
  /** Fewest dial clicks that solve it. */
  readonly clicks: number;
  readonly seq: readonly number[];
}

export interface RotaryMaze {
  readonly format: 'rotary-maze/1';
  readonly name: string;
  readonly ballR: number;
  /** Inner radius of the rim (outer wall of the playfield). */
  readonly rimR: number;
  readonly outerR: number;
  readonly wallH: number;
  readonly shutterH: number;
  readonly detentDeg: number;
  readonly nDetent: number;
  /** Dial position that opens the return lane. */
  readonly returnPos: number;
  readonly start: Pt;
  /** Goal cup: square of this half-size at the centre, sunk below the floor (one-way). */
  readonly cup: { readonly half: number };
  /** Return lane: trench from the cup south to yEnd, flat-deep down to yFlatEnd then ramping up to the floor. */
  readonly lane: { readonly half: number; readonly yTop: number; readonly yFlatEnd: number; readonly yEnd: number; readonly depth: number };
  /** Legacy input only (older files): trap rectangles beside the lane. Use `trench`. */
  readonly traps?: readonly TrapRect[];
  /** Everything below floor level: the goal cup, the return lane and pit traps. Regions may ride on the dial. */
  readonly trench: readonly TrenchRegion[];
  /** Depth of the goal cup (mm). The lane is deeper or equal, so the cup -> lane step is one-way. */
  readonly cupDepth: number;
  /** Rotating floor rings of the dial (drawn only; the floor is flush). */
  readonly dialFloor: readonly { readonly r0: number; readonly r1: number }[];
  /** [dial position, number of grooves]. */
  readonly marks: readonly (readonly [number, number])[];
  readonly routes: readonly RotaryRoute[];
  readonly walls: readonly Poly[];
  readonly slots: readonly Poly[];
  /** Dial walls in the dial frame (dial at position 0). */
  readonly shutters: readonly Poly[];
  /** Floor-flush ribs on the dial that close the slot between shutters (no collision). */
  readonly fillers: readonly Poly[];
  readonly demos: readonly Demo[];
}

export interface TrapRect { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

/**
 * A sunken area. `poly` is in the fixed frame, or for frame 'dial' in the dial frame (dial at angle 0).
 * Dial regions are lane notches in the rotating rings: they line up with the lane at the return position.
 */
export interface TrenchRegion {
  readonly frame: 'fixed' | 'dial';
  readonly kind: 'cup' | 'lane' | 'trap';
  readonly poly: readonly Pt[];
}

export function parseRotaryMaze(text: string): RotaryMaze {
  const raw = JSON.parse(text) as Partial<RotaryMaze>;
  if (raw.format !== 'rotary-maze/1') throw new Error('Not a rotary maze file (expected format "rotary-maze/1")');
  for (const key of ['ballR', 'rimR', 'outerR', 'wallH', 'detentDeg', 'nDetent', 'returnPos'] as const) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw new Error(`Rotary maze: "${key}" missing`);
  }
  if (!Array.isArray(raw.walls) || !Array.isArray(raw.shutters) || !raw.start || !raw.cup || !raw.lane) {
    throw new Error('Rotary maze: geometry missing');
  }
  const L = raw.lane, h = raw.cup.half;
  let trench = raw.trench;
  if (!Array.isArray(trench)) {
    // older files: a square cup, one straight lane and optional trap rectangles, all in the fixed floor
    const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    trench = [
      { frame: 'fixed', kind: 'cup', poly: rect(-h, -h, h, h) },
      { frame: 'fixed', kind: 'lane', poly: rect(-L.half, L.yEnd, L.half, -h) },
      ...(raw.traps ?? []).map((t): TrenchRegion => ({ frame: 'fixed', kind: 'trap', poly: rect(t.x0, t.y0, t.x1, t.y1) })),
    ];
  }
  return {
    slots: [], fillers: [], demos: [], routes: [], marks: [], dialFloor: [], cupDepth: L.depth,
    name: 'Rotary maze', shutterH: raw.wallH!, ...raw, trench,
  } as RotaryMaze;
}

function inPoly(poly: readonly Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

const RAD = Math.PI / 180;

export interface TrenchHit { readonly depth: number; readonly region: TrenchRegion; /** 0 = flat floor, 1 = on the ramp. */ readonly onRamp: boolean }

/** The sunken region under (x, y) with the dial at angleDeg, or null over the normal floor. The deepest one wins. */
export function trenchAt(m: RotaryMaze, x: number, y: number, angleDeg: number): TrenchHit | null {
  const L = m.lane;
  let best: TrenchHit | null = null;
  let c = 1, sn = 0, cr = 1, sr = 0, haveDial = false;
  for (const reg of m.trench) {
    let px = x, py = y, ly = y;
    if (reg.frame === 'dial') {
      if (!haveDial) {
        c = Math.cos(angleDeg * RAD); sn = Math.sin(angleDeg * RAD);
        const back = (angleDeg - m.returnPos * m.detentDeg) * RAD;     // rotation that lines the notch up with the lane
        cr = Math.cos(back); sr = Math.sin(back);
        haveDial = true;
      }
      px = x * c + y * sn; py = -x * sn + y * c;
      ly = -x * sr + y * cr;
    }
    if (!inPoly(reg.poly, px, py)) continue;
    let depth = m.cupDepth, onRamp = false;
    if (reg.kind !== 'cup') {
      const f = (ly - L.yEnd) / (L.yFlatEnd - L.yEnd);
      onRamp = f < 1;
      depth = L.depth * Math.max(0, Math.min(1, f));
    }
    if (!best || depth > best.depth) best = { depth, region: reg, onRamp };
  }
  return best;
}
