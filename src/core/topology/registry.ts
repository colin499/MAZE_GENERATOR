import type { Topology, TopologySpec } from '../model/topology';
import { GridTopology } from './grid';
import { CylinderTopology } from './cylinder';
import { CubeTopology } from './cube';

const cache = new Map<string, Topology>();

export function specKey(spec: TopologySpec): string {
  return JSON.stringify(spec, Object.keys(spec).sort());
}

/** Resolve a spec to a (memoised) Topology instance. */
export function createTopology(spec: TopologySpec): Topology {
  const key = specKey(spec);
  const hit = cache.get(key);
  if (hit) return hit;
  let t: Topology;
  switch (spec.kind) {
    case 'flat':
    case 'stacked':
      t = new GridTopology(spec);
      break;
    case 'cube':
    case 'sphere':
      t = new CubeTopology(spec);
      break;
    case 'cylinder':
      t = new CylinderTopology(spec);
      break;
  }
  cache.set(key, t);
  return t;
}
