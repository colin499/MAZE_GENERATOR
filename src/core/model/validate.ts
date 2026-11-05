import type { CellId } from './ids';
import type { Maze } from './maze';
import type { Topology } from './topology';
import { relation, upperOf } from './topology';
import { solve } from '../graph/solve';

export interface Diagnostic {
  readonly level: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly cells?: readonly CellId[];
}

/** Structural + solvability checks. Errors mean the maze is not buildable/playable as-is. */
export function validate(m: Maze, t: Topology): Diagnostic[] {
  const out: Diagnostic[] = [];
  const bad = (code: string, message: string, cells?: readonly CellId[]) => out.push(cells ? { level: 'error', code, message, cells } : { level: 'error', code, message });
  const warn = (code: string, message: string, cells?: readonly CellId[]) => out.push(cells ? { level: 'warning', code, message, cells } : { level: 'warning', code, message });

  const inRange = (c: CellId) => Number.isInteger(c) && c >= 0 && c < t.cellCount;
  if (!inRange(m.start)) bad('start-range', `start cell ${m.start} is out of range`);
  if (!inRange(m.goal)) bad('goal-range', `goal cell ${m.goal} is out of range`);
  if (m.start === m.goal) bad('start-is-goal', 'start and goal are the same cell');
  if (inRange(m.start) && !t.allowedStart(m.start)) warn('start-placement', 'start is not in the usual start region', [m.start]);
  if (inRange(m.goal) && !t.allowedGoal(m.goal)) warn('goal-placement', 'goal is not in the usual goal region', [m.goal]);

  for (const e of m.edges.values()) {
    if (!inRange(e.a) || !inRange(e.b)) { bad('edge-range', `edge ${e.a}-${e.b} references a cell out of range`); continue; }
    const rel = relation(t, e.a, e.b);
    if (e.via && e.via.length) {
      if (e.kind !== 'tunnel') bad('via-kind', `only tunnels may pass under cells (${e.a}-${e.b})`, [e.a, e.b]);
      continue; // underpass geometry is validated by the topology's long links (later phase)
    }
    if (rel === 'none') { bad('edge-adjacency', `cells ${e.a} and ${e.b} are not neighbours`, [e.a, e.b]); continue; }
    if (rel === 'lateral' && (e.kind === 'dropout' || e.kind === 'ramp')) bad('edge-kind', `${e.kind} between lateral neighbours ${e.a}-${e.b}`, [e.a, e.b]);
    if (rel === 'vertical' && (e.kind === 'open' || e.kind === 'tunnel')) bad('edge-kind', `${e.kind} between stacked cells ${e.a}-${e.b}`, [e.a, e.b]);
    if (e.kind === 'dropout') {
      const upper = upperOf(t, e.a, e.b);
      if (e.from === undefined || e.from !== upper) bad('dropout-direction', `dropout ${e.a}-${e.b} must fall from the upper cell`, [e.a, e.b]);
    }
  }
  for (const c of m.traps) {
    if (!inRange(c)) { bad('trap-range', `trap cell ${c} is out of range`); continue; }
    if (c === m.start || c === m.goal) bad('trap-endpoint', 'start/goal cannot be a trap', [c]);
    if (m.disabled.has(c)) bad('trap-disabled', `trap ${c} is inside a shaft`, [c]);
    for (let b = t.below(c); b !== null; b = t.below(b)) if (!m.disabled.has(b)) bad('trap-shaft', `cell ${b} below trap ${c} must be a shaft`, [c, b]);
    let degree = 0;
    for (const e of m.edges.values()) if (e.a === c || e.b === c) degree++;
    if (degree > 1) warn('trap-corridor', `trap ${c} sits in a corridor; cells beyond it are cut off`, [c]);
  }
  for (const c of m.disabled) {
    if (!inRange(c)) { bad('disabled-range', `disabled cell ${c} is out of range`); continue; }
    if (c === m.start || c === m.goal) bad('disabled-endpoint', 'start/goal cannot be a shaft cell', [c]);
  }
  for (const e of m.edges.values()) {
    if (m.disabled.has(e.a) || m.disabled.has(e.b)) bad('edge-disabled', `passage ${e.a}-${e.b} touches a shaft cell`, [e.a, e.b]);
  }
  if (out.some((d) => d.level === 'error')) return out;

  const s = solve(m, t);
  if (!s.solvable) bad('unsolvable', 'no path from start to goal');
  if (s.stuckCells.length) bad('stuck', `${s.stuckCells.length} reachable cell(s) cannot reach the goal (one-way trap)`, s.stuckCells);
  const unreachable = s.unreachableCells.filter((c) => !m.disabled.has(c));
  if (unreachable.length) warn('unreachable', `${unreachable.length} cell(s) are unreachable from the start`, unreachable);
  return out;
}

export const hasErrors = (ds: readonly Diagnostic[]): boolean => ds.some((d) => d.level === 'error');
