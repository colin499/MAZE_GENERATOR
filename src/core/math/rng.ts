import { hash128 } from './hash';

/**
 * Seeded PRNG (sfc32). Every generator stage receives its own forked stream so that
 * changing one stage's parameters never perturbs another stage's choices.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(readonly label: string) {
    [this.a, this.b, this.c, this.d] = hash128(label);
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.a |= 0; this.b |= 0; this.c |= 0; this.d |= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    if (n <= 0) throw new RangeError(`Rng.int(${n})`);
    return Math.floor(this.next() * n);
  }

  /** Integer in [lo, hi] inclusive. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Rng.pick on empty array');
    return items[this.int(items.length)] as T;
  }

  /** In-place Fisher–Yates shuffle; returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = items[i] as T;
      items[i] = items[j] as T;
      items[j] = t;
    }
    return items;
  }

  /** Independent stream for a named sub-task. */
  fork(name: string): Rng {
    return new Rng(`${this.label}/${name}`);
  }
}
