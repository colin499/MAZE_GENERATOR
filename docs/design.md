# Maze Builder — design notes

## Layers
- `src/core` — pure TypeScript, no DOM (`tsconfig.core.json` proves it). Everything testable without a browser or Fusion.
- `src/editor` — Preact + signals UI around a three.js viewport. Holds state and calls core functions; no maze logic.
- `src/cli/export.ts` — generate/load a maze and emit Fusion scripts from the terminal.

## Core model (`src/core/model`)
- `Topology` (topology.ts): stateless oracle for a `TopologySpec`. Enumerates cells, lateral `side()` neighbours,
  `below()/above()`, planar panels and their physical frames. Generators only use adjacency; renderer and planner use geometry.
  Flat and stacked grids are implemented (`topology/grid.ts`); cube and cylinder slot in behind the same interface.
- `Maze` (maze.ts): immutable. Walls are implicit; `edges` holds passages only: `open`, `tunnel` (bridge: wall lifted,
  ball rolls under), `dropout` (one-way hole to the layer below, `from` = upper cell), `ramp` (user placed).
  `traps` are dead-end cells with a hole that drops the ball out of play (graph arc back to `start`); `disabled` cells
  are the vertical shaft under a trap. `locked` cells survive regeneration.
- `ops.ts`: pure edit operations returning new mazes; undo/redo is a list of states.
- `validate.ts`: structural rules + solvability + liveness (every reachable cell can reach the goal).

## Generation (`src/core/generate`)
Seeded `Rng` forked per stage. Pipeline: place start → `carveLayers` → refine goal → bridges → braid.
`carveLayers` works top-down: growing tree (newest-biased, long corridors) with locks and a Kruskal finish for
connectivity; exit = far dead end from the layer entry (dropout, or goal on the bottom layer); traps = dead ends next
to the late part of that layer's route, their column below becomes a shaft before lower layers are carved.
Why no "false dropouts to the layer below": each layer's exit is already the farthest cell from where the ball lands,
so any other hole is a shortcut (measured: setbacks ≤ 0). Traps are the honest punishing mechanic.

## Difficulty (`src/core/difficulty`)
Structural metrics (solution length, decisions, dead-end depths, traps on route, setbacks) plus a simulated explorer:
memoryful, goal-biased DFS that walks known cells to the frontier and restarts after traps. Score = weighted 0–100.
`searchHardest` generates K derived seeds and keeps the best.

## Layout and export (`src/core/layout`, `src/core/export/fusion`)
`buildPlan(maze, topo, phys)` → `BuildPlan`: per layer a floor polygon, merged wall runs (thin extrude of centre lines,
extended by wallT/2 for square corners), lifted bridge walls, round holes (dropouts, traps, goal) and square shaft
cut-outs. Points are 3D mm; expressions reference Fusion user parameters so heights/thickness/holes stay live.
`emitFusionScript` = standalone script for Scripts & Add-Ins; `emitFusionChunks` = one idempotent script per layer for
the MCP bridge (30 s limit, retries on timeout). The Python interpreter (`pyTemplate.ts`) is fixed; see `fusion-notes.md`.

## Adding a topology
Implement `Topology` (+ register in `topology/registry.ts`), add a planner under `layout/planners`, extend
`panels()`-based rendering if panels are not XY offsets. Generators need no changes; set `supportsGravity=false`
where no fixed "down" exists (cube, cylinder) so traps/dropouts are skipped.
