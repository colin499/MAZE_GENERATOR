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

def marker_exists(comp, marker):
    if marker.startswith('feature:'):
        name = marker[len('feature:'):]
        for i in range(comp.features.count):
            if comp.features.item(i).name == name:
                return True
        return False
    return body_named(comp, marker) is not None

BASE = {'XY': lambda c: c.xYConstructionPlane, 'XZ': lambda c: c.xZConstructionPlane, 'YZ': lambda c: c.yZConstructionPlane}
AXIS = {'X': lambda c: c.xConstructionAxis, 'Y': lambda c: c.yConstructionAxis, 'Z': lambda c: c.zConstructionAxis}
FLIP_AXIS = {'XY': 'X', 'XZ': 'X', 'YZ': 'Y'}   # an axis lying in the base plane, to turn it over
ANGLE_BASE = {'X': 'XY', 'Y': 'XY', 'Z': 'XZ'}  # base plane containing each axis

def plane_for(comp, spec):
    planes = comp.constructionPlanes
    if spec['kind'] == 'xyOffset':
        inp = planes.createInput()
        inp.setByOffset(comp.xYConstructionPlane, _vi(spec['offset']['expr']))
        pl = planes.add(inp)
        pl.name = 'plane ' + spec['offset']['expr']
        return pl
    if spec['kind'] == 'offset':
        base = BASE[spec['base']](comp)
        if spec['flip']:
            inp = planes.createInput()
            inp.setByAngle(AXIS[FLIP_AXIS[spec['base']]](comp), _vi('180 deg'), base)
            base = planes.add(inp)
            base.name = spec['base'] + ' flipped'
        inp = planes.createInput()
        inp.setByOffset(base, _vi(spec['offset']['expr']))
        pl = planes.add(inp)
        pl.name = spec['base'] + ('-' if spec['flip'] else '+') + ' ' + spec['offset']['expr']
        return pl
    if spec['kind'] == 'angle':
        inp = planes.createInput()
        inp.setByAngle(AXIS[spec['axis']](comp), _vi('%s deg' % spec['angleDeg']), BASE[ANGLE_BASE[spec['axis']]](comp))
        pl = planes.add(inp)
        pl.name = 'about %s %s deg' % (spec['axis'], spec['angleDeg'])
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

def all_profiles(sk):
    profs = adsk.core.ObjectCollection.create()
    for i in range(sk.profiles.count):
        profs.add(sk.profiles.item(i))
    return profs

def profile_nearest_area(sk, area_mm2):
    best, best_d = None, None
    for i in range(sk.profiles.count):
        pr = sk.profiles.item(i)
        d = abs(pr.areaProperties().area * 100.0 - area_mm2)
        if best is None or d < best_d:
            best, best_d = pr, d
    return best

def circle_with_dia(sk, center, expr, mm):
    c = sk.sketchCurves.sketchCircles.addByCenterRadius(sk.modelToSketchSpace(_p3(center)), mm * MM / 2.0)
    anchor = sk.modelToSketchSpace(_p3([center[0] + mm * 0.6, center[1] + mm * 0.6, center[2]]))
    dim = sk.sketchDimensions.addDiameterDimension(c, anchor)
    dim.parameter.expression = expr
    return c

def do_ring(comp, f):
    plane = plane_for(comp, f['plane'])
    sk = new_sketch(comp, plane, f['name'], profiles=True)
    circle_with_dia(sk, f['center'], f['innerDia']['expr'], f['innerDia']['mm'])
    circle_with_dia(sk, f['center'], f['outerDia']['expr'], f['outerDia']['mm'])
    finish_sketch(sk)
    ri, ro = f['innerDia']['mm'] / 2.0, f['outerDia']['mm'] / 2.0
    prof = profile_nearest_area(sk, 3.141592653589793 * (ro * ro - ri * ri))
    inp = comp.features.extrudeFeatures.createInput(prof, OPS[f['mode']])
    apply_extents(inp, f)
    if f['mode'] != 'new':
        inp.participantBodies = [body_named(comp, f['body'])]
    feat = comp.features.extrudeFeatures.add(inp)
    feat.name = f['name']
    if f['mode'] == 'new':
        feat.bodies.item(0).name = f['body']
    sk.isVisible = False
    return feat

def do_disk(comp, f):
    plane = plane_for(comp, f['plane'])
    sk = new_sketch(comp, plane, f['name'], profiles=True)
    circle_with_dia(sk, f['center'], f['diameter']['expr'], f['diameter']['mm'])
    area = 3.141592653589793 * (f['diameter']['mm'] / 2.0) ** 2
    for h in f['holes']:
        circle_with_dia(sk, h['center'], h['diameter']['expr'], h['diameter']['mm'])
        area -= 3.141592653589793 * (h['diameter']['mm'] / 2.0) ** 2
    finish_sketch(sk)
    prof = profile_nearest_area(sk, area)
    inp = comp.features.extrudeFeatures.createInput(prof, OPS[f['mode']])
    apply_extents(inp, f)
    if f['mode'] != 'new':
        inp.participantBodies = [body_named(comp, f['body'])]
    feat = comp.features.extrudeFeatures.add(inp)
    feat.name = f['name']
    if f['mode'] == 'new':
        feat.bodies.item(0).name = f['body']
    sk.isVisible = False
    return feat

def do_sectors(comp, f):
    plane = plane_for(comp, f['plane'])
    sk = new_sketch(comp, plane, f['name'], profiles=True)
    S = lambda p: sk.modelToSketchSpace(_p3(p))
    arcs, lines = sk.sketchCurves.sketchArcs, sk.sketchCurves.sketchLines
    for s in f['sectors']:
        arcs.addByThreePoints(S(s['innerStart']), S(s['innerMid']), S(s['innerEnd']))
        arcs.addByThreePoints(S(s['outerStart']), S(s['outerMid']), S(s['outerEnd']))
        lines.addByTwoPoints(S(s['innerStart']), S(s['outerStart']))
        lines.addByTwoPoints(S(s['innerEnd']), S(s['outerEnd']))
    finish_sketch(sk)
    inp = comp.features.extrudeFeatures.createInput(all_profiles(sk), OPS['join'])
    inp.setSymmetricExtent(_vi(f['thickness']['expr']), True)
    inp.participantBodies = [body_named(comp, f['body'])]
    feat = comp.features.extrudeFeatures.add(inp)
    feat.name = f['name']
    sk.isVisible = False
    return feat

def do_radial_holes(comp, f):
    plane = plane_for(comp, f['plane'])
    feats = []
    for k, quad in enumerate(f['holes']):
        sk = new_sketch(comp, plane, '%s %d' % (f['name'], k), profiles=True)
        S = lambda p: sk.modelToSketchSpace(_p3(p))
        lines = sk.sketchCurves.sketchLines
        edges = [lines.addByTwoPoints(S(quad[i]), S(quad[(i + 1) % 4])) for i in range(4)]
        finish_sketch(sk)
        inp = comp.features.revolveFeatures.createInput(sk.profiles.item(0), edges[0], OPS['cut'])
        inp.setAngleExtent(False, _vi('360 deg'))
        inp.participantBodies = [body_named(comp, f['body'])]
        feat = comp.features.revolveFeatures.add(inp)
        feat.name = '%s %d' % (f['name'], k)
        sk.isVisible = False
        feats.append(feat)
    return feats[-1] if feats else None

def do_revolve(comp, f):
    plane = plane_for(comp, f['plane'])
    sk = new_sketch(comp, plane, f['name'], profiles=True)
    S = lambda p: sk.modelToSketchSpace(_p3(p))
    for a, b in f['lines']:
        sk.sketchCurves.sketchLines.addByTwoPoints(S(a), S(b))
    for a, m, b in f['arcs']:
        sk.sketchCurves.sketchArcs.addByThreePoints(S(a), S(m), S(b))
    finish_sketch(sk)
    inp = comp.features.revolveFeatures.createInput(all_profiles(sk), comp.zConstructionAxis, OPS[f['mode']])
    inp.setAngleExtent(False, _vi('360 deg'))
    if f['mode'] != 'new':
        inp.participantBodies = [body_named(comp, f['body'])]
    feat = comp.features.revolveFeatures.add(inp)
    feat.name = f['name']
    if f['mode'] == 'new':
        feat.bodies.item(0).name = f['body']
    sk.isVisible = False
    return feat

DO = {'extrude': do_extrude, 'thin': do_thin, 'holes': do_holes, 'ring': do_ring, 'disk': do_disk,
      'sectors': do_sectors, 'radialHoles': do_radial_holes, 'revolve': do_revolve}

def build(design, plan, groups):
    t0 = time.perf_counter()
    ensure_params(design, plan['params'])
    comp = get_component(design, plan['componentName'], MODE)
    timeline = design.timeline
    built, skipped = [], []
    for g in groups:
        if marker_exists(comp, g['marker']):
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
