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

## Rotary maze mode

The **Rotary maze** button in the toolbar (or opening the app with `#rotary` on the URL) switches to a player for
dial-type ball mazes: a fixed top with walls and a dial underneath whose shutters rise through the floor.

- Tilt with the arrow keys / WASD or by left-dragging; turn the dial with `Q` / `E` or the header buttons;
  `R` puts the ball back at the start, `T` returns to the top view, `Esc` stops a demo or goes back to the editor.
- The three-path maze from the `ROTARY_BALL_MAZE` project is bundled (`src/core/rotary/sampleThreePath.ts`).
  Other mazes load from a `rotary-maze/1` JSON file, written by `maze_v2_threepath/export_app.py` in that project.
- Recorded demos in the file (solutions and wrong turns) play back from the left panel.
- Code: `src/core/rotary/` (model, physics, demo playback; DOM-free) and `src/editor/rotary/` (three.js view and UI).
  `test/rotary.test.ts` steers the simulated ball through all three solutions; `node scripts/smoke-rotary.mjs`
  checks the built app.

## Lock box mode

The **Lock box** button in the toolbar (or `#lockbox` on the URL) plays the maze lock box from the `MAZE_LOCK_BOX`
project: a cylindrical box whose maze cap spins freely on a hidden bayonet lock ring until the ball drops through the
goal hole into a ring pocket and keys the two together.

- Tilt with the arrow keys / WASD or by left-dragging (relative to the screen); hold `Q` / `E` to turn the cap
  (`Q` = counter-clockwise = unlock); `L` or Space lifts / lowers the lid; `R` puts the ball back on the start;
  `T` / `F` top and side views; `Esc` stops a demo or goes back to the editor.
- "See-through body" shows the ring's tabs under the body's lugs; "See-through maze cap" shows the ring pockets.
- Two demos: the autopilot solving and opening the box, and a cheat attempt (spin and pull with no ball in the goal).
- The v1 box is bundled (`src/core/lockbox/sampleV1.ts`). Other boxes load from a `lock-box/1` JSON file written by
  `lockbox_cells.py --app OUT.json` in that project.
- Code: `src/core/lockbox/` (model, physics, autopilot; DOM-free) and `src/editor/lockbox/` (three.js view and UI).
  `test/lockbox.test.ts` covers the lock logic; `node scripts/smoke-lockbox.mjs` checks the built app.
