# Fusion 360 API findings (spikes, 2026-11-05)

All run live through the `fusion360` MCP bridge (`execute_code`) in a throwaway document.
Fusion's API is **cm-internal**: every Point3D / radius / distance passed as a number is cm.
String expressions (`ValueInput.createByString('wallT')`) carry their own units.

## Bridge behaviour (critical)
- Hard **30 s timeout per `execute_code` call**. A call that exceeds it loses its result AND the bridge
  **retries the command** (observed: one timed-out script built its layer three times).
  → Every export chunk must finish in a few seconds and must be **idempotent** (skip if the body it would
  create already exists). Write progress to a log file from inside the script when timing anything long.
- `app`, `ui`, `design`, `adsk` are predefined; after `app.documents.add(...)` re-fetch
  `adsk.fusion.Design.cast(app.activeProduct)`.

## Parameters
- `design.userParameters.add(name, ValueInput.createByString('ballDia + 2 mm'), 'mm', '')` works;
  update via `param.expression = '...'`. Cross references between user params are fine.

## Sketch performance
- `sketchLines.addByTwoPoints` with `sketch.isComputeDeferred = True` and `areProfilesShown = False`:
  **60 lines in 0.036 s**, even when they cross each other.
- `sketchLines.addTwoPointRectangle` for overlapping wall rectangles: **207 rectangles took 106 s**.
  Do not use rectangles for walls.

## Walls: thin extrude of centre-lines (chosen strategy)
- `ExtrudeFeatures.createInput(profile, op)` **rejects** a SketchLine or an ObjectCollection of SketchLines
  ("invalid profile(s)").
- It **accepts** `adsk.fusion.Path.create(line, ChainedCurveOptions.noChainedCurves)` and an
  **ObjectCollection of such Paths** (one Path per wall run).
  `input.setThinExtrude(ThinExtrudeWallLocation.Center, ValueInput.createByString('wallT'))`.
- Result: touching/overlapping runs are unioned into one body; runs meeting end-to-end get a full
  mitred corner (L = exactly 4·t·h), T and + junctions union cleanly. Wall thickness stays parametric.
- A Path created from many curves with `connectedChainedCurves` only keeps the first chain → always one Path per run.

## Start offsets, planes, holes
- `input.startExtent = OffsetStartDefinition.create(ValueInput.createByString('floorT'))` works
  (walls start on top of the floor). Combine with `setDistanceExtent(False, 'wallH')` and `participantBodies`.
- Construction plane: `planes.createInput(); setByOffset(root.xYConstructionPlane, ValueInput.createByString('layerH * 1'))`
  → parametric layer stack-up.
- All sketch points via `sketch.modelToSketchSpace(Point3D)` → independent of sketch axis orientation.
  Verified exact round trip on an offset plane and on a cube face sketch (`sketches.add(face)`).
- `HoleFeature` from sketch points on the offset plane with `setDistanceExtent('floorT')`: with the default
  direction it cuts **nothing** (points away from the body). Set `holeInput.isDefaultDirection = False`
  → cuts exactly π(holeDia/2)²·floorT. Fallback also verified: sketch circle + `addDiameterDimension` with
  `dim.parameter.expression = 'holeDia'` + cut extrude.
- Face selection on a solid: iterate `body.faces`, `face.evaluator.getNormalAtPoint(face.pointOnFace)`.

## Temporary BRep (not used for walls, kept as an option)
- `TemporaryBRepManager.createBox` ×200 + union: 0.2 s; add via `baseFeatures` in a parametric design.
  Fast but non-parametric; could serve a "fast preview" or a mesh-like export later.

## Benchmark: realistic 20×20 layer (perfect maze, 178 merged wall runs)
floor extrude 0.01 s · 178 lines 0.05 s · Paths 0.00 s · thin extrude (join, start offset floorT) 0.55 s · **total 0.61 s**.
Resulting body: 1, 597 faces. One `execute_code` chunk per layer is comfortably inside the 30 s limit.

## Building inside a sub-component (export run, 2026-11-05)
- `sketch.areProfilesShown = False` also skips **computing** profiles → closed-polygon extrudes fail with
  "invalid profile(s)". Only hide profiles on centre-line sketches (thin extrude).
- `Path.create(sketchLine, ...)` fails with `InternalValidationError: Utils::getObjectPath(sketchCurve ...)` when the
  sketch lives in a sub-component created via `occurrences.addNewComponent`. Passing the proxy
  `sketchLine.createForAssemblyContext(occurrence)` works. Activating the occurrence does not help.
- Thin-extruded runs end flat at their centre-line endpoints, which leaves a notch at outer corners and L
  junctions when joined to an existing body. The planner extends every run by wallT/2 at both ends; a free end
  then stops flush with the neighbouring channel (still exactly chanW wide) and all corners are square.

## Shell shapes (cylinder / cube / sphere), 2026-11-06
- Parametric designs refuse `setByThreePoints` with raw Point3D and `ConstructionPointInput.setByPoint(Point3D)`
  ("Environment is not supported"). Usable planes: offsets of base planes, and `setByAngle(axis, angle, basePlane)`.
- Base plane normals: XY → +z, XZ → +y, YZ → +x. `setByAngle(zAxis, 30°, XZ)` rotates the base normal right-handed
  about the axis: normal (−0.5, 0.866, 0). A plane turned 180° then offset by −d sits at +d with an inward normal;
  a thin extrude on it goes inward (verified: z 20 → 10 mm).
- Three-point arcs (`sketchArcs.addByThreePoints`) + two lines make a sector profile; `setSymmetricExtent(t, True)`
  extrudes it to exactly the expected volume.
- Circles with `addDiameterDimension` + `parameter.expression = 'tubeDia + 2 * floorT'` keep shell diameters live;
  pick the annulus profile by area (`profile.areaProperties().area`).
- Revolve fails when the profile crosses the axis ("ASM_WIRE_X_AXIS"): revolve a half profile whose edge is the axis.
- **Process rule**: `execute_code` runs in whatever document is active, which follows the user's tabs. Activate the
  marked scratch document and assert the marker in the same call as the build (see `scripts/` runner pattern).
