import { useEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import type { JSX } from 'preact';
import * as L from './state';
import { LockBoxViewer } from './viewer';
import { LOCKBOX_DEMOS } from '@core/lockbox/autopilot';
import { appMode } from '../app/store';

const KEY_DIRS: Record<string, [number, number]> = {
  ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
  d: [1, 0], a: [-1, 0], w: [0, 1], s: [0, -1],
};
/** Cap turn keys: Q turns counter-clockwise (unlocks), E clockwise (locks). */
const KEY_TURN: Record<string, number> = { q: 1, ',': 1, '[': 1, e: -1, '.': -1, ']': -1 };

function LockBoxViewport(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let lastStatus = '';
    const viewer = new LockBoxViewer(ref.current!, L.lockBox.value, {
      onStatus: (s) => {
        const key = `${s.phase}|${Math.round(s.capA)}|${s.ringA.toFixed(1)}|${s.locked}|${s.lidZ.toFixed(0)}|${s.open}|${s.atStop}|${s.refused}|${Math.floor(s.elapsed * 10)}|${s.demoText}`;
        if (key !== lastStatus) { lastStatus = key; L.lockBoxStatus.value = s; }
      },
      onEvent: () => undefined,
      onDemoEnd: () => (L.lockBoxDemo.value = null),
    });
    const held = new Set<string>();
    const push = () => {
      let x = 0, y = 0, t = L.buttonTurn.value;
      for (const k of held) { const d = KEY_DIRS[k]; if (d) { x += d[0]; y += d[1]; } t += KEY_TURN[k] ?? 0; }
      viewer.setKeyTilt(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
      viewer.setTurn(Math.max(-1, Math.min(1, t)));
    };
    const stops = [
      effect(() => viewer.setBox(L.lockBox.value)),
      effect(() => viewer.setSettings(L.lockBoxSettings.value)),
      effect(() => viewer.playDemo(L.lockBoxDemo.value)),
      effect(() => { const c = L.lockBoxCommand.value; if (c) viewer.command(c.cmd); }),
      effect(() => { void L.buttonTurn.value; push(); }),
    ];
    const inField = (e: KeyboardEvent) => ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName);
    const keydown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || inField(e)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (KEY_DIRS[k] || KEY_TURN[k]) { e.preventDefault(); held.add(k); push(); return; }
      if (e.repeat) return;
      if (k === 'l' || k === ' ') { e.preventDefault(); L.send({ kind: 'lift' }); }
      else if (k === 'r') L.send({ kind: 'resetBall' });
      else if (k === 't') L.send({ kind: 'view', view: 'top' });
      else if (k === 'f') L.send({ kind: 'view', view: 'side' });
      else if (k === 'Escape') { if (L.lockBoxDemo.value) L.lockBoxDemo.value = null; else appMode.value = 'editor'; }
    };
    const keyup = (e: KeyboardEvent) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (held.delete(k)) push();
    };
    const blur = () => { held.clear(); L.buttonTurn.value = 0; push(); };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    return () => {
      stops.forEach((s) => s());
      window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur);
      viewer.dispose();
    };
  }, []);
  const st = L.lockBoxStatus.value;
  const demo = L.lockBoxDemo.value !== null;
  let big = '', cls = '';
  if (demo) { big = st?.demoText || 'Demo'; cls = st?.open ? 'won' : st?.refused ? 'lost' : ''; }
  else if (st?.open) { big = 'OPEN'; cls = 'won'; }
  else if (st?.refused) { big = 'Locked: the lid will not lift'; cls = 'lost'; }
  else if (st?.phase === 'clutch' && !st.locked) { big = 'Unlocked. Lift the lid (L)'; cls = 'won'; }
  else if (st?.phase === 'clutch') { big = 'Click! The cap now turns the lock ring. Turn counter-clockwise (Q)'; cls = 'won'; }
  else if (st?.phase === 'riding') { big = 'In the goal. Turn the cap (Q / E) until the ball drops into the ring'; }
  return (
    <main>
      <div ref={ref} style="position:absolute;inset:0" />
      <div class="hud">{demo ? 'demo playing · Esc stops · right-drag to orbit · scroll to zoom'
        : 'arrows / WASD or left-drag to tilt · hold Q / E to turn the cap · L lift · R ball to start · T top view · F side view · right-drag to orbit'}</div>
      {big && <div class={`play-overlay ${cls}`}><div class="big">{big}</div>
        <div class="small">{st ? `ring ${st.ringA.toFixed(0)}° of ${L.lockBox.value.openTurn}° · ${st.elapsed.toFixed(1)} s` : ''}</div></div>}
    </main>
  );
}

/** Button that acts while it is held down. */
function HoldButton(props: { readonly turn: number; readonly disabled: boolean; readonly title: string; readonly children: string }): JSX.Element {
  const off = () => { if (L.buttonTurn.value === props.turn) L.buttonTurn.value = 0; };
  return (
    <button disabled={props.disabled} title={props.title}
      onPointerDown={() => (L.buttonTurn.value = props.turn)} onPointerUp={off} onPointerLeave={off} onPointerCancel={off}>{props.children}</button>
  );
}

function Header(): JSX.Element {
  const st = L.lockBoxStatus.value;
  const demo = L.lockBoxDemo.value !== null;
  const up = (st?.lidZ ?? 0) > 0;
  return (
    <header>
      <h1>Maze Builder</h1>
      <button onClick={() => (appMode.value = 'editor')} title="Back to the grid maze editor (Esc)">◀ Editor</button>
      <span class="hint">Lock box</span>
      <div class="spacer" />
      <HoldButton turn={1} disabled={demo || up} title="Hold to turn the cap counter-clockwise: the unlocking direction (Q)">⟲ Cap</HoldButton>
      <span class="dialpos" title="Lock ring angle: 0 = locked stop">{st ? st.ringA.toFixed(0) : 0}°<small> {st?.locked === false ? 'free' : 'locked'}</small></span>
      <HoldButton turn={-1} disabled={demo || up} title="Hold to turn the cap clockwise: the locking direction (E)">Cap ⟳</HoldButton>
      <button disabled={demo} onClick={() => L.send({ kind: 'lift' })} title="Pull the lid up, or put it back (L)">{up ? 'Lower lid' : 'Lift lid'}</button>
      <button disabled={demo} onClick={() => L.send({ kind: 'resetBall' })} title="Pick the ball out and put it on the start (R)">Ball to start</button>
      <button disabled={demo} onClick={() => L.send({ kind: 'resetAll' })} title="Locked box, ball on the start">Reset box</button>
    </header>
  );
}

function LeftPanel(): JSX.Element {
  const b = L.lockBox.value;
  const file = useRef<HTMLInputElement>(null);
  const demo = L.lockBoxDemo.value;
  return (
    <aside>
      <section>
        <h2>Lock box</h2>
        <div class="hint"><b>{b.name}</b><br />Ø{(b.outerR * 2).toFixed(0)} mm · {(b.ballR * 2).toFixed(0)} mm ball · {b.pockets} ring pockets · {b.openTurn}° to unlock</div>
        <div class="btns" style="margin-top:8px">
          <button onClick={() => file.current?.click()}>Load lock box (.json)</button>
          <input ref={file} type="file" accept=".json,application/json" style="display:none" onChange={async (e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) L.loadLockBoxJson(await f.text());
            (e.target as HTMLInputElement).value = '';
          }} />
        </div>
        {L.lockBoxError.value && <div class="diag error">{L.lockBoxError.value}</div>}
      </section>
      <section>
        <h2>How it works</h2>
        <div class="hint">
          The white maze cap spins freely on a hidden brass lock ring. The ring's three yellow tabs sit under three
          orange lugs in the body, so the lid cannot lift.<br /><br />
          1. Roll the ball from the orange mark to the teal goal hole.<br />
          2. It drops through the cap floor onto the ring. Turn the cap until it clicks into a pocket.<br />
          3. The ball now keys cap to ring. Turn counter-clockwise to the stop.<br />
          4. Lift the lid.<br /><br />
          Without the ball in the goal the cap only spins.
        </div>
      </section>
      <section>
        <h2>Demos</h2>
        <div class="checks">
          {LOCKBOX_DEMOS.map((d) => (
            <button key={d.kind} class={demo === d.kind ? 'active' : ''} onClick={() => (L.lockBoxDemo.value = demo === d.kind ? null : d.kind)}>{demo === d.kind ? '■ ' : '▶ '}{d.name}</button>
          ))}
        </div>
      </section>
    </aside>
  );
}

function RightPanel(): JSX.Element {
  const st = L.lockBoxStatus.value;
  const s = L.lockBoxSettings.value;
  const set = (patch: Partial<L.LockBoxSettings>) => (L.lockBoxSettings.value = { ...s, ...patch });
  const check = (label: string, key: 'showTilt' | 'seeThroughBody' | 'seeThroughCap') => (
    <label class="check"><input type="checkbox" checked={s[key]} onChange={(e) => set({ [key]: (e.target as HTMLInputElement).checked })} />{label}</label>
  );
  return (
    <aside class="right">
      <section>
        <h2>Status</h2>
        <table class="metrics">
          <tr><td>Ball</td><td>{st?.phase === 'clutch' ? 'in a ring pocket (clutch)' : st?.phase === 'riding' ? 'in the goal, on the ring' : 'in the maze'}</td></tr>
          <tr><td>Cap</td><td>{st ? `${(((st.capA % 360) + 360) % 360).toFixed(0)}°` : '-'}</td></tr>
          <tr><td>Lock ring</td><td>{st ? `${st.ringA.toFixed(1)}°${st.atStop ? ' (stop)' : ''}` : '-'}</td></tr>
          <tr><td>Bayonet</td><td>{st ? (st.locked ? 'locked' : 'free') : '-'}</td></tr>
          <tr><td>Lid</td><td>{st?.open ? 'off' : 'on'}</td></tr>
          <tr><td>Time</td><td>{st ? `${st.elapsed.toFixed(1)} s` : '-'}</td></tr>
        </table>
      </section>
      <section>
        <h2>View</h2>
        {check('See-through body', 'seeThroughBody')}
        {check('See-through maze cap', 'seeThroughCap')}
        {check('Show box tilt', 'showTilt')}
        <div class="btns" style="margin-top:8px">
          <button onClick={() => L.send({ kind: 'view', view: 'top' })}>Top (T)</button>
          <button onClick={() => L.send({ kind: 'view', view: 'side' })}>Side (F)</button>
        </div>
      </section>
      <section>
        <h2>Controls</h2>
        <div class="row"><label>Max tilt</label><input type="range" min={2} max={15} step={1} value={s.maxTiltDeg} onInput={(e) => set({ maxTiltDeg: Number((e.target as HTMLInputElement).value) })} /><span class="val">{s.maxTiltDeg}°</span></div>
        <div class="row"><label>Speed</label><input type="range" min={0.25} max={3} step={0.25} value={s.speed} onInput={(e) => set({ speed: Number((e.target as HTMLInputElement).value) })} /><span class="val">{s.speed}×</span></div>
        <div class="hint" style="margin-top:8px">
          <kbd>←↑↓→</kbd> / <kbd>WASD</kbd> or left-drag: tilt (relative to the screen)<br />
          hold <kbd>Q</kbd> / <kbd>E</kbd>: turn the cap<br />
          <kbd>L</kbd> or <kbd>Space</kbd>: lift / lower the lid<br />
          <kbd>R</kbd>: ball to start
        </div>
      </section>
    </aside>
  );
}

export function LockBoxApp(): JSX.Element {
  return (
    <>
      <Header />
      <LeftPanel />
      <LockBoxViewport />
      <RightPanel />
    </>
  );
}
