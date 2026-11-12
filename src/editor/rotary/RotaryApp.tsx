import { useEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import type { JSX } from 'preact';
import * as R from './state';
import { RotaryViewer } from './viewer';
import { appMode } from '../app/store';

const KEY_DIRS: Record<string, [number, number]> = {
  ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
  d: [1, 0], a: [-1, 0], w: [0, 1], s: [0, -1],
};

function RotaryViewport(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let lastStatus = '';
    const viewer = new RotaryViewer(ref.current!, R.rotaryMaze.value, {
      onStatus: (s) => {
        // signals are cheap, but skip no-op updates so the panels do not re-render every frame
        const key = `${s.traps}|${s.position}|${s.turning}|${s.clicks}|${s.wasted}|${Math.floor(s.elapsed * 10)}|${s.phase}|${s.jammed}|${s.demoText}|${s.wrong}`;
        if (key !== lastStatus) { lastStatus = key; R.rotaryStatus.value = s; }
      },
      onEvent: () => undefined,
      onDemoEnd: () => (R.demoIndex.value = -1),
    });
    const stops = [
      effect(() => viewer.setMaze(R.rotaryMaze.value)),
      effect(() => viewer.setSettings(R.rotarySettings.value)),
      effect(() => viewer.playDemo(R.demoIndex.value)),
      effect(() => { const c = R.rotaryCommand.value; if (c) viewer.command(c.cmd); }),
    ];
    const held = new Set<string>();
    const pushKeys = () => {
      let x = 0, y = 0;
      for (const k of held) { const d = KEY_DIRS[k]; if (d) { x += d[0]; y += d[1]; } }
      viewer.setKeyTilt(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
    };
    const inField = (e: KeyboardEvent) => ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName);
    const keydown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || inField(e)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (KEY_DIRS[k]) { e.preventDefault(); held.add(k); pushKeys(); return; }
      if (e.repeat) return;
      if (k === 'q' || k === ',' || k === '[') R.send({ kind: 'turn', delta: -1 });
      else if (k === 'e' || k === '.' || k === ']') R.send({ kind: 'turn', delta: 1 });
      else if (k === 'r') R.send({ kind: 'reset' });
      else if (k === 't' || k === 'f') R.send({ kind: 'top' });
      else if (k === 'Escape') { if (R.demoIndex.value >= 0) R.demoIndex.value = -1; else appMode.value = 'editor'; }
    };
    const keyup = (e: KeyboardEvent) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (held.delete(k)) pushKeys();
    };
    const blur = () => { held.clear(); pushKeys(); };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    return () => {
      stops.forEach((s) => s());
      window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur);
      viewer.dispose();
    };
  }, []);
  const st = R.rotaryStatus.value;
  const demo = R.demoIndex.value >= 0;
  const m = R.rotaryMaze.value;
  let big = '', cls = '';
  if (demo) { big = st?.wrong ? 'WRONG WAY' : (st?.demoText || m.demos[R.demoIndex.value]?.name || 'Demo'); cls = st?.wrong ? 'lost' : ''; }
  else if (st?.phase === 'home') { big = 'Solved, ball is home'; cls = 'won'; }
  else if (st?.phase === 'goal') { big = `GOAL! Turn the dial to ${m.returnPos} and roll back to the start`; cls = 'won'; }
  else if (st?.phase === 'trapped') { big = `TRAPPED! Turn the dial to ${m.returnPos} and roll back to the start`; cls = 'lost'; }
  else if (st?.jammed) { big = 'Dial blocked by the ball'; cls = 'lost'; }
  return (
    <main>
      <div ref={ref} style="position:absolute;inset:0" />
      <div class="hud">{demo ? 'demo playing · Esc stops · right-drag to orbit · scroll to zoom'
        : 'arrows / WASD or left-drag to tilt · Q / E turn the dial · R reset · T top view · right-drag to orbit'}</div>
      {big && <div class={`play-overlay ${cls}`}><div class="big">{big}</div>
        <div class="small">{st ? `dial ${st.position} · ${st.clicks} clicks${st.wasted ? ` (${st.wasted} wasted)` : ''} · ${st.elapsed.toFixed(1)} s` : ''}</div></div>}
    </main>
  );
}

function Header(): JSX.Element {
  const st = R.rotaryStatus.value;
  const m = R.rotaryMaze.value;
  const demo = R.demoIndex.value >= 0;
  return (
    <header>
      <h1>Maze Builder</h1>
      <button onClick={() => (appMode.value = 'editor')} title="Back to the grid maze editor (Esc)">◀ Editor</button>
      <span class="hint">Rotary maze</span>
      <div class="spacer" />
      <button disabled={demo || (st?.position ?? 0) <= 0} onClick={() => R.send({ kind: 'turn', delta: -1 })} title="Turn the dial back one position (Q)">⟲ Dial −</button>
      <span class="dialpos" title="Dial position">{st ? st.position : 0}<small> / {m.nDetent - 1}</small></span>
      <button disabled={demo || (st?.position ?? 0) >= m.nDetent - 1} onClick={() => R.send({ kind: 'turn', delta: 1 })} title="Turn the dial forward one position (E)">Dial + ⟳</button>
      <button disabled={demo} onClick={() => R.send({ kind: 'reset' })} title="Ball back to the start (R)">Reset ball</button>
    </header>
  );
}

function LeftPanel(): JSX.Element {
  const m = R.rotaryMaze.value;
  const file = useRef<HTMLInputElement>(null);
  const hasTraps = m.trench.some((t) => t.kind === 'trap');
  const demo = R.demoIndex.value;
  return (
    <aside>
      <section>
        <h2>Rotary maze</h2>
        <div class="hint"><b>{m.name}</b><br />Ø{(m.outerR * 2).toFixed(0)} mm · {(m.ballR * 2).toFixed(0)} mm ball · {m.nDetent} dial positions of {m.detentDeg}°</div>
        <div class="checks" style="margin-top:8px">
          {R.BUNDLED.map((b) => <button key={b.label} onClick={() => R.loadRotaryJson(b.json)}>{b.label}</button>)}
        </div>
        <div class="btns" style="margin-top:8px">
          <button onClick={() => file.current?.click()}>Load rotary maze (.json)</button>
          <input ref={file} type="file" accept=".json,application/json" style="display:none" onChange={async (e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) R.loadRotaryJson(await f.text());
            (e.target as HTMLInputElement).value = '';
          }} />
        </div>
        {R.rotaryError.value && <div class="diag error">{R.rotaryError.value}</div>}
      </section>
      <section>
        <h2>Play a maze</h2>
        <div class="hint">{m.routes.length > 1 ? 'Each maze has its own entry door, open at one dial position only. Pick one to put the ball at the start with the dial set for it.' : 'One maze. The button puts the ball at the start with the dial where the shortest known solution begins.'}</div>
        <div class="checks">
          {m.routes.map((r) => (
            <button key={r.maze} disabled={demo >= 0} onClick={() => R.send({ kind: 'reset', dial: r.startPos })}>
              Maze {r.maze} · start at dial {r.startPos} · {r.clicks} clicks
            </button>
          ))}
        </div>
        <div class="hint">{hasTraps ? 'The red pits are traps: fall in and the only way out is back to the start. ' : ''}Reach the green cup in the centre, then turn the dial to {m.returnPos} to open the return lane and roll the ball back to the start.</div>
      </section>
      <section>
        <h2>Demos</h2>
        <div class="checks">
          {m.demos.map((d, i) => (
            <button key={d.name} class={demo === i ? 'active' : ''} onClick={() => (R.demoIndex.value = demo === i ? -1 : i)}>{demo === i ? '■ ' : '▶ '}{d.name}</button>
          ))}
        </div>
        {m.demos.length === 0 && <div class="hint">This file has no recorded demos.</div>}
      </section>
    </aside>
  );
}

function RightPanel(): JSX.Element {
  const st = R.rotaryStatus.value;
  const s = R.rotarySettings.value;
  const m = R.rotaryMaze.value;
  const set = (patch: Partial<R.RotarySettings>) => (R.rotarySettings.value = { ...s, ...patch });
  const mark = m.routes.find((r) => r.startPos === st?.position);
  return (
    <aside class="right">
      <section>
        <h2>Status</h2>
        <table class="metrics">
          <tr><td>Dial position</td><td>{st ? `${st.position}${st.turning ? ' …' : ''}` : '-'}</td></tr>
          <tr><td>Here</td><td>{st?.position === m.returnPos ? 'return lane open' : mark && m.routes.length > 1 ? `maze ${mark.maze} door open` : '-'}</td></tr>
          <tr><td>Clicks</td><td>{st?.clicks ?? 0}</td></tr>
          <tr><td>Time</td><td>{st ? `${st.elapsed.toFixed(1)} s` : '-'}</td></tr>
          <tr><td>Ball</td><td>{st?.phase === 'home' ? 'home' : st?.phase === 'goal' ? 'in cup / lane' : st?.phase === 'trapped' ? 'in a trap' : 'in play'}</td></tr>
          {m.trench.some((t) => t.kind === 'trap') && <tr><td>Traps hit</td><td>{st?.traps ?? 0}</td></tr>}
        </table>
      </section>
      <section>
        <h2>Controls</h2>
        <div class="row"><label>Max tilt</label><input type="range" min={2} max={15} step={1} value={s.maxTiltDeg} onInput={(e) => set({ maxTiltDeg: Number((e.target as HTMLInputElement).value) })} /><span class="val">{s.maxTiltDeg}°</span></div>
        <div class="row"><label>Speed</label><input type="range" min={0.25} max={3} step={0.25} value={s.speed} onInput={(e) => set({ speed: Number((e.target as HTMLInputElement).value) })} /><span class="val">{s.speed}×</span></div>
        <label class="check"><input type="checkbox" checked={s.showTilt} onChange={(e) => set({ showTilt: (e.target as HTMLInputElement).checked })} />Show board tilt</label>
        <div class="hint" style="margin-top:8px">
          <kbd>←↑↓→</kbd> / <kbd>WASD</kbd> or left-drag: tilt<br />
          <kbd>Q</kbd> <kbd>E</kbd>: dial back / forward<br />
          <kbd>R</kbd>: ball to start · <kbd>T</kbd>: top view<br />
          The marks on the brass edge show each maze's start position against the pointer at the bottom; the wide mark is the return.
        </div>
      </section>
    </aside>
  );
}

export function RotaryApp(): JSX.Element {
  return (
    <>
      <Header />
      <LeftPanel />
      <RotaryViewport />
      <RightPanel />
    </>
  );
}
