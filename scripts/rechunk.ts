// Re-chunk a downloaded standalone Fusion script for the MCP bridge: split big wall features into batches
// so every chunk stays well under the bridge's 30 s limit. Usage: tsx scripts/rechunk.ts in.py outdir [maxSegs]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { emitFusionChunks } from '@core/export/fusion/emit';
import type { BuildPlan, Feature, FeatureGroup } from '@core/layout/plan';

const [, , input, outDir, maxArg, skipArg, labelArg] = process.argv;
const maxSegs = Number(maxArg ?? 300);
/** Runs already built by an earlier push (their batches are skipped) and a label that keeps new batch names unique. */
const skipRuns = Number(skipArg ?? 0);
const label = labelArg ?? '';
const src = readFileSync(input!, 'utf8');
const line = src.split('\n').find((l) => l.startsWith('PLAN = '))!;
const plan = JSON.parse(line.slice('PLAN = '.length).replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')) as BuildPlan;

const groups: FeatureGroup[] = [];
for (const g of plan.groups) {
  const first: Feature[] = [];
  const rest: Feature[] = [];
  for (const f of g.features) {
    if (f.op === 'thin' && f.segments.length > maxSegs) {
      const skip = f.segments.length > skipRuns ? skipRuns : 0;
      for (let i = skip, n = 0; i < f.segments.length; i += maxSegs, n++) rest.push({ ...f, name: `${f.name} ${label}${n + 1}`, segments: f.segments.slice(i, i + maxSegs) });
    } else if (first.length === 0 || rest.length === 0) first.push(f);
    else rest.push(f);
  }
  groups.push({ ...g, features: first });
  rest.forEach((f, i) => groups.push({ name: `${g.name} part ${i + 1}`, marker: `feature:${f.name}`, features: [f] }));
}
const chunks = emitFusionChunks({ ...plan, groups }, { mode: 'replace' });
mkdirSync(outDir!, { recursive: true });
chunks.forEach((c, i) => writeFileSync(join(outDir!, `${String(i).padStart(2, '0')}.py`), c.code));
console.log(JSON.stringify({ chunks: chunks.map((c) => c.name), features: groups.map((g) => g.features.map((f) => `${f.name}${f.op === 'thin' ? ` (${f.segments.length} runs)` : ''}`)) }, null, 1));
