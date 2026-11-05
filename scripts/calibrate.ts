import { generate } from '../src/core/generate/pipeline';
import { createTopology } from '../src/core/topology/registry';
import { scoreMaze } from '../src/core/difficulty/score';

const top = { kind: 'stacked', w: 10, h: 10, layers: 3 } as const;
const t = createTopology(top);
for (const [label, params] of [
  ['bushy, no traps', { newestBias: 0.0, trapsPerLayer: 0 }],
  ['deep, no traps', { newestBias: 1.0, trapsPerLayer: 0 }],
  ['deep, 2 traps', { newestBias: 1.0, trapsPerLayer: 2 }],
  ['deep, 3 traps, 2 bridges', { newestBias: 1.0, trapsPerLayer: 3, bridges: 2 }],
] as const) {
  const r = scoreMaze(generate({ topology: top, seed: 's', params }).maze, t);
  const m = r.metrics;
  console.log(label.padEnd(26), 'score', r.score, '| L', m.solutionLength, 'maxDepth', m.maxDepth, 'traps', m.traps, 'onRoute', m.trapsOnRoute, '| steps/N', r.explorationCost.toFixed(2), 'restarts', r.explorer.meanRestarts.toFixed(2), 'fail', r.explorer.failures);
  console.log('   ', JSON.stringify(Object.fromEntries(Object.entries(r.components).map(([k, v]) => [k, +v.toFixed(2)]))));
}
