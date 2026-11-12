import { computed, effect, signal } from '@preact/signals';
import type { CellId } from '@core/model/ids';
import type { Maze } from '@core/model/maze';
import type { Topology, TopologySpec } from '@core/model/topology';
import { createTopology } from '@core/topology/registry';
import { generate, regenerate } from '@core/generate/pipeline';
import { searchHardest } from '@core/generate/search';
import { DEFAULT_GEN_PARAMS, normalizeGenParams } from '@core/generate/params';
import type { GenParams } from '@core/generate/params';
import { solve } from '@core/graph/solve';
import type { Solution } from '@core/graph/solve';
import { validate } from '@core/model/validate';
import type { Diagnostic } from '@core/model/validate';
import { scoreMaze } from '@core/difficulty/score';
import type { DifficultyReport } from '@core/difficulty/score';
import { DEFAULT_PHYSICAL, validatePhysical } from '@core/layout/physical';
import type { PhysicalParams } from '@core/layout/physical';
import { decodeMaze, encodeMaze } from '@core/serialize/codec';
import { setPassage, togglePassage, withGoal, withLocked, withStart, withTrap } from '@core/model/ops';
import { isShell, relation } from '@core/model/topology';
import { edgeKey } from '@core/model/ids';
import type { LayerMode } from '../scene/mazeMesh';
import type { PlaySettings, PlayStatus } from '../scene/viewer';
export type { LayerMode, PlaySettings, PlayStatus };

export type Tool = 'wall' | 'tunnel' | 'trap' | 'dropout' | 'start' | 'goal' | 'lock';

export type ShapeKind = TopologySpec['kind'];

export interface GenSettings {
  readonly kind: ShapeKind;
  readonly w: number;
  readonly h: number;
  readonly layers: number;
  /** Cylinder: cells around the tube and along its axis. */
  readonly around: number;
  readonly along: number;
  /** Cube / sphere: cells per face. */
  readonly n: number;
  readonly seed: string;
  readonly params: GenParams;
}

const SHAPE_DEFAULTS = { w: 12, h: 12, layers: 3, around: 9, along: 8, n: 4 };

const AUTOSAVE_KEY = 'maze-builder:autosave:v1';

function specOf(s: GenSettings): TopologySpec {
  switch (s.kind) {
    case 'flat': return { kind: 'flat', w: s.w, h: s.h };
    case 'stacked': return { kind: 'stacked', w: s.w, h: s.h, layers: s.layers };
    case 'cylinder': return { kind: 'cylinder', around: s.around, along: s.along };
    case 'cube': return { kind: 'cube', n: s.n };
    case 'sphere': return { kind: 'sphere', n: s.n };
  }
}

function settingsOf(m: Maze): GenSettings {
  const t = m.topology;
  const base = { ...SHAPE_DEFAULTS, seed: m.seed, params: m.gen };
  switch (t.kind) {
    case 'flat': return { ...base, kind: 'flat', w: t.w, h: t.h, layers: 1 };
    case 'stacked': return { ...base, kind: 'stacked', w: t.w, h: t.h, layers: t.layers };
    case 'cylinder': return { ...base, kind: 'cylinder', around: t.around, along: t.along };
    case 'cube': return { ...base, kind: 'cube', n: t.n };
    case 'sphere': return { ...base, kind: 'sphere', n: t.n };
  }
}

function initialMaze(): Maze {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { maze: unknown; phys?: PhysicalParams };
      const m = decodeMaze(saved.maze);
      if (saved.phys) phys.value = { ...DEFAULT_PHYSICAL, ...saved.phys };
      return m;
    }
  } catch { /* ignore corrupt autosave */ }
  return generate({ topology: { kind: 'stacked', w: 12, h: 12, layers: 3 }, seed: 'brainfood', params: { trapsPerLayer: 2, bridges: 2 } }).maze;
}

// ---- state ---------------------------------------------------------------------------------
export const phys = signal<PhysicalParams>(DEFAULT_PHYSICAL);
export const maze = signal<Maze>(initialMaze());
export const settings = signal<GenSettings>(settingsOf(maze.value));
export const tool = signal<Tool>('wall');
/** Which app is showing: the grid maze editor, the rotary maze player or the lock box (also selected by the URL hash #rotary / #lockbox). */
export const appMode = signal<'editor' | 'rotary' | 'lockbox'>(
  typeof location === 'undefined' ? 'editor' : location.hash === '#rotary' ? 'rotary' : location.hash === '#lockbox' ? 'lockbox' : 'editor',
);
export const activeLayer = signal<number>(-1); // -1 = all layers
/** Explicit display mode per layer; the active layer is always solid. */
export const layerModes = signal<Readonly<Record<number, LayerMode>>>({});
export const play = signal<PlaySettings | null>(null);
export const playPrefs = signal<PlaySettings>({ autopilot: false, follow: true, xray: true, maxTiltDeg: 7, turnDegPerS: 60, speed: 1, view: 'ball', zoomCells: 9 });
/** Shells: show the unfolded net for editing. */
export const unfolded = signal(false);
/** Shells: clip away the half nearest the camera so the inside is visible. */
export const cutaway = signal(true);
export const playStatus = signal<PlayStatus | null>(null);
export const playLog = signal<readonly string[]>([]);
export const resetTick = signal(0);
export const showSolution = signal(false);
export const showHeat = signal(false);
export const hoverInfo = signal<string>('');
export const busy = signal<string>('');
export const genDiagnostics = signal<readonly Diagnostic[]>([]);

const past: Maze[] = [];
const future: Maze[] = [];
export const canUndo = signal(false);
export const canRedo = signal(false);

export const topo = computed<Topology>(() => createTopology(maze.value.topology));
export const solution = computed<Solution>(() => solve(maze.value, topo.value));
export const diagnostics = computed<readonly Diagnostic[]>(() => [...genDiagnostics.value, ...validate(maze.value, topo.value)]);
export const report = computed<DifficultyReport>(() => scoreMaze(maze.value, topo.value, 48));
export const physIssues = computed(() => validatePhysical(phys.value, maze.value.topology));
export const isShellMaze = computed(() => isShell(maze.value.topology.kind));
export const effectiveLayerModes = computed<LayerMode[]>(() => {
  const n = topo.value.layerCount, a = activeLayer.value, m = layerModes.value;
  return Array.from({ length: n }, (_, k) => (k === a ? 'solid' : m[k] ?? 'solid'));
});

effect(() => {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ maze: encodeMaze(maze.value), phys: phys.value }));
  } catch { /* storage may be unavailable */ }
});

// ---- commands ------------------------------------------------------------------------------
function commit(next: Maze, keepDiagnostics = false): void {
  if (next === maze.value) return;
  past.push(maze.value);
  if (past.length > 200) past.shift();
  future.length = 0;
  if (!keepDiagnostics) genDiagnostics.value = [];
  maze.value = next;
  canUndo.value = true;
  canRedo.value = false;
}

export function undo(): void {
  const prev = past.pop();
  if (!prev) return;
  future.push(maze.value);
  maze.value = prev;
  canUndo.value = past.length > 0;
  canRedo.value = true;
}

export function redo(): void {
  const next = future.pop();
  if (!next) return;
  past.push(maze.value);
  maze.value = next;
  canUndo.value = true;
  canRedo.value = future.length > 0;
}

export function updateSettings(patch: Partial<GenSettings>): void {
  settings.value = { ...settings.value, ...patch };
}

export function updateParams(patch: Partial<GenParams>): void {
  settings.value = { ...settings.value, params: normalizeGenParams({ ...settings.value.params, ...patch }) };
}

export function generateNew(): void {
  const s = settings.value;
  const r = generate({ topology: specOf(s), seed: s.seed, params: s.params });
  genDiagnostics.value = r.diagnostics.filter((d) => d.code === 'sealed-region' || d.code === 'no-exit-site');
  commit(r.maze, true);
  activeLayer.value = -1;
}

/** Regenerate everything that is not locked, with a fresh seed. */
export function regenerateUnlocked(): void {
  const s = settings.value;
  const seed = nextSeed(s.seed);
  updateSettings({ seed });
  const base = { ...maze.value, gen: s.params };
  const r = regenerate(base, seed, s.params);
  genDiagnostics.value = r.diagnostics.filter((d) => d.level === 'error' && d.code !== 'unsolvable');
  commit(r.maze, true);
}

export function makeHarder(k = 24): void {
  const s = settings.value;
  busy.value = `searching ${k} seeds…`;
  setTimeout(() => {
    try {
      const opts = maze.value.locked.size ? { topology: specOf(s), seed: s.seed, params: s.params, base: maze.value } : { topology: specOf(s), seed: s.seed, params: s.params };
      const r = searchHardest(opts, k);
      updateSettings({ seed: r.seed });
      commit(r.maze);
    } finally {
      busy.value = '';
    }
  }, 10);
}

export function newSeed(): void {
  updateSettings({ seed: nextSeed(settings.value.seed) });
  generateNew();
}

function nextSeed(seed: string): string {
  const m = /^(.*?)(\d+)$/.exec(seed);
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${seed}2`;
}

export function resetParams(): void {
  updateSettings({ params: DEFAULT_GEN_PARAMS });
}

/** Click on the wall slot between two lateral neighbours. */
export function clickSlot(a: CellId, b: CellId): void {
  const m = maze.value;
  const t = topo.value;
  if (m.disabled.has(a) || m.disabled.has(b)) return;
  if (tool.value === 'tunnel') {
    const e = m.edges.get(edgeKey(a, b));
    commit(setPassage(m, t, a, b, e?.kind === 'tunnel' ? 'open' : 'tunnel'));
    return;
  }
  commit(togglePassage(m, t, a, b));
}

/** Click on a cell floor. */
export function clickCell(c: CellId): void {
  const m = maze.value;
  const t = topo.value;
  switch (tool.value) {
    case 'start': if (!m.disabled.has(c) && !m.traps.has(c)) commit(withStart(m, c)); break;
    case 'goal': if (!m.disabled.has(c) && !m.traps.has(c)) commit(withGoal(m, c)); break;
    case 'trap': if (c !== m.start && c !== m.goal && !m.disabled.has(c)) commit(withTrap(m, t, c, !m.traps.has(c))); break;
    case 'lock': commit(withLocked(m, [c], !m.locked.has(c))); break;
    case 'dropout': {
      const b = t.below(c);
      if (b === null || m.disabled.has(c) || m.disabled.has(b)) break;
      if (relation(t, c, b) !== 'vertical') break;
      const has = m.edges.has(edgeKey(c, b));
      commit(setPassage(m, t, c, b, has ? null : 'dropout'));
      break;
    }
    default: break;
  }
}

export function lockLayer(layer: number, locked: boolean): void {
  const t = topo.value;
  const cells: CellId[] = [];
  for (let i = 0; i < t.cellCount; i++) if (t.cell(i as CellId).layer === layer) cells.push(i as CellId);
  commit(withLocked(maze.value, cells, locked));
}

export function clearLocks(): void {
  commit(withLocked(maze.value, [...maze.value.locked], false));
}

export function loadMazeJson(text: string): void {
  const parsed = JSON.parse(text) as { maze?: unknown; phys?: PhysicalParams } | Record<string, unknown>;
  const m = decodeMaze('maze' in parsed && parsed.maze ? parsed.maze : parsed);
  if ('phys' in parsed && parsed.phys) phys.value = { ...DEFAULT_PHYSICAL, ...parsed.phys };
  settings.value = settingsOf(m);
  commit(m);
  activeLayer.value = -1;
}

export function saveMazeJson(): string {
  return JSON.stringify({ formatVersion: 1, maze: encodeMaze(maze.value), phys: phys.value }, null, 0);
}

export function updatePhys(patch: Partial<PhysicalParams>): void {
  phys.value = { ...phys.value, ...patch };
}

// ---- layers --------------------------------------------------------------------------------
/** Edit one layer; the others become translucent context (hidden ones stay hidden). */
export function focusLayer(k: number): void {
  activeLayer.value = k;
  const next: Record<number, LayerMode> = {};
  for (let i = 0; i < topo.value.layerCount; i++) next[i] = i === k ? 'solid' : layerModes.value[i] === 'hidden' ? 'hidden' : 'ghost';
  layerModes.value = next;
}

export function showAllLayers(): void {
  activeLayer.value = -1;
  layerModes.value = {};
}

export function setLayerMode(k: number, mode: LayerMode): void {
  layerModes.value = { ...layerModes.value, [k]: mode };
  if (mode !== 'solid' && activeLayer.value === k) activeLayer.value = -1;
}

export function setOtherLayers(mode: LayerMode): void {
  const next: Record<number, LayerMode> = {};
  for (let i = 0; i < topo.value.layerCount; i++) next[i] = i === activeLayer.value ? 'solid' : mode;
  layerModes.value = next;
}

// ---- play mode -----------------------------------------------------------------------------
export function startPlay(): void {
  playLog.value = [];
  play.value = playPrefs.value;
}

export function stopPlay(): void {
  play.value = null;
  playStatus.value = null;
}

export function updatePlay(patch: Partial<PlaySettings>): void {
  playPrefs.value = { ...playPrefs.value, ...patch };
  if (play.value) play.value = playPrefs.value;
}

export function resetBall(): void {
  resetTick.value += 1;
}

export function reportPlay(status: PlayStatus, events: readonly string[]): void {
  playStatus.value = status;
  const notable = events.filter((e) => e !== 'bump');
  if (notable.length) {
    const t = `${status.elapsed.toFixed(1)}s`;
    const text: Record<string, string> = { drop: 'dropped to layer ' + status.layer, trap: 'trap! ball lost', goal: 'GOAL reached', reset: 'back at the start' };
    playLog.value = [...notable.map((e) => `${t} · ${text[e] ?? e}`), ...playLog.value].slice(0, 12);
  }
}
