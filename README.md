# Maze Builder

Generator and editor for extremely difficult physical ball mazes — stacked levels, one-way dropouts, dead-end trap
holes and hidden bridge passages — with export to Fusion 360 as native sketches and extrudes driven by user parameters.

## Use
No install needed to run the editor: double-click **`app/MazeBuilder.html`** (one self-contained file, works
offline from disk). Rebuild it after code changes with `npm run app`. Every push to `main` also builds it for GitHub
Pages (enable Pages with source "GitHub Actions" in the repo settings once).

```
npm install
npm run dev            # live-reloading editor at http://localhost:5173 (development)
npm run app            # build the single-file app → app/MazeBuilder.html
npm test               # unit + property tests for the core
npm run check          # typecheck (incl. DOM-free core), lint, tests
npm run export -- --gen 12x12x4 --seed demo --out out/demo   # Fusion scripts from the terminal
```

Editor: pick a tool in the header (Wall, Bridge, Trap, Dropout, Start, Goal, Lock), click walls/cells in the
viewport, `Cmd/Ctrl+Z` undo, `f` fit, `t` top view. "Harder" searches 24 seeds for the highest score;
"Regenerate unlocked" keeps locked cells and rebuilds the rest. Work autosaves in the browser; Save/Load as JSON.

## Shapes
Besides flat boards and stacked layers, the maze can live on a **cylinder** (tube), a **cube**, or a **sphere** (six
cube faces projected onto the sphere; every wall follows a great circle). By default the maze is on the **outer
surface**: the walls are ribs standing out from the shell and the ball rides on the outside, held on by a clear
sleeve or outer shell in the physical build. "Maze on: inner surface" in the Physical panel puts it inside instead
(the tube then gets end caps with an exit hole; the editor shows a cutaway). The nominal size (tube Ø, cube side,
sphere Ø) is measured at the maze surface; the shell is the floor thickness deep on the other side. Traps are holes
through the shell. The Physical panel shows the channel width between walls at the ball for the chosen size and cell
count and refuses sizes the ball cannot pass. Play mode turns the whole object (arrows / WASD / drag) instead of
tilting a board. The View section switches between the 3D shape and the unfolded net, which is easier to edit.

## Layers
Click a layer number to edit it; the other layers turn translucent ("ghost") so you keep the context of the levels
above and below. Each layer's mode can be cycled solid → ghost → hidden in the Layers table, or set for all other
layers at once. Ghosted and hidden layers are not pickable.

## Play (demo mode)
Press `p` or **▶ Play** to roll a real ball through the maze: a rolling-sphere model on a tilting board
(`a = 5/7·g·sinθ`), wall bounces with restitution and slide, rolling resistance, hole lips that tip the ball in.
Bridge walls are passed underneath, dropouts land the ball on the layer below, trap holes lose it (it reappears at the
start). Tilt with the arrow keys / `WASD` or left-drag (relative to the camera); right-drag orbits; `R` resets;
`Esc` stops. **Autopilot** drives the ball along the trap-free shortest route for a hands-off demo; **X-ray** ghosts
the layers above the ball. The same simulation runs headless in `test/sim.test.ts`, where the autopilot must solve
generated mazes and the ball must never cross a wall.

## Fusion 360
"Fusion script (.py)" → Fusion **Utilities → Scripts and Add-Ins → + → pick the file → Run**. It creates user
parameters (`wallT`, `floorT`, `wallH`, `layerH`, `holeDia`, `bridgeLift`, …) and a component `Maze <seed>` with one
body per layer, features grouped per layer in the timeline. Change `wallH`, `wallT`, `floorT` or `holeDia` afterwards
and the model recomputes. The in-plane layout (pitch = `chanW + wallT`) is baked: change ball/channel size in the
editor and export again (the script replaces the component).

With the Fusion MCP bridge, "Copy bridge chunks" gives one idempotent script per layer; each runs in about a second.

Shell shapes export as native features too: a tube (ring extrude, live `tubeDia`/`floorT`), caps with the exit hole,
walls as thin extrudes of radial lines and annular-sector extrudes (live `wallT`); a hollow cube with thin-extruded
walls on each inner face (live `wallT`, `wallH`); a revolved sphere shell with sector walls on great-circle planes.
Trap and goal holes are revolve-cuts along the surface normal. On shells the wall height and hole positions are baked.

See `docs/design.md` (architecture) and `docs/fusion-notes.md` (API findings and pitfalls).
