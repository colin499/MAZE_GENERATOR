#!/usr/bin/env tsx
/**
 * CLI: generate or load a maze and emit Fusion 360 scripts.
 *
 *   npm run export -- --gen 12x12x4 --seed demo --out out/demo
 *   npm run export -- maze.json --out out/demo [--mode replace] [--phys phys.json]
 *
 * Writes <out>.py (standalone), <out>.maze.json, <out>.plan.json and <out>.chunks/NN.py.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generate } from '../core/generate/pipeline';
import { createTopology } from '../core/topology/registry';
import { decodeMaze, encodeMaze } from '../core/serialize/codec';
import { buildPlan } from '../core/layout/planner';
import { DEFAULT_PHYSICAL, validatePhysical } from '../core/layout/physical';
import type { PhysicalParams } from '../core/layout/physical';
import { emitFusionChunks, emitFusionScript } from '../core/export/fusion/emit';
import { scoreMaze } from '../core/difficulty/score';
import { hasErrors } from '../core/model/validate';
import type { Maze } from '../core/model/maze';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1]!.startsWith('--')));
  const out = arg('out') ?? 'out/maze';
  const mode = (arg('mode') ?? 'resume') as 'resume' | 'replace';
  let maze: Maze;
  if (arg('gen')) {
    const dims = arg('gen')!.split('x').map(Number);
    const w = dims[0] ?? 0, h = dims[1] ?? 0, layers = dims[2] ?? 1;
    const topology = layers > 1 ? ({ kind: 'stacked', w, h, layers } as const) : ({ kind: 'flat', w, h } as const);
    const params = arg('params') ? (JSON.parse(arg('params')!) as object) : {};
    const r = generate({ topology, seed: arg('seed') ?? 'demo', params });
    if (hasErrors(r.diagnostics)) throw new Error(`generation failed: ${JSON.stringify(r.diagnostics)}`);
    maze = r.maze;
  } else if (positional[0]) {
    maze = decodeMaze(JSON.parse(readFileSync(positional[0], 'utf8')));
  } else {
    throw new Error('give a maze JSON file or --gen WxH[xLayers]');
  }
  const phys: PhysicalParams = { ...DEFAULT_PHYSICAL, ...(arg('phys') ? (JSON.parse(readFileSync(arg('phys')!, 'utf8')) as Partial<PhysicalParams>) : {}) };
  const issues = validatePhysical(phys);
  if (issues.some((i) => i.level === 'error')) throw new Error(`bad physical params: ${issues.map((i) => i.message).join('; ')}`);
  const topo = createTopology(maze.topology);
  const plan = buildPlan(maze, topo, phys);
  const report = scoreMaze(maze, topo);

  mkdirSync(dirname(resolve(out)), { recursive: true });
  mkdirSync(`${out}.chunks`, { recursive: true });
  writeFileSync(`${out}.py`, emitFusionScript(plan, { mode }));
  writeFileSync(`${out}.maze.json`, JSON.stringify(encodeMaze(maze)));
  writeFileSync(`${out}.plan.json`, JSON.stringify(plan));
  const chunks = emitFusionChunks(plan, { mode });
  chunks.forEach((c, i) => writeFileSync(`${out}.chunks/${String(i).padStart(2, '0')}.py`, c.code));
  const m = report.metrics;
  console.log(`maze ${maze.seed}: ${plan.meta.topology}`);
  console.log(`difficulty ${report.score}/100 — solution ${m.solutionLength} cells, max dead end ${m.maxDepth}, traps ${m.traps}, bridges ${m.bridges}`);
  console.log(`wrote ${out}.py, ${out}.maze.json, ${out}.plan.json and ${chunks.length} chunk(s) in ${out}.chunks/`);
  console.log(`expected: ${plan.expected.bodies} bodies, ~${plan.expected.volumeMm3} mm³, bbox ${JSON.stringify(plan.expected.bboxMm)}`);
}

main();
