import type { Maze } from '../model/maze';
import type { Topology } from '../model/topology';
import type { PhysicalParams } from './physical';
import type { BuildPlan } from './plan';
import { planGrid } from './planners/grid';
import type { GridPlanOptions } from './planners/grid';
import { planShell } from './planners/shell';

/** Dispatch to the planner for the maze's topology. */
export function buildPlan(maze: Maze, topo: Topology, phys: PhysicalParams, opts: GridPlanOptions = {}): BuildPlan {
  switch (topo.spec.kind) {
    case 'flat':
    case 'stacked':
      return planGrid(maze, topo, phys, opts);
    case 'cylinder':
    case 'cube':
    case 'sphere':
      return planShell(maze, topo, phys, opts);
  }
}
