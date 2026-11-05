# Maze Builder

Generator and editor for extremely difficult physical ball mazes — stacked levels, one-way dropouts, dead-end trap
holes and hidden bridge passages — with export to Fusion 360 as native sketches and extrudes driven by user parameters.

## Use
```
npm install
npm run dev            # editor at http://localhost:5173
npm test               # unit + property tests for the core
npm run check          # typecheck (incl. DOM-free core), lint, tests
npm run export -- --gen 12x12x4 --seed demo --out out/demo   # Fusion scripts from the terminal
```

Editor: pick a tool in the header (Wall, Bridge, Trap, Dropout, Start, Goal, Lock), click walls/cells in the
viewport, `Cmd/Ctrl+Z` undo, `f` fit, `t` top view. "Harder" searches 24 seeds for the highest score;
"Regenerate unlocked" keeps locked cells and rebuilds the rest. Work autosaves in the browser; Save/Load as JSON.

## Fusion 360
"Fusion script (.py)" → Fusion **Utilities → Scripts and Add-Ins → + → pick the file → Run**. It creates user
parameters (`wallT`, `floorT`, `wallH`, `layerH`, `holeDia`, `bridgeLift`, …) and a component `Maze <seed>` with one
body per layer, features grouped per layer in the timeline. Change `wallH`, `wallT`, `floorT` or `holeDia` afterwards
and the model recomputes. The in-plane layout (pitch = `chanW + wallT`) is baked: change ball/channel size in the
editor and export again (the script replaces the component).

With the Fusion MCP bridge, "Copy bridge chunks" gives one idempotent script per layer; each runs in about a second.

See `docs/design.md` (architecture) and `docs/fusion-notes.md` (API findings and pitfalls).
