import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import type { JSX } from 'preact';
import * as S from './store';
import { MazeViewer } from '../scene/viewer';
import { DiagnosticsPanel, DifficultyPanel, ExportPanel, GeneratePanel, LayersPanel, PhysicalPanel, Toolbar } from '../ui/panels';

function Viewport(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const viewer = new MazeViewer(el, {
      onSlot: (a, b) => S.clickSlot(a, b),
      onCell: (c) => S.clickCell(c),
      onHover: (t) => (S.hoverInfo.value = t),
    });
    const stop = effect(() => {
      const pickMode = S.tool.value === 'wall' || S.tool.value === 'tunnel' ? 'slot' : 'cell';
      viewer.setState({
        maze: S.maze.value,
        topo: S.topo.value,
        phys: S.phys.value,
        activeLayer: S.activeLayer.value,
        solution: S.showSolution.value ? S.solution.value.path : null,
        heat: S.showHeat.value ? S.report.value.metrics.branchDepthOf : null,
        pickMode,
      });
    });
    const keys = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) S.redo(); else S.undo(); }
      if (e.key === 'f' && !mod && (e.target as HTMLElement).tagName !== 'INPUT') viewer.fit();
      if (e.key === 't' && !mod && (e.target as HTMLElement).tagName !== 'INPUT') viewer.viewTop();
    };
    window.addEventListener('keydown', keys);
    return () => { stop(); window.removeEventListener('keydown', keys); viewer.dispose(); };
  }, []);
  return (
    <main>
      <div ref={ref} style="position:absolute;inset:0" />
      <div class="hud">{S.hoverInfo.value || 'drag to orbit · scroll to zoom · f fit · t top view'}</div>
    </main>
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
        <DifficultyPanel />
        <DiagnosticsPanel />
        <ExportPanel />
      </aside>
    </>
  );
}

render(<App />, document.getElementById('app')!);
