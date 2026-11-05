import type { GenerateOptions, GenerateResult } from './pipeline';
import { generate } from './pipeline';
import { createTopology } from '../topology/registry';
import { scoreMaze } from '../difficulty/score';
import type { DifficultyReport } from '../difficulty/score';
import { hasErrors } from '../model/validate';

export interface SearchResult extends GenerateResult {
  readonly report: DifficultyReport;
  readonly seed: string;
  readonly tried: number;
}

/** Generate `k` seeds derived from the base seed and keep the hardest valid maze. */
export function searchHardest(opts: GenerateOptions, k: number): SearchResult {
  const topo = createTopology(opts.topology);
  let best: SearchResult | null = null;
  for (let i = 0; i < Math.max(1, k); i++) {
    const seed = i === 0 ? opts.seed : `${opts.seed}#${i}`;
    const r = generate({ ...opts, seed });
    if (hasErrors(r.diagnostics)) continue;
    const report = scoreMaze(r.maze, topo);
    if (!best || report.score > best.report.score) best = { ...r, report, seed, tried: i + 1 };
  }
  if (!best) {
    const r = generate(opts);
    return { ...r, report: scoreMaze(r.maze, topo), seed: opts.seed, tried: k };
  }
  return { ...best, tried: Math.max(1, k) };
}
