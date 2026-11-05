/**
 * Fixed Python interpreter for BuildPlans, executed inside Fusion 360.
 * Everything geometric lives in the PLAN dict; this code never changes per topology.
 * Numbers in PLAN are millimetres; the Fusion API is centimetre based, hence MM below.
 */
export const PY_INTERPRETER = String.raw`
import adsk.core, adsk.fusion, traceback, json, time

MM = 0.1  # mm -> cm

def _vi(expr):
    return adsk.core.ValueInput.createByString(expr)

def _p3(pt):
    return adsk.core.Point3D.create(pt[0] * MM, pt[1] * MM, pt[2] * MM)

def ensure_params(design, params):
    ups = design.userParameters
    for p in params:
        existing = ups.itemByName(p['name'])
        if existing is None:
            ups.add(p['name'], _vi(p['expr']), 'mm', p.get('comment', ''))
        elif UPDATE_PARAMS:
            existing.expression = p['expr']
            if p.get('comment'):
                existing.comment = p['comment']

OCC = None  # occurrence of the maze component; sketch curves need its context for Path.create

def get_component(design, name, mode):
    global OCC
    root = design.rootComponent
    for occ in root.occurrences:
        if occ.component.name == name:
            if mode == 'replace':
                occ.deleteMe()
                break
            OCC = occ
            return occ.component
    occ = root.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    occ.component.name = name
    OCC = occ
    return occ.component

def in_context(entity):
    # Entities created through a sub-component's collections are native; some utilities
    # (Path.create) require the assembly-context proxy.
    return entity.createForAssemblyContext(OCC) if OCC is not None else entity

def body_named(comp, name):
    for b in comp.bRepBodies:
        if b.name == name:
            return b
    return None

def plane_for(comp, spec):
    if spec['kind'] == 'xyOffset':
        inp = comp.constructionPlanes.createInput()
        inp.setByOffset(comp.xYConstructionPlane, _vi(spec['offset']['expr']))
        pl = comp.constructionPlanes.add(inp)
        pl.name = 'plane ' + spec['offset']['expr']
        return pl
    raise RuntimeError('unknown plane kind ' + spec['kind'])

def new_sketch(comp, plane, name, profiles=False):
    sk = comp.sketches.add(plane)
    sk.name = name
    sk.isComputeDeferred = True
    # hiding profiles also skips computing them: only allowed when no closed profile is needed
    sk.areProfilesShown = profiles
    return sk

def finish_sketch(sk):
    sk.isComputeDeferred = False

def apply_extents(inp, f):
    if f.get('start'):
        inp.startExtent = adsk.fusion.OffsetStartDefinition.create(_vi(f['start']['expr']))
    inp.setDistanceExtent(False, _vi(f['distance']['expr']))

OPS = {'new': adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
       'join': adsk.fusion.FeatureOperations.JoinFeatureOperation,
       'cut': adsk.fusion.FeatureOperations.CutFeatureOperation}

def do_extrude(comp, f):
    plane = plane_for(comp, f['plane'])
    sk = new_sketch(comp, plane, f['name'], profiles=True)
    lines = sk.sketchCurves.sketchLines
    for poly in f['polygons']:
        pts = [sk.modelToSketchSpace(_p3(p)) for p in poly]
        for i in range(len(pts)):
            lines.addByTwoPoints(pts[i], pts[(i + 1) % len(pts)])
    finish_sketch(sk)
    profs = adsk.core.ObjectCollection.create()
    for i in range(sk.profiles.count):
        profs.add(sk.profiles.item(i))
    inp = comp.features.extrudeFeatures.createInput(profs, OPS[f['mode']])
    apply_extents(inp, f)
    if f['mode'] != 'new':
        inp.participantBodies = [body_named(comp, f['body'])]
    feat = comp.features.extrudeFeatures.add(inp)
    feat.name = f['name']
    if f['mode'] == 'new':
        feat.bodies.item(0).name = f['body']
    sk.isVisible = False
    return feat

def do_thin(comp, f):
    plane = plane_for(comp, f['plane'])
    sk = new_sketch(comp, plane, f['name'])
    lines = sk.sketchCurves.sketchLines
    made = []
    for a, b in f['segments']:
        made.append(lines.addByTwoPoints(sk.modelToSketchSpace(_p3(a)), sk.modelToSketchSpace(_p3(b))))
    finish_sketch(sk)
    paths = adsk.core.ObjectCollection.create()
    for ln in made:
        paths.add(adsk.fusion.Path.create(in_context(ln), adsk.fusion.ChainedCurveOptions.noChainedCurves))
    inp = comp.features.extrudeFeatures.createInput(paths, OPS['join'])
    inp.setThinExtrude(adsk.fusion.ThinExtrudeWallLocation.Center, _vi(f['thickness']['expr']))
    apply_extents(inp, f)
    inp.participantBodies = [body_named(comp, f['body'])]
    feat = comp.features.extrudeFeatures.add(inp)
    feat.name = f['name']
    sk.isVisible = False
    return feat

def do_holes(comp, f):
    plane = plane_for(comp, f['plane'])
    sk = new_sketch(comp, plane, f['name'])
    pts = adsk.core.ObjectCollection.create()
    for p in f['points']:
        pts.add(sk.sketchPoints.add(sk.modelToSketchSpace(_p3(p))))
    finish_sketch(sk)
    holes = comp.features.holeFeatures
    inp = holes.createSimpleInput(_vi(f['diameter']['expr']))
    inp.setPositionBySketchPoints(pts)
    inp.setDistanceExtent(_vi(f['depth']['expr']))
    inp.participantBodies = [body_named(comp, f['body'])]
    inp.isDefaultDirection = False  # sketch plane is the floor's bottom face; cut upward into the body
    feat = holes.add(inp)
    feat.name = f['name']
    sk.isVisible = False
    return feat

DO = {'extrude': do_extrude, 'thin': do_thin, 'holes': do_holes}

def build(design, plan, groups):
    t0 = time.perf_counter()
    ensure_params(design, plan['params'])
    comp = get_component(design, plan['componentName'], MODE)
    timeline = design.timeline
    built, skipped = [], []
    for g in groups:
        if body_named(comp, g['marker']) is not None:
            skipped.append(g['name'])
            continue
        start_index = timeline.count
        for f in g['features']:
            DO[f['op']](comp, f)
        if timeline.count - start_index > 1:
            try:
                grp = timeline.timelineGroups.add(start_index, timeline.count - 1)
                grp.name = g['name']
            except Exception:
                pass
        built.append(g['name'])
    bodies = [b for b in comp.bRepBodies]
    bb = None
    for b in bodies:
        box = b.boundingBox
        if bb is None:
            bb = [[box.minPoint.x, box.minPoint.y, box.minPoint.z], [box.maxPoint.x, box.maxPoint.y, box.maxPoint.z]]
        else:
            bb = [[min(bb[0][i], [box.minPoint.x, box.minPoint.y, box.minPoint.z][i]) for i in range(3)],
                  [max(bb[1][i], [box.maxPoint.x, box.maxPoint.y, box.maxPoint.z][i]) for i in range(3)]]
    return {
        'ok': True,
        'component': comp.name,
        'built': built,
        'skipped': skipped,
        'bodies': len(bodies),
        'volumeMm3': round(sum(b.volume for b in bodies) * 1000.0, 1),
        'bboxMm': None if bb is None else [[round(v / MM, 3) for v in bb[0]], [round(v / MM, 3) for v in bb[1]]],
        'expected': plan['expected'],
        'elapsedS': round(time.perf_counter() - t0, 2),
    }
`;

export const PY_RUN_ENTRY = String.raw`
def run(context):
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        design = adsk.fusion.Design.cast(app.activeProduct)
        if design is None:
            ui.messageBox('Open a Fusion design first.')
            return
        result = build(design, PLAN, PLAN['groups'])
        ui.messageBox('Maze built.\n' + json.dumps(result, indent=1))
    except Exception:
        ui.messageBox('Maze build failed:\n' + traceback.format_exc())
`;

/** Tail used by MCP `execute_code` chunks: evaluate to a JSON string (the bridge returns the last expression). */
export const PY_MCP_TAIL = String.raw`
_design = adsk.fusion.Design.cast(app.activeProduct)
_result = build(_design, PLAN, [g for g in PLAN['groups'] if g['name'] in CHUNK_GROUPS])
json.dumps(_result)
`;
