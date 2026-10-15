# Turns the Blend Swap "Chevy S-10 Stepside Extended Cab 2001" by digitalcos (blendswap.com/blend/11649,
# CC BY) into a trophy-truck body for the sand buggy's tube chassis (public/models/trophy-body.glb,
# loaded by src/render/trophy-body.js):
#
#   blender -b S-10_2001_stepside_extendedcab.blend --python scripts/trophy-body/convert_s10.py -- public/models/trophy-body.glb [render dir]
#
# Kept: the body panels (hood, front quarters, cab, doors, stepside bed sides), the windshield and
# back window, grille, lamps and mirrors. Dropped: the interior, running gear, frame, bumpers (the
# chassis has tube ones), tailgate and bed floor (the V8 sits in the open bed), side glass (window
# nets look), badges and stickers. The truck keeps its own shape: it is scaled evenly (0.86) into
# the chassis' frame (x forward, y up, z right; metres, on the 2.7 m design wheelbase) with its
# front axle on ours, and the tube chassis' trophy-truck cage is built to fit inside it (see
# TROPHY_CAGE in src/render/tube-chassis.js). Its wheel openings are cut out big for the 0.92 m
# tyres and their travel, and wide fibreglass fender flares over each wheel reach out over the
# 2.1 m track, as on a trophy truck. Materials are reduced to a few the game sets up: Paint (the
# livery, painted by the game), Trim, Chrome, Glass, Headlamp, Signal and Tail.
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
SCALE = 0.86
# The source u that lands on x = 0: its front axle (u 1.8) goes on ours (x 1.35); the cab's back
# (u -0.49) then lands at -0.62, behind the main hoop.
U0 = 1.8 - 1.35 / SCALE
# Height: the rockers' foot (source z -0.37) at y -0.34, a little above the floor tubes, so the
# roof (0.96) comes to 0.80, just over the cage's roof tubes.
ROCKER_Y = -0.34


def to_chassis(co):
    return (-co.y - U0) * SCALE, ROCKER_Y + (co.z + 0.37) * SCALE, -(co.x - CENTRE_X) * SCALE  # right is -x in the source


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
CUT_IN, CUT_OUT = 0.4, 1.8
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

# Fender flares: a fibreglass hood over each wheel from the body's side out past the tyre, swept
# round the arch; its section (radius out from the wheel, height across the car) rises from the
# body side, rolls over and ends in a black lip at the arch. They stop at the nose (front) and the
# tail; the front ones reach back over the doors' lower corners.
FLARE = [(0.15, 0.72), (0.15, 0.84), (0.135, 0.98), (0.11, 1.1), (0.075, 1.2), (0.035, 1.27), (0.0, 1.3)]
LIP = [(0.0, 1.3), (-0.01, 1.285), (-0.012, 1.24)]
paint, trim = slot['Paint'], slot['Trim']
bm = bmesh.new()
bm.from_mesh(me)
# The boolean leaves a few slivers hanging from the cut (on the panels' open edges); nothing of
# the body itself reaches below the rockers' foot.
bmesh.ops.delete(bm, geom=[f for f in bm.faces if min(v.co.z for v in f.verts) < ROCKER_Y - 0.03], context='FACES')
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')


def sweep(ax, side, a0, a1, section, mat, n=56):
    rows = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        c, sn = math.cos(a), math.sin(a)
        rows.append([bm.verts.new(B(ax + c * (ARCH_R + dr), WHEEL_Y + sn * (ARCH_R + dr), side * z)) for dr, z in section])
    for r0, r1 in zip(rows, rows[1:]):
        for j in range(len(section) - 1):
            f = [r0[j], r1[j], r1[j + 1], r0[j + 1]]
            f = bm.faces.new(f if side > 0 else list(reversed(f)))
            f.material_index = mat
            f.smooth = True
    return rows


for ax, (a0, a1) in ((WHEEL_X, (36, 152)), (-WHEEL_X, (16, 166))):
    for side in (1, -1):
        rows = sweep(ax, side, a0, a1, FLARE, paint)
        sweep(ax, side, a0, a1, LIP, trim)
        # Close the flare's ends down to its root.
        for row in (rows[0], rows[-1]):
            f = bm.faces.new(row)
            f.material_index = paint
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
