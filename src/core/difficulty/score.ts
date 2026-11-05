import type { Maze } from '../model/maze';
import type { Topology } from '../model/topology';
import { structuralMetrics } from './metrics';
import type { StructuralMetrics } from './metrics';
import { simulateExplorer } from './explorer';
import type { ExplorerStats } from './explorer';

export interface DifficultyReport {
  /** 0–100. */
  readonly score: number;
  readonly metrics: StructuralMetrics;
  readonly explorer: ExplorerStats;
  /** Steps a memoryful explorer needs divided by the number of playable cells. */
  readonly explorationCost: number;
  readonly components: Readonly<Record<string, number>>;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const unit = (x: number, cap: number) => clamp(x, 0, cap) / cap;

/**
 * Weights of the 0–1 components. "explorer" is the primary, behavioural measure: how much of the
 * maze a memoryful but imperfect player walks before finishing, relative to its size.
 */
export const SCORE_WEIGHTS = {
  explorer: 0.25,
  restarts: 0.15,
  length: 0.17,
  maxDepth: 0.12,
  sumDepth: 0.06,
  decoyNearGoal: 0.1,
  decisions: 0.03,
  traps: 0.07,
  tunnels: 0.05,
} as const;

export function scoreMaze(m: Maze, t: Topology, explorerRuns = 64): DifficultyReport {
  const metrics = structuralMetrics(m, t);
  const explorer = simulateExplorer(m, t, { runs: explorerRuns });
  const L = Math.max(1, metrics.solutionLength);
  const N = Math.max(1, metrics.cells);
  const explorationCost = explorer.meanSteps / N;
  const components = {
    explorer: unit(explorationCost, 2.5),
    restarts: unit(explorer.meanRestarts, 2.5),
    length: unit(L / N, 0.6),
    maxDepth: unit(metrics.maxDepth / N, 0.25),
    sumDepth: unit(metrics.sumDepth / N, 0.8),
    decoyNearGoal: unit(metrics.decoyNearGoal / N, 0.12),
    decisions: unit(metrics.decisions / L, 0.35),
    traps: unit(metrics.trapsOnRoute + 0.5 * (metrics.traps - metrics.trapsOnRoute), 6),
    tunnels: unit(metrics.bridges, 4),
  };
  let score = 0;
  for (const k of Object.keys(SCORE_WEIGHTS) as (keyof typeof SCORE_WEIGHTS)[]) score += SCORE_WEIGHTS[k] * components[k];
  if (metrics.solutionLength < 0) score = 0;
  return { score: Math.round(score * 1000) / 10, metrics, explorer, explorationCost, components };
}
