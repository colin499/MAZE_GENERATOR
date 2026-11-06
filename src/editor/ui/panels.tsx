import { useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import * as S from '../app/store';
import type { Tool } from '../app/store';
import { emitFusionChunks, emitFusionScript } from '@core/export/fusion/emit';
import { buildPlan } from '@core/layout/planner';
import type { PhysicalParams } from '@core/layout/physical';
import type { GenParams } from '@core/generate/params';

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'wall', label: 'Wall', hint: 'click a wall slot to open/close it' },
  { id: 'tunnel', label: 'Bridge', hint: 'click an open passage to hide it under a lifted wall (shown violet)' },
  { id: 'trap', label: 'Trap', hint: 'click a dead-end cell to add a trap hole (ball falls out)' },
  { id: 'dropout', label: 'Dropout', hint: 'click a cell to toggle a hole to the layer below' },
  { id: 'start', label: 'Start', hint: 'click a cell to place the start' },
  { id: 'goal', label: 'Goal', hint: 'click a cell to place the goal hole' },
  { id: 'lock', label: 'Lock', hint: 'click cells to protect them from regeneration' },
];

export function Toolbar(): JSX.Element {
  return (
    <header>
      <h1>Maze Builder</h1>
      <div class="tools">
        {TOOLS.map((t) => (
          <button key={t.id} class={S.tool.value === t.id ? 'active' : ''} title={t.hint} onClick={() => (S.tool.value = t.id)}>{t.label}</button>
        ))}
      </div>
      <div class="spacer" />
      <button disabled={!S.canUndo.value} onClick={S.undo} title="Cmd/Ctrl+Z">Undo</button>
      <button disabled={!S.canRedo.value} onClick={S.redo} title="Shift+Cmd/Ctrl+Z">Redo</button>
    </header>
  );
}

function Num({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void }): JSX.Element {
  return (
    <div class="row">
      <label>{label}</label>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
    </div>
  );
}

function Range({ label, value, min, max, step, onChange, fmt }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string }): JSX.Element {
  return (
    <div class="row">
      <label>{label}</label>
      <input type="range" value={value} min={min} max={max} step={step} onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
      <span class="val">{fmt ? fmt(value) : value}</span>
    </div>
  );
}

export function GeneratePanel(): JSX.Element {
  const s = S.settings.value;
  const p = s.params;
  const setP = (patch: Partial<GenParams>) => S.updateParams(patch);
  return (
    <section>
      <h2>Generate</h2>
      <div class="row">
        <label>Type</label>
        <select value={s.kind} onChange={(e) => S.updateSettings({ kind: (e.target as HTMLSelectElement).value as 'flat' | 'stacked' })}>
          <option value="stacked">Stacked layers</option>
          <option value="flat">Flat board</option>
        </select>
      </div>
      <Num label="Columns" value={s.w} min={2} max={60} onChange={(w) => S.updateSettings({ w: Math.max(2, Math.round(w)) })} />
      <Num label="Rows" value={s.h} min={2} max={60} onChange={(h) => S.updateSettings({ h: Math.max(2, Math.round(h)) })} />
      {s.kind === 'stacked' && <Num label="Layers" value={s.layers} min={2} max={12} onChange={(l) => S.updateSettings({ layers: Math.max(2, Math.round(l)) })} />}
      <div class="row">
        <label>Seed</label>
        <input type="text" value={s.seed} onChange={(e) => S.updateSettings({ seed: (e.target as HTMLInputElement).value })} />
      </div>
      <Range label="Corridor length" value={p.newestBias} min={0} max={1} step={0.05} onChange={(v) => setP({ newestBias: v })} fmt={(v) => v.toFixed(2)} />
      <Range label="Straightness" value={p.straightBias} min={0} max={1} step={0.05} onChange={(v) => setP({ straightBias: v })} fmt={(v) => v.toFixed(2)} />
      <Range label="Traps / layer" value={p.trapsPerLayer} min={0} max={8} step={1} onChange={(v) => setP({ trapsPerLayer: v })} />
      <Range label="Trap reach" value={p.trapRadius} min={1} max={8} step={1} onChange={(v) => setP({ trapRadius: v })} />
      <Range label="Bridges" value={p.bridges} min={0} max={12} step={1} onChange={(v) => setP({ bridges: v })} />
      <Range label="Loops" value={p.braid} min={0} max={1} step={0.05} onChange={(v) => setP({ braid: v })} fmt={(v) => v.toFixed(2)} />
      <div class="btns" style="margin-top:8px">
        <button class="primary" onClick={S.generateNew}>Generate</button>
        <button onClick={S.newSeed}>Next seed</button>
        <button onClick={() => S.makeHarder(24)} disabled={!!S.busy.value}>{S.busy.value || 'Harder (search 24)'}</button>
        <button onClick={S.regenerateUnlocked} title="Keep locked cells, regenerate everything else with a new seed">Regenerate unlocked</button>
        <button onClick={S.resetParams}>Reset sliders</button>
      </div>
      <p class="hint">Corridor length 1.0 = recursive backtracker (longest corridors). Traps are dead-end holes that drop the ball out of the maze; the column beneath becomes a shaft.</p>
    </section>
  );
}

export function LayersPanel(): JSX.Element {
  const t = S.topo.value;
  const layers = Array.from({ length: t.layerCount }, (_, i) => i);
  const active = S.activeLayer.value;
  return (
    <section class="layers">
      <h2>Layers</h2>
      <div class="btns">
        <button class={active < 0 ? 'active' : ''} onClick={() => (S.activeLayer.value = -1)}>All</button>
        {layers.slice().reverse().map((k) => (
          <button key={k} class={active === k ? 'active' : ''} onClick={() => (S.activeLayer.value = k)}>{k === t.layerCount - 1 && t.layerCount > 1 ? `${k} (top)` : k}</button>
        ))}
      </div>
      {active >= 0 && (
        <div class="btns" style="margin-top:6px">
          <button onClick={() => S.lockLayer(active, true)}>Lock layer</button>
          <button onClick={() => S.lockLayer(active, false)}>Unlock layer</button>
        </div>
      )}
      <div class="row" style="margin-top:6px">
        <label>Locked cells</label>
        <span>{S.maze.value.locked.size}</span>
        {S.maze.value.locked.size > 0 && <button onClick={S.clearLocks}>Clear</button>}
      </div>
    </section>
  );
}

export function PhysicalPanel(): JSX.Element {
  const p = S.phys.value;
  const f = (k: keyof PhysicalParams, label: string, step = 0.1) => <Num label={label} value={p[k]} step={step} min={0} onChange={(v) => S.updatePhys({ [k]: v } as Partial<PhysicalParams>)} />;
  return (
    <section>
      <h2>Physical (mm)</h2>
      {f('ballDia', 'Ball diameter')}
      {f('chanW', 'Channel width')}
      {f('wallT', 'Wall thickness')}
      {f('floorT', 'Floor thickness')}
      {f('wallH', 'Wall height')}
      {f('holeDia', 'Hole diameter')}
      {f('bridgeLift', 'Bridge gap')}
      {S.physIssues.value.map((i, n) => <div key={n} class={`diag ${i.level}`}>{i.message}</div>)}
      <p class="hint">Pitch {(p.chanW + p.wallT).toFixed(2)} mm · layer height {(p.floorT + p.wallH).toFixed(2)} mm. Wall/floor heights and hole sizes stay live parameters in Fusion; the layout pitch is baked at export.</p>
    </section>
  );
}

export function DifficultyPanel(): JSX.Element {
  const r = S.report.value;
  const m = r.metrics;
  const rows: [string, string | number][] = [
    ['Solution length', m.solutionLength],
    ['Playable cells', m.cells],
    ['Decision points', m.decisions],
    ['Deepest dead end', m.maxDepth],
    ['Dead-end depth total', m.sumDepth],
    ['Decoy depth near goal', m.decoyNearGoal],
    ['Traps (one step off route)', `${m.traps} (${m.trapsOnRoute})`],
    ['Bridges', m.bridges],
    ['Loops', m.loops],
    ['Explorer: steps / cells', r.explorationCost.toFixed(2)],
    ['Explorer: restarts', r.explorer.meanRestarts.toFixed(2)],
  ];
  return (
    <section>
      <h2>Difficulty</h2>
      <div class="score">{r.score.toFixed(0)}<small>/ 100</small></div>
      <div class="bar"><div style={`width:${Math.min(100, r.score)}%`} /></div>
      <table class="metrics"><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
      <div class="btns" style="margin-top:8px">
        <button class={S.showSolution.value ? 'active' : ''} onClick={() => (S.showSolution.value = !S.showSolution.value)}>Solution</button>
        <button class={S.showHeat.value ? 'active' : ''} onClick={() => (S.showHeat.value = !S.showHeat.value)}>Dead-end heat</button>
      </div>
    </section>
  );
}

export function DiagnosticsPanel(): JSX.Element {
  const ds = S.diagnostics.value;
  if (!ds.length) return <section><h2>Checks</h2><div class="diag" style="color:var(--ok)">Solvable, no stuck states, all cells reachable.</div></section>;
  return (
    <section>
      <h2>Checks</h2>
      {ds.map((d, i) => <div key={i} class={`diag ${d.level}`}>{d.message}</div>)}
    </section>
  );
}

function download(name: string, text: string, type = 'text/plain'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function ExportPanel(): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const name = `maze-${S.maze.value.seed}`.replace(/[^a-z0-9_-]+/gi, '_');
  const blocked = S.physIssues.value.some((i) => i.level === 'error') || S.diagnostics.value.some((d) => d.level === 'error');
  const plan = () => buildPlan(S.maze.value, S.topo.value, S.phys.value);
  const copyChunks = async () => {
    const chunks = emitFusionChunks(plan(), { mode: 'replace' });
    await navigator.clipboard.writeText(chunks.map((c) => `# ===== ${c.name} =====\n${c.code}`).join('\n\n'));
  };
  return (
    <section>
      <h2>Export</h2>
      <div class="btns">
        <button class="primary" disabled={blocked} onClick={() => download(`${name}.py`, emitFusionScript(plan(), { mode: 'replace' }), 'text/x-python')}>Fusion script (.py)</button>
        <button disabled={blocked} onClick={copyChunks} title="One idempotent script per layer for the MCP bridge">Copy bridge chunks</button>
        <button onClick={() => download(`${name}.maze.json`, S.saveMazeJson(), 'application/json')}>Save maze (.json)</button>
        <button onClick={() => fileRef.current?.click()}>Load maze…</button>
        <input ref={fileRef} type="file" accept=".json,application/json" style="display:none" onChange={async (e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (!f) return;
          try { S.loadMazeJson(await f.text()); } catch (err) { alert(`Could not load: ${(err as Error).message}`); }
          (e.target as HTMLInputElement).value = '';
        }} />
      </div>
      <p class="hint">Run the .py from Fusion's <b>Utilities → Scripts and Add-Ins</b>, or let Claude push the bridge chunks live. The script creates a component "Maze {S.maze.value.seed}" with user parameters wallT, floorT, wallH, holeDia, bridgeLift.</p>
      {blocked && <div class="diag error">Fix the errors above before exporting.</div>}
    </section>
  );
}
