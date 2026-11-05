# Maze Builder

Generator and editor for extremely difficult 3D ball mazes (stacked levels, one-way dropouts, hidden tunnels), with parametric export to Fusion 360.

- `npm run dev` — interactive editor (browser)
- `npm test` — unit + property tests for the pure core
- `npm run export -- file.maze.json --out maze.py` — emit a Fusion 360 Python script

See `docs/design.md` for architecture and `docs/fusion-notes.md` for Fusion API findings.
