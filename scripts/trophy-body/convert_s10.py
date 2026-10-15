# Turns the Blend Swap "Chevy S-10 Stepside Extended Cab 2001" by digitalcos (blendswap.com/blend/11649,
# CC BY) into a trophy-truck body for the sand buggy's tube chassis (public/models/trophy-body.glb,
# loaded by src/render/trophy-body.js):
#
#   blender -b S-10_2001_stepside_extendedcab.blend --python scripts/trophy-body/convert_s10.py -- public/models/trophy-body.glb [render dir]
#
# Kept: the body panels (hood, front quarters, cab, doors, stepside bed sides), the windshield and
# back window, grille, lamps and mirrors. Dropped: the interior, running gear, frame, bumpers (the
# chassis has tube ones), tailgate and bed floor (the V8 sits in the open bed), side glass (window
# nets look), badges and stickers. The body is then bent onto the chassis' frame (x forward, y up,
# z right; metres, on the 2.7 m design wheelbase): each stretch of its length is mapped between
# landmarks (nose, front axle, windshield foot, windshield top, cab back, rear axle, tail) so the
# axles land on ours and the cab goes round the cage, it is raised so the roof clears the roof
# tubes, and the fenders and bed sides are pushed out to cover the 2.1 m track. Big wheel arches
# for the 0.92 m tyres and their travel are cut out and edged with black flare lips. Materials are
# reduced to a few the game sets up: Paint, Trim, Chrome, Glass, Headlamp, Signal and Tail.
import bpy, bmesh, math, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = argv[0] if argv else 'trophy-body.glb'
RENDER = argv[1] if len(argv) > 1 else None

KEEP = {
    'cabmain', 'doors', 'backdoors', 'sidewindowfrm', 'sidebackwindws', 'backwinowlatch', 'windshield', 'wiperpanel',
    'hood', 'frontqtrpanels', 'grillframe', 'grillmidbar', 'grilllattice', 'hedlits', 'frnttrnsignl',
    'outterbedlower', 'outerbedupperd', 'outerbedupperp', 'sidemirrors', 'gasdoor',
}
# Source material -> body material (None: the faces are dropped).
MATS = {
    'Best car paint ramp': 'Paint', 'LS_decal': 'Paint', 'tailgateback': 'Paint',
    'grill Black.001': 'Trim', 'Metal Black': 'Trim', 'flatblack': 'Trim', 'bmprbtm': 'Trim', 'bugguard': 'Trim',
    'doorhandles': 'Trim', 'steps': 'Trim', 'grill': 'Trim', 'int Black': 'Trim', 'wiperpanel': 'Trim',
    'bedblack': 'Trim', 'bedblack.001': 'Trim', 'sdwndwshd': 'Trim',
    'Bling Bling chrome': 'Chrome', 'hedltbackchrom': 'Chrome',
    'windshield': 'Glass', 'bkwindow': 'Glass', 'Mirror': 'Glass',
    'Head light glass 1': 'Headlamp', 'Head light glass 2': 'Headlamp',
    'Turnsignalglass': 'Signal', 'Turnsignalglassb': 'Signal',
    'taillight': 'Tail', 'reverselight.001': 'Paint',
}
COLORS = {  # sRGB, roughness, metalness, alpha
    'Paint': ('#f2efe6', 0.35, 0.0, 1), 'Trim': ('#1e2022', 0.6, 0.1, 1), 'Chrome': ('#c9ccd0', 0.2, 0.9, 1),
    'Glass': ('#1d2b33', 0.05, 0.0, 0.45), 'Headlamp': ('#fff4d6', 0.2, 0.0, 1), 'Signal': ('#f2a31b', 0.3, 0.0, 1),
    'Tail': ('#7a1010', 0.25, 0.0, 1),
}

# ---- Where the body goes ------------------------------------------------------------------------
# Source frame: Blender z up, nose toward -y, driver (left) on +x, centre line at x = -0.06; wheels
# r 0.375 at z -0.33, axles at y -1.8 and +1.485. u is the distance forward (-y).
CENTRE_X = -0.06
# Landmarks along the length, source u -> chassis x. Near each axle the map is uniform, so the
# arches stay round; the cab and the nose take up the difference.
U_MAP = [
    (-2.70, -2.47),
    (-2.58, -2.40),  # tail
    (-2.07, -1.90),  # back of the rear fender
    (-1.485, -1.35),  # rear axle
    (-0.90, -0.80),  # front of the rear fender
    (-0.49, -0.76),  # cab back
    (-0.32, -0.66),  # back of the roof, over the main hoop (x -0.6)
    (0.72, 0.30),  # top of the windshield, ahead of the header (x 0.25)
    (1.46, 0.80),  # windshield foot; the glass clears the A-pillars all the way up
    (1.80, 1.35),  # front axle
    (2.27, 1.95),  # front of the front fender
    (2.62, 2.16),  # nose
    (2.70, 2.21),
]
# Height: the rocker's foot to the floor tubes' bottom, the roof to just over the roof tubes.
ROCKER, ROOF = (-0.37, -0.45), (0.96, 0.975)
# Half width: the cab's sides go just outside the rockers and side bars (0.69-0.72); the fenders
# and bed sides go out over the tyres (outer face at 1.22). Inside the inner width the body keeps
# its width (the hood, grille and roof; the bed rails), past it it is spread out to the target.
SRC_HALF = 0.91
CAB = (0.42, 0.80)  # (inner, half width)
FENDER = (0.60, 1.29)


def lerp_map(table, v):
    if v <= table[0][0]:
        (a0, b0), (a1, b1) = table[0], table[1]
    elif v >= table[-1][0]:
        (a0, b0), (a1, b1) = table[-2], table[-1]
    else:
        for (a0, b0), (a1, b1) in zip(table, table[1:]):
            if a0 <= v <= a1:
                break
    return b0 + (v - a0) * (b1 - b0) / (a1 - a0)


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


# Inner and half width along the (chassis) length: fenders, the cab between them, the bed sides.
def widths(x):
    front = smoothstep(0.72, 0.98, x)  # the front fender starts just ahead of the door
    rear = 1 - smoothstep(-0.84, -0.74, x)  # the bed side starts behind the cab
    t = max(front, rear)
    return CAB[0] + (FENDER[0] - CAB[0]) * t, CAB[1] + (FENDER[1] - CAB[1]) * t


def to_chassis(co):
    u = -co.y
    x = lerp_map(U_MAP, u)
    y = ROCKER[1] + (co.z - ROCKER[0]) * (ROOF[1] - ROCKER[1]) / (ROOF[0] - ROCKER[0])
    s = -(co.x - CENTRE_X)  # right is -x in the source
    a = abs(s)
    inner, half = widths(x)
    if a > inner:
        a = inner + (a - inner) * (half - inner) / (SRC_HALF - inner)
    return x, y, math.copysign(a, s)


def B(x, y, z):  # chassis frame -> Blender (z up); the glTF exporter turns it back
    return Vector((x, -z, y))


# ---- Clean up -----------------------------------------------------------------------------------
# The kept parts' meshes in world space (taken before anything is removed: they hang off the
# frame and each other).
for o in bpy.data.objects:
    for m in o.modifiers:
        if m.type == 'SUBSURF':
            m.levels = m.render_levels = 1
dg = bpy.context.evaluated_depsgraph_get()
bm = bmesh.new()
slot = {}  # body material name -> index
for o in [o for o in bpy.data.objects if o.name in KEEP]:
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    me.transform(o.matrix_world)
    mats = [m.name if m else None for m in me.materials]
    part = bmesh.new()
    part.from_mesh(me)
    drop = []
    for f in part.faces:
        src = mats[f.material_index] if f.material_index < len(mats) else None
        dst = MATS.get(src)
        # Side glass goes (the cab's back window and the windshield stay).
        if dst is None or (src == 'Blue ray glass'):
            drop.append(f)
            continue
        f.material_index = slot.setdefault(dst, len(slot))
    bmesh.ops.delete(part, geom=drop, context='FACES')
    part.to_mesh(me)
    part.free()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

# ---- Bend it onto the chassis -------------------------------------------------------------------
for v in bm.verts:
    v.co = B(*to_chassis(v.co))

lip = slot.setdefault('Trim', len(slot))
me = bpy.data.meshes.new('Trophy body')
bm.to_mesh(me)
bm.free()
for name in sorted(slot, key=slot.get):
    m = bpy.data.materials.new(name)
    color, rough, metal, alpha = COLORS[name]
    p = m.node_tree.nodes['Principled BSDF']
    h = color.lstrip('#')
    p.inputs['Base Color'].default_value = (*[(int(h[i:i + 2], 16) / 255) ** 2.2 for i in (0, 2, 4)], 1)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if alpha < 1:
        p.inputs['Alpha'].default_value = alpha
        m.surface_render_method = 'BLENDED'
    me.materials.append(m)
body = bpy.data.objects.new('Trophy body', me)
bpy.context.scene.collection.objects.link(body)
bpy.context.view_layer.objects.active = body
body.select_set(True)

# Wheel arches: a cylinder across each wheel cuts the fenders, the doors' corners and the bed
# sides (outboard of the chassis only, so nothing over the middle is touched).
WHEEL_X, WHEEL_Y, ARCH_R = 1.35, -0.45, 0.70
CUT_IN, CUT_OUT = 0.62, 1.8
for ax in (WHEEL_X, -WHEEL_X):
    for s in (1, -1):
        bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=ARCH_R, depth=CUT_OUT - CUT_IN,
                                            location=B(ax, WHEEL_Y, s * (CUT_IN + CUT_OUT) / 2), rotation=(math.pi / 2, 0, 0))
        cyl = bpy.context.active_object
        mod = body.modifiers.new('Arch', 'BOOLEAN')
        mod.operation = 'DIFFERENCE'
        mod.solver = 'EXACT'
        mod.use_hole_tolerant = True
        mod.object = cyl
        bpy.context.view_layer.objects.active = body
        bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.data.objects.remove(cyl, do_unlink=True)

# Flare lips: the panels' cut edges round each arch turned out into a black flange, out from the
# side and a little out from the wheel.
bm = bmesh.new()
bm.from_mesh(me)
def on_arch(v):
    x, z, y = v.co.x, -v.co.y, v.co.z
    if abs(z) < CUT_IN + 0.005:
        return None
    for ax in (WHEEL_X, -WHEEL_X):
        if abs(math.hypot(x - ax, y - WHEEL_Y) - ARCH_R) < 0.004:
            return ax
    return None
edges = [e for e in bm.edges if e.is_boundary and on_arch(e.verts[0]) is not None and on_arch(e.verts[1]) is not None]
ret = bmesh.ops.extrude_edge_only(bm, edges=edges)
for v in [g for g in ret['geom'] if isinstance(g, bmesh.types.BMVert)]:
    x, z, y = v.co.x, -v.co.y, v.co.z
    ax = on_arch(v)
    dx, dy = x - ax, y - WHEEL_Y
    r = math.hypot(dx, dy)
    k = (r + 0.035) / r
    v.co = B(ax + dx * k, WHEEL_Y + dy * k, math.copysign(abs(z) + 0.06, z))
for f in [g for g in ret['geom'] if isinstance(g, bmesh.types.BMFace)]:
    f.material_index = lip
bm.to_mesh(me)
bm.free()
for p in me.polygons:
    p.use_smooth = True
bpy.context.view_layer.objects.active = body
body.select_set(True)
bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
print('tris', sum(len(p.vertices) - 2 for p in me.polygons))

bpy.ops.export_scene.gltf(filepath=GLB, use_selection=True, export_format='GLB', export_apply=True, export_materials='EXPORT', export_yup=True, export_texcoords=False)

if RENDER:
    import os
    sc = bpy.context.scene
    ld = bpy.data.lights.new('Sun', 'SUN'); ld.energy = 4.0
    sun = bpy.data.objects.new('Sun', ld); sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(40), math.radians(10), math.radians(-35))
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 1200, 800
    sc.view_settings.view_transform = 'AgX'
    sc.render.image_settings.file_format = 'PNG'
    w = sc.world or bpy.data.worlds.new('World'); sc.world = w
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.75, 0.72, 0.66, 1)
    for name, az, el in (('3q', -40, 20), ('side', -90, 0), ('front', 0, 5), ('top', -90, 89), ('3qr', -145, 25)):
        cam = bpy.data.objects.new(name, bpy.data.cameras.new(name)); sc.collection.objects.link(cam)
        a, e = math.radians(az), math.radians(el)
        t = Vector((0, 0, 0.1))
        cam.location = t + 10 * Vector((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))
        cam.rotation_euler = (t - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.camera = cam
        sc.render.filepath = os.path.join(RENDER, f'trophy_{name}.png')
        bpy.ops.render.render(write_still=True)
