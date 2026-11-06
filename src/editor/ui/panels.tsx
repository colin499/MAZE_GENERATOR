import { useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import * as S from '../app/store';
import type { Tool } from '../app/store';
import { emitFusionChunks, emitFusionScript } from '@core/export/fusion/emit';
import { buildPlan } from '@core/layout/planner';
import type { PhysicalParams } from '@core/layout/physical';
import type { GenParams } from '@core/generate/params';
import { shellChannel } from '@core/layout/physical';

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
      <button class={S.play.value ? 'active' : ''} onClick={() => (S.play.value ? S.stopPlay() : S.startPlay())} title="Play mode (p)">{S.play.value ? '■ Stop' : '▶ Play'}</button>
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
        <select value={s.kind} onChange={(e) => S.updateSettings({ kind: (e.target as HTMLSelectElement).value as S.ShapeKind })}>
          <option value="stacked">Stacked layers</option>
          <option value="flat">Flat board</option>
          <option value="cylinder">Cylinder (inside a tube)</option>
          <option value="cube">Cube (inside a hollow cube)</option>
          <option value="sphere">Sphere (inside a hollow sphere)</option>
        </select>
      </div>
      {(s.kind === 'flat' || s.kind === 'stacked') && <>
        <Num label="Columns" value={s.w} min={2} max={60} onChange={(w) => S.updateSettings({ w: Math.max(2, Math.round(w)) })} />
        <Num label="Rows" value={s.h} min={2} max={60} onChange={(h) => S.updateSettings({ h: Math.max(2, Math.round(h)) })} />
      </>}
      {s.kind === 'stacked' && <Num label="Layers" value={s.layers} min={2} max={12} onChange={(l) => S.updateSettings({ layers: Math.max(2, Math.round(l)) })} />}
      {s.kind === 'cylinder' && <>
        <Num label="Cells around" value={s.around} min={3} max={40} onChange={(v) => S.updateSettings({ around: Math.max(3, Math.round(v)) })} />
        <Num label="Cells along" value={s.along} min={2} max={80} onChange={(v) => S.updateSettings({ along: Math.max(2, Math.round(v)) })} />
      </>}
      {(s.kind === 'cube' || s.kind === 'sphere') && <Num label="Cells per face" value={s.n} min={2} max={14} onChange={(v) => S.updateSettings({ n: Math.max(2, Math.round(v)) })} />}
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

const MODE_LABEL: Record<S.LayerMode, string> = { solid: 'solid', ghost: 'ghost', hidden: 'hidden' };
const MODE_NEXT: Record<S.LayerMode, S.LayerMode> = { solid: 'ghost', ghost: 'hidden', hidden: 'solid' };

export function LayersPanel(): JSX.Element {
  const t = S.topo.value;
  const layers = Array.from({ length: t.layerCount }, (_, i) => i);
  const active = S.activeLayer.value;
  const modes = S.effectiveLayerModes.value;
  const playing = !!S.play.value;
  if (S.isShellMaze.value) {
    return (
      <section class="layers">
        <h2>View</h2>
        <div class="btns">
          <button class={!S.unfolded.value ? 'active' : ''} onClick={() => (S.unfolded.value = false)} title="The real shape">3D</button>
          <button class={S.unfolded.value ? 'active' : ''} onClick={() => (S.unfolded.value = true)} disabled={playing} title="Flattened net of the surface, easier to edit">Unfolded</button>
          <button class={S.cutaway.value ? 'active' : ''} onClick={() => (S.cutaway.value = !S.cutaway.value)} title="Hide the half nearest the camera so you can see inside">Cutaway</button>
        </div>
        <p class="hint">{t.spec.kind === 'cylinder' ? 'The maze is on the inside of the tube; the ball enters at one end and must reach the other.' : 'The maze is on the inside of the shell; the ball sits on the inner surface and you turn the whole object. Faces are numbered 0–5.'} The cutaway shows the far half from inside.</p>
        <div class="row" style="margin-top:6px">
          <label>Locked cells</label>
          <span>{S.maze.value.locked.size}</span>
          {S.maze.value.locked.size > 0 && <button onClick={S.clearLocks}>Clear</button>}
        </div>
      </section>
    );
  }
  return (
    <section class="layers">
      <h2>Layers</h2>
      <div class="btns">
        <button class={active < 0 ? 'active' : ''} onClick={S.showAllLayers} title="Edit any layer, all solid">All</button>
        {layers.slice().reverse().map((k) => (
          <button key={k} class={active === k ? 'active' : ''} onClick={() => S.focusLayer(k)} title={`Edit layer ${k}; other layers become translucent`}>{k === t.layerCount - 1 && t.layerCount > 1 ? `${k} (top)` : k}</button>
        ))}
      </div>
      {t.layerCount > 1 && (
        <table class="layer-table"><tbody>
          {layers.slice().reverse().map((k) => (
            <tr key={k} class={active === k ? 'active' : ''}>
              <td>Layer {k}{k === t.layerCount - 1 ? ' (top)' : k === 0 ? ' (bottom)' : ''}</td>
              <td>
                <button class={`mode ${modes[k]}`} disabled={active === k || playing} onClick={() => S.setLayerMode(k, MODE_NEXT[modes[k] ?? 'solid'])} title="Click to cycle solid → ghost → hidden">{active === k ? 'editing' : MODE_LABEL[modes[k] ?? 'solid']}</button>
              </td>
            </tr>
          ))}
        </tbody></table>
      )}
      {t.layerCount > 1 && (
        <div class="row">
          <label>Other layers</label>
          <div class="btns">
            {(['solid', 'ghost', 'hidden'] as const).map((m) => <button key={m} disabled={playing} onClick={() => S.setOtherLayers(m)}>{m}</button>)}
          </div>
        </div>
      )}
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
      {playing && <p class="hint">While playing, layers above the ball are ghosted automatically (X-ray).</p>}
    </section>
  );
}

export function PlayPanel(): JSX.Element {
  const playing = !!S.play.value;
  const p = S.playPrefs.value;
  const st = S.playStatus.value;
  const blocked = !S.solution.value.solvable;
  const Check = ({ label, k }: { label: string; k: 'autopilot' | 'follow' | 'xray' }) => (
    <label class="check"><input type="checkbox" checked={p[k]} onChange={(e) => S.updatePlay({ [k]: (e.target as HTMLInputElement).checked } as Partial<S.PlaySettings>)} /> {label}</label>
  );
  return (
    <section class="play">
      <h2>Play</h2>
      <div class="btns">
        {playing
          ? <button class="primary" onClick={S.stopPlay}>Stop</button>
          : <button class="primary" onClick={S.startPlay} disabled={blocked} title="Roll a real ball through the maze (p)">▶ Play</button>}
        <button onClick={S.resetBall} disabled={!playing} title="Put the ball back at the start (R)">Reset ball</button>
      </div>
      <div class="checks">
        <Check label="Autopilot (demo run along the solution)" k="autopilot" />
        <Check label="Camera follows the ball" k="follow" />
        {!S.isShellMaze.value && <Check label="X-ray layers above the ball" k="xray" />}
      </div>
      <div class="row">
        <label>Camera</label>
        <select value={p.view} onChange={(e) => S.updatePlay({ view: (e.target as HTMLSelectElement).value as S.PlaySettings['view'] })}>
          <option value="ball">Above the ball</option>
          <option value="maze">Whole maze from above</option>
          <option value="free">Free (orbit)</option>
        </select>
      </div>
      {p.view === 'ball' && <Range label="Cells in view" value={p.zoomCells} min={4} max={30} step={1} onChange={(v) => S.updatePlay({ zoomCells: v })} />}
      {S.isShellMaze.value
        ? <Range label="Turn speed" value={p.turnDegPerS} min={15} max={180} step={5} onChange={(v) => S.updatePlay({ turnDegPerS: v })} fmt={(v) => `${v}°/s`} />
        : <Range label="Max tilt" value={p.maxTiltDeg} min={2} max={15} step={0.5} onChange={(v) => S.updatePlay({ maxTiltDeg: v })} fmt={(v) => `${v}°`} />}
      <Range label="Sim speed" value={p.speed} min={0.25} max={2} step={0.25} onChange={(v) => S.updatePlay({ speed: v })} fmt={(v) => `${v}×`} />
      {st && (
        <table class="metrics"><tbody>
          <tr><td>State</td><td>{st.phase}</td></tr>
          <tr><td>Layer</td><td>{st.layer}</td></tr>
          <tr><td>Time</td><td>{st.elapsed.toFixed(1)} s</td></tr>
          {S.isShellMaze.value
            ? <tr><td>Floor slope under ball</td><td>{(st.tiltX * 180 / Math.PI).toFixed(1)}°</td></tr>
            : <tr><td>Tilt x / y</td><td>{(st.tiltX * 180 / Math.PI).toFixed(1)}° / {(st.tiltY * 180 / Math.PI).toFixed(1)}°</td></tr>}
          <tr><td>Dropouts taken</td><td>{st.drops}</td></tr>
          <tr><td>Traps hit</td><td>{st.traps}</td></tr>
        </tbody></table>
      )}
      {S.playLog.value.length > 0 && <div class="log">{S.playLog.value.map((l, i) => <div key={i}>{l}</div>)}</div>}
      <p class="hint">Real rolling-ball physics on a tilting board: gravity {`(5/7 g·sinθ)`}, wall bounces, rolling resistance, hole lips. Bridges are passed underneath; dropouts land on the layer below; traps lose the ball. Tilt with <kbd>←↑↓→</kbd> / <kbd>WASD</kbd> or left-drag; right-drag orbits; <kbd>f</kbd> re-frames.</p>
      {blocked && !playing && <div class="diag error">The maze is unsolvable; fix it before playing.</div>}
    </section>
  );
}

export function PhysicalPanel(): JSX.Element {
  const p = S.phys.value;
  const kind = S.maze.value.topology.kind;
  const ch = shellChannel(p, S.maze.value.topology);
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
      {kind === 'cylinder' && f('tubeDia', 'Tube inner Ø')}
      {kind === 'cube' && f('cubeSide', 'Cube inner side')}
      {kind === 'sphere' && f('sphereDia', 'Sphere inner Ø')}
      {S.physIssues.value.map((i, n) => <div key={n} class={`diag ${i.level}`}>{i.message}</div>)}
      {ch
        ? <p class="hint">Channel between walls at the ball: {ch.min.toFixed(1)}{ch.max - ch.min > 0.05 ? `–${ch.max.toFixed(1)}` : ''} mm ({ch.what}). The shell thickness is the floor thickness; walls are ribs on the inside.</p>
        : <p class="hint">Pitch {(p.chanW + p.wallT).toFixed(2)} mm · layer height {(p.floorT + p.wallH).toFixed(2)} mm. Wall/floor heights and hole sizes stay live parameters in Fusion; the layout pitch is baked at export.</p>}
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
