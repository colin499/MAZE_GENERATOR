import { describe, expect, it } from 'vitest';
import { Rng } from '@core/math/rng';

describe('Rng', () => {
  it('is deterministic for a label', () => {
    const a = new Rng('x'), b = new Rng('x');
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(Array.from({ length: 20 }, () => b.next()));
  });
  it('forks are independent of sibling consumption', () => {
    const r1 = new Rng('s'); r1.next(); r1.next();
    const r2 = new Rng('s');
    expect(r1.fork('tree').next()).toBe(r2.fork('tree').next());
    expect(new Rng('s').fork('tree').next()).not.toBe(new Rng('s').fork('decoys').next());
  });
  it('int stays in range and is roughly uniform', () => {
    const r = new Rng('u');
    const counts = new Array(5).fill(0);
    for (let i = 0; i < 5000; i++) counts[r.int(5)]++;
    for (const c of counts) expect(c).toBeGreaterThan(800);
  });
});
