import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import type { JSX } from 'preact';
import * as S from './store';
import { MazeViewer } from '../scene/viewer';
import { DiagnosticsPanel, DifficultyPanel, ExportPanel, GeneratePanel, LayersPanel, PhysicalPanel, PlayPanel, Toolbar } from '../ui/panels';

const KEY_DIRS: Record<string, [number, number]> = {
  ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
  d: [1, 0], a: [-1, 0], w: [0, 1], s: [0, -1],
};

function Viewport(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const viewer = new MazeViewer(el, {
      onSlot: (a, b) => S.clickSlot(a, b),
      onCell: (c) => S.clickCell(c),
      onHover: (t) => (S.hoverInfo.value = t),
      onPlay: (status, events) => S.reportPlay(status, events),
    });
    const stop = effect(() => {
      const pickMode = S.tool.value === 'wall' || S.tool.value === 'tunnel' ? 'slot' : 'cell';
      viewer.setState({
        maze: S.maze.value,
        topo: S.topo.value,
        phys: S.phys.value,
        activeLayer: S.activeLayer.value,
        layerModes: S.effectiveLayerModes.value,
        solution: S.showSolution.value ? S.solution.value.path : null,
        heat: S.showHeat.value ? S.report.value.metrics.branchDepthOf : null,
        pickMode,
        play: S.play.value,
        resetTick: S.resetTick.value,
      });
    });
    const held = new Set<string>();
    const pushKeys = () => {
      let x = 0, y = 0;
      for (const k of held) { const d = KEY_DIRS[k]; if (d) { x += d[0]; y += d[1]; } }
      viewer.setKeyTilt(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
    };
    const inField = (e: KeyboardEvent) => ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName);
    const keydown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) S.redo(); else S.undo(); return; }
      if (mod || inField(e)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (S.play.value) {
        if (KEY_DIRS[k]) { e.preventDefault(); held.add(k); pushKeys(); return; }
        if (k === 'r') { S.resetBall(); return; }
        if (k === 'f') { viewer.reframe(); return; }
        if (k === 'Escape') { S.stopPlay(); return; }
      }
      if (k === 'p') { if (S.play.value) S.stopPlay(); else S.startPlay(); return; }
      if (k === 'f') viewer.reframe();
      if (k === 't') viewer.viewTop();
    };
    const keyup = (e: KeyboardEvent) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (held.delete(k)) pushKeys();
    };
    const blur = () => { held.clear(); pushKeys(); };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    return () => { stop(); window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); viewer.dispose(); };
  }, []);
  const playing = S.play.value;
  const hud = playing
    ? (playing.autopilot ? 'autopilot is driving · R reset · Esc stop · right-drag to orbit' : 'arrows / WASD or left-drag to tilt · R reset · Esc stop · right-drag to orbit')
    : (S.hoverInfo.value || 'drag to orbit · scroll to zoom · f fit · t top view · p play');
  return (
    <main>
      <div ref={ref} style="position:absolute;inset:0" />
      <div class="hud">{hud}</div>
      {playing && <PlayOverlay />}
    </main>
  );
}

function PlayOverlay(): JSX.Element {
  const st = S.playStatus.value;
  const phase = st?.phase ?? 'rolling';
  const label = phase === 'won' ? 'GOAL!' : phase === 'lost' ? 'Lost in a trap' : phase === 'falling' ? 'Falling…' : `Layer ${st?.layer ?? '-'}`;
  return (
    <div class={`play-overlay ${phase}`}>
      <div class="big">{label}</div>
      <div class="small">{st ? `${st.elapsed.toFixed(1)} s · ${st.drops} drops · ${st.traps} traps` : ''}</div>
    </div>
  );
}

function App(): JSX.Element {
  return (
    <>
      <Toolbar />
      <aside>
        <GeneratePanel />
        <LayersPanel />
        <PhysicalPanel />
      </aside>
      <Viewport />
      <aside class="right">
        <PlayPanel />
        <DifficultyPanel />
        <DiagnosticsPanel />
        <ExportPanel />
      </aside>
    </>
  );
}

render(<App />, document.getElementById('app')!);
