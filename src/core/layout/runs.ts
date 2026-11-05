import type { Vec2 } from '../math/vec';

/** Unit wall segment between two grid corners (axis aligned, length 1). */
export type UnitSeg = readonly [Vec2, Vec2];

export interface Run {
  readonly from: Vec2;
  readonly to: Vec2;
  readonly length: number;
}

/**
 * Merge collinear, touching unit segments into maximal runs.
 * Horizontal runs (constant v) and vertical runs (constant u) are merged independently.
 */
export function mergeRuns(segs: readonly UnitSeg[]): Run[] {
  const horiz = new Map<number, number[]>(); // v -> list of u (segment from u to u+1)
  const vert = new Map<number, number[]>();  // u -> list of v
  for (const [a, b] of segs) {
    if (a[1] === b[1]) {
      const u = Math.min(a[0], b[0]);
      (horiz.get(a[1]) ?? horiz.set(a[1], []).get(a[1])!).push(u);
    } else if (a[0] === b[0]) {
      const v = Math.min(a[1], b[1]);
      (vert.get(a[0]) ?? vert.set(a[0], []).get(a[0])!).push(v);
    } else {
      throw new Error(`segment is not axis aligned: ${JSON.stringify([a, b])}`);
    }
  }
  const out: Run[] = [];
  const emit = (keys: Map<number, number[]>, horizontal: boolean) => {
    for (const [k, list] of [...keys.entries()].sort((x, y) => x[0] - y[0])) {
      const sorted = [...new Set(list)].sort((x, y) => x - y);
      let s = sorted[0]!;
      let prev = s;
      const push = (from: number, to: number) => {
        out.push(horizontal ? { from: [from, k], to: [to, k], length: to - from } : { from: [k, from], to: [k, to], length: to - from });
      };
      for (let i = 1; i < sorted.length; i++) {
        const x = sorted[i]!;
        if (x === prev + 1) { prev = x; continue; }
        push(s, prev + 1);
        s = x; prev = x;
      }
      push(s, prev + 1);
    }
  };
  emit(horiz, true);
  emit(vert, false);
  return out;
}
