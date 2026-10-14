# Builds the sunny town's building kit (src/terrain/town-kit.js, public/models/town-kit.glb):
# a few rounded, diorama-like buildings in the colours of the reference (cream and sand stone,
# terracotta, brick, slate, a teal dome), modelled from code so they can be tweaked and re-run:
#
#   blender -b --python scripts/town-kit/build_kit.py -- public/models/town-kit.glb src/terrain/town-kit.js
#
# Each building is one mesh object named after its kit entry, in Blender's axes (z up) with the
# front facing -y and the origin at the middle of its footprint on the ground; the exporter turns
# that to glTF's y up, the front facing +z. The walls run down to PLINTH below the ground, so a
# building on a slope never shows its underside. Colours are baked into a colour attribute
# (COLOR_0), its alpha marking what the game may repaint per building: 0.5 on the main walls,
# 0.25 on the main roof, 1 elsewhere; the window glass is its own material, so the game can tell it apart.
import bpy, bmesh, json, math, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = argv[0] if argv else 'town-kit.glb'
MANIFEST = argv[1] if len(argv) > 1 else None
RENDER = argv[2] if len(argv) > 2 else None

Z = Vector((0, 0, 1))
FLOOR = 3.2  # m per storey, as src/terrain/buildings.js
PLINTH = 4.5  # m the walls reach below the ground

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for coll in (bpy.data.meshes, bpy.data.materials):
    for d in list(coll):
        if d.users == 0:
            coll.remove(d)

def srgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))

# Authoring colours (sRGB); baked into the colour attribute.
C = dict(
    cream='#ecd3a2', sand='#dcb57e', white='#f3eee3', trim='#f6f1e6', stone='#a39a88', plinth='#8f877a',
    terra='#c9552e', terra_dk='#9a3d22', slate='#56607a', slate_dk='#3d4559', brick='#b0573d', brick_dk='#8a4030',
    teal='#3f9fae', copper='#5fae9a', gold='#d9b24a', wood='#5e3c24', green='#3f6e52', red='#b8423b',
    iron='#2c2c30', yellow='#ead88f', ochre='#d79a52', glass='#36587c',
    stucco='#e6dac0', greystone='#c9c1af', flat='#9d9a92', machine='#bfbcb4', aqua='#5fc3cf', aqua_dk='#2f8f9e', mullion='#dfe8ea',
)

class Builder:
    def __init__(self, name, wall, roof=None):
        self.name = name
        self.wall = wall  # the main wall and roof colours (marked in the colour's alpha)
        self.roof = roof
        self.bm = bmesh.new()
        self.color = self.bm.loops.layers.color.new('Col')
        self.glass = []

    def poly(self, verts, faces, col, smooth=False):
        vs = [self.bm.verts.new(Vector(v)) for v in verts]
        rgb = (*srgb(C[col]), 0.5 if col == self.wall else 0.25 if col == self.roof else 1.0)
        for f in faces:
            face = self.bm.faces.new([vs[i] for i in f])
            face.smooth = smooth
            face.material_index = 1 if col in ('glass', 'aqua') else 0
            for loop in face.loops:
                loop[self.color] = rgb

    def obox(self, c, u, n, su, sn, sz, col, bottom=False):
        c, u, n = Vector(c), Vector(u), Vector(n)
        v = []
        for dz in (-0.5, 0.5):
            for du, dn in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
                v.append(c + u * su * du + n * sn * dn + Z * sz * dz)
        faces = [(4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        if bottom:
            faces.append((0, 1, 2, 3))
        self.poly(v, faces, col)

    def box(self, cx, cy, z0, sx, sy, sz, col, bottom=False):
        self.obox((cx, cy, z0 + sz / 2), (1, 0, 0), (0, 1, 0), sx, sy, sz, col, bottom)

    # A loft through rings of 2D points (same count, counter-clockwise) at heights; the top closed.
    def loft(self, rings, col, smooth=False, cap=True, offset=(0, 0)):
        ox, oy = offset
        n = len(rings[0][0])
        verts = []
        for pts, z in rings:
            verts += [(ox + x, oy + y, z) for x, y in pts]
        faces = []
        for r in range(len(rings) - 1):
            a, b = r * n, (r + 1) * n
            for i in range(n):
                j = (i + 1) % n
                faces.append((a + i, a + j, b + j, b + i))
        self.poly(verts, faces, col, smooth)
        if cap:
            top = [(ox + x, oy + y, rings[-1][1]) for x, y in rings[-1][0]]
            self.poly(top, [tuple(range(n))], col)

    def prism(self, pts, z0, z1, col, smooth=False, offset=(0, 0)):
        self.loft([(pts, z0), (pts, z1)], col, smooth, True, offset)

    def cone(self, cx, cy, r, z0, h, col, n=12, flare=0.0):
        pts = circle(r, n)
        verts = [(cx + x, cy + y, z0) for x, y in pts]
        faces = []
        if flare:
            # A kicked eave: an outer ring a little lower and wider first.
            verts = [(cx + x * (1 + flare / r), cy + y * (1 + flare / r), z0 - 0.25) for x, y in pts] + verts
            faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
            base = n
        else:
            base = 0
        verts.append((cx, cy, z0 + h))
        apex = len(verts) - 1
        faces += [(base + i, base + (i + 1) % n, apex) for i in range(n)]
        self.poly(verts, faces, col, smooth=True)

    def dome(self, cx, cy, r, z0, col, n=16, rings=5, sz=1.0, onion=0.0):
        rs = []
        for k in range(rings):
            phi = (k / rings) * math.pi / 2
            rr = r * math.cos(phi) * (1 + onion * math.sin(phi * 2))
            rs.append((circle(rr, n), z0 + r * sz * math.sin(phi)))
        self.loft(rs, col, smooth=True, cap=False, offset=(cx, cy))
        top = len(rs)
        verts = [(cx + x, cy + y, rs[-1][1]) for x, y in rs[-1][0]] + [(cx, cy, z0 + r * sz)]
        self.poly(verts, [(i, (i + 1) % n, n) for i in range(n)], col, smooth=True)

    def finish(self):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        me.materials.append(BODY)
        me.materials.append(GLASS)
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob

def circle(r, n, a0=0.0):
    return [(r * math.cos(a0 + 2 * math.pi * i / n), r * math.sin(a0 + 2 * math.pi * i / n)) for i in range(n)]

def rrect(hx, hy, r, segs=3):
    # A rounded rectangle, counter-clockwise, 4 * (segs + 1) points.
    r = min(r, hx - 1e-3, hy - 1e-3)
    pts = []
    for cx, cy, a0 in ((hx - r, -hy + r, -math.pi / 2), (hx - r, hy - r, 0), (-hx + r, hy - r, math.pi / 2), (-hx + r, -hy + r, math.pi)):
        for k in range(segs + 1):
            a = a0 + (math.pi / 2) * k / segs
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

def mat(name, hexcol, rough, metal=0.0):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    b = m.node_tree.nodes.get('Principled BSDF')
    lin = tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in srgb(hexcol))
    b.inputs['Base Color'].default_value = (*lin, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if name == 'Body':
        # Shows the baked colours in Blender's renders (the game reads COLOR_0 itself).
        attr = m.node_tree.nodes.new('ShaderNodeVertexColor')
        attr.layer_name = 'Col'
        m.node_tree.links.new(attr.outputs['Color'], b.inputs['Base Color'])
    return m

BODY = mat('Body', '#ffffff', 0.85)
GLASS = mat('Glass', C['glass'], 0.15, 0.3)

# ---- Facades ----------------------------------------------------------------------------------
# A facade: (outward normal n, along-wall direction u, distance of the wall plane from the middle).
def facades(W, D):
    return {
        'front': (Vector((0, -1, 0)), Vector((1, 0, 0)), D / 2),
        'back': (Vector((0, 1, 0)), Vector((-1, 0, 0)), D / 2),
        'right': (Vector((1, 0, 0)), Vector((0, 1, 0)), W / 2),
        'left': (Vector((-1, 0, 0)), Vector((0, -1, 0)), W / 2),
    }

def arch_contour(s, z0, w, h, segs, grow=0.0):
    r = w / 2 + grow
    hr = max(h - w / 2, 0.05)
    pts = [(s - r, z0 - grow * 0.0)]
    for k in range(segs + 1):
        a = math.pi - math.pi * k / segs
        pts.append((s + r * math.cos(a), z0 + hr + r * math.sin(a)))
    pts.append((s + r, z0))
    return pts

def window(B, f, s, z0, w, h, frame='trim', arch=False, segs=3, sill=True, key=False, shutters=None, depth=0.0, lintel=False, bars=True):
    # An arched (or square) window: glass set into the wall plane, a frame proud of it, a sill
    # and a keystone.
    n, u, off = f
    off += depth
    to3 = lambda p, dn: n * (off + dn) + u * p[0] + Z * p[1]
    t = 0.13
    if arch:
        inner = arch_contour(s, z0, w, h, segs)
        outer = arch_contour(s, z0, w, h, segs, grow=t)
    else:
        inner = [(s - w / 2, z0), (s - w / 2, z0 + h), (s + w / 2, z0 + h), (s + w / 2, z0)]
        outer = [(s - w / 2 - t, z0), (s - w / 2 - t, z0 + h + t), (s + w / 2 + t, z0 + h + t), (s + w / 2 + t, z0)]
    # Glass: a thin slab just proud of the wall.
    B.poly([to3(p, 0.03) for p in inner], [tuple(range(len(inner)))[::-1]], 'glass')
    # Frame: a flat ribbon between the inner and outer contours, a little proud of the wall (its
    # edges are left open: too thin to see, and they would double the window's triangles).
    m = len(inner)
    verts = [to3(p, 0.07) for p in inner] + [to3(p, 0.07) for p in outer]
    B.poly(verts, [(i, i + 1, m + i + 1, m + i) for i in range(m - 1)], frame)
    # Glazing bars.
    if bars:
        B.obox(n * (off + 0.06) + u * s + Z * (z0 + h / 2), u, n, 0.06, 0.08, h - 0.02, frame)
        if not arch:
            B.obox(n * (off + 0.06) + u * s + Z * (z0 + h * 0.7), u, n, w, 0.08, 0.06, frame)
    if lintel:
        B.obox(n * (off + 0.08) + u * s + Z * (z0 + h + 0.2), u, n, w + 0.5, 0.16, 0.18, frame)
    if sill:
        B.obox(n * (off + 0.12) + u * s + Z * (z0 - 0.06), u, n, w + 0.4, 0.26, 0.12, frame)
    if key and arch:
        B.obox(n * (off + 0.14) + u * s + Z * (z0 + h + t * 0.5), u, n, 0.26, 0.2, 0.36, frame)
    if shutters:
        for side in (-1, 1):
            B.obox(n * (off + 0.05) + u * (s + side * (w / 2 + t + w * 0.27)) + Z * (z0 + (h - w / 2 if arch else h) / 2 + 0.02), u, n, w * 0.5, 0.06, (h - w / 2 if arch else h), shutters)

def round_window(B, f, s, zc, r, frame='trim', segs=8, depth=0.0):
    n, u, off = f
    off += depth
    to3 = lambda p, dn: n * (off + dn) + u * p[0] + Z * p[1]
    inner = [(s + x, zc + y) for x, y in circle(r, segs)]
    outer = [(s + x, zc + y) for x, y in circle(r + 0.14, segs)]
    B.poly([to3(p, 0.03) for p in inner], [tuple(range(segs))[::-1]], 'glass')
    verts = [to3(p, 0.12) for p in inner] + [to3(p, 0.12) for p in outer] + [to3(p, 0.0) for p in outer]
    faces = []
    for i in range(segs):
        j = (i + 1) % segs
        faces.append((i, j, segs + j, segs + i))
        faces.append((segs + i, segs + j, 2 * segs + j, 2 * segs + i))
    B.poly(verts, faces, frame)
    B.obox(n * (off + 0.06) + u * s + Z * zc, u, n, 2 * r, 0.06, 0.06, frame)
    B.obox(n * (off + 0.06) + u * s + Z * zc, u, n, 0.06, 0.06, 2 * r, frame)

def awning(B, f, s, z_top, w, out, col, stripes='trim', segs=4):
    # A half-round canvas awning: a quarter cylinder from the wall out and down, closed at the ends.
    n, u, off = f
    prof = [(out * math.sin(a), out * math.cos(a)) for a in [math.pi / 2 * k / segs for k in range(segs + 1)]]  # (outward, up)
    verts = []
    for side in (-0.5, 0.5):
        for dn, dz in prof:
            verts.append(n * (off + dn) + u * (s + side * w) + Z * (z_top - out + dz))
    m = segs + 1
    faces = [(i, i + 1, m + i + 1, m + i) for i in range(segs)]
    B.poly(verts, faces, col, smooth=True)
    # End caps (fans from the wall corner).
    for side, base in ((-0.5, 0), (0.5, m)):
        c = n * off + u * (s + side * w) + Z * (z_top - out)
        B.poly([c] + verts[base:base + m], [tuple(range(m + 1))], col)
    # Scalloped valance.
    for k in range(int(w / 0.5)):
        B.obox(n * (off + out) + u * (s - w / 2 + 0.25 + k * 0.5) + Z * (z_top - out - 0.12), u, n, 0.46, 0.04, 0.26, stripes if k % 2 else col)

def door(B, f, s, w, h, col='wood', frame='trim', depth=0.1):
    n, u, off = f
    off += depth
    inner = arch_contour(s, 0.0, w, h, 5)
    B.poly([n * (off + 0.02) + u * p[0] + Z * p[1] for p in inner], [tuple(range(len(inner)))[::-1]], col)
    window(B, (n, u, off), s, 0.0, w, h, frame=frame, sill=False, segs=5, key=True, arch=True)
    B.obox(n * (off + 0.4) + u * s + Z * -0.1, u, n, w + 1.0, 0.8, 0.3, 'stone')

def walls_rrect(B, hx, hy, r, z1, col, segs=3):
    B.prism(rrect(hx, hy, r, segs), -PLINTH, z1, col)

def band(B, hx, hy, r, z, h, col, grow=0.12, segs=3):
    B.prism(rrect(hx + grow, hy + grow, r + grow, segs), z, z + h, col)

def rounded_hip(B, hx, hy, z, rise, col, r=0.8, over=0.45):
    # A soft hip roof: rounded-rectangle rings drawn in toward a short ridge along the longer side,
    # the slopes bowed out a little.
    rings = []
    steps = 4
    long_x = hx >= hy
    for k in range(steps + 1):
        t = k / steps
        bow = math.sin(t * math.pi / 2)  # convex profile
        shrink = 1 - bow
        sx = (hx + over) * shrink + (abs(hx - hy) if long_x else 0.06) * bow
        sy = (hy + over) * shrink + (abs(hy - hx) if not long_x else 0.06) * bow
        rings.append((rrect(max(sx, 0.08), max(sy, 0.08), r * shrink + 0.05), z + rise * t))
    # Eaves underside lip.
    B.prism(rrect(hx + over, hy + over, r), z - 0.22, z, col + '_dk' if col + '_dk' in C else col)
    B.loft(rings, col, smooth=True)

# ---- The kit -----------------------------------------------------------------------------------

KIT = []

# `size`: the lots it suits (small, mid, tall, or rare for a landmark); `paint`: the palette its
# walls are repainted from (stucco, brick, or none); `stretch`: whether the game may widen or
# narrow it along the street to close up a row (straight facades only).
def entry(ob, w, d, eaves, storeys, size, paint='stucco', stretch=False):
    KIT.append({'name': ob.name, 'w': round(w, 2), 'd': round(d, 2), 'eaves': round(eaves, 2), 'storeys': storeys, 'size': size, 'paint': paint, 'stretch': stretch})

def turret_corner():
    # Four storeys of cream stone on a corner, a round turret with a cone roof on the front right.
    B = Builder('Kit_TurretCorner', 'cream', 'terra')
    W, D = 9.6, 9.0
    G, NF = 3.6, 3
    eaves = G + FLOOR * NF
    hx, hy = W / 2, D / 2
    walls_rrect(B, hx, hy, 0.5, eaves, 'cream')
    B.prism(rrect(hx + 0.08, hy + 0.08, 0.58), -PLINTH, 0.5, 'plinth')
    band(B, hx, hy, 0.5, G - 0.15, 0.25, 'trim')
    for i in range(1, NF):
        band(B, hx, hy, 0.5, G + FLOOR * i - 0.1, 0.16, 'trim', grow=0.08)
    band(B, hx, hy, 0.5, eaves, 0.2, 'trim', grow=0.15)
    band(B, hx, hy, 0.5, eaves + 0.2, 0.18, 'trim', grow=0.3)
    # Turret: centred on the front right corner.
    tx, ty, tr = hx - 0.9, -hy + 0.9, 2.0
    B.prism(circle(tr, 14), -PLINTH, eaves + 2.6, 'cream', smooth=True, offset=(tx, ty))
    B.prism(circle(tr + 0.12, 14), G - 0.15, G + 0.1, 'trim', smooth=True, offset=(tx, ty))
    B.prism(circle(tr + 0.2, 14), eaves + 2.6, eaves + 2.9, 'trim', smooth=True, offset=(tx, ty))
    B.cone(tx, ty, tr + 0.25, eaves + 2.9, 4.4, 'slate', n=14, flare=0.35)
    B.box(tx, ty, eaves + 7.2, 0.08, 0.08, 1.0, 'gold')
    for i in range(NF + 1):
        z0 = (G + FLOOR * (i - 1) + 0.75) if i else 0.9
        if i == NF:
            z0 = eaves + 0.5
        for a in (-0.75, 0.2, 1.15):  # around the street-facing side
            ang = -math.pi / 2 + a
            n = Vector((math.cos(ang), math.sin(ang), 0))
            u = Vector((-n.y, n.x, 0))
            c = Vector((tx, ty, 0))
            window(B, (n, u, tr - 0.06), (c.dot(u)), z0, 0.75, 1.7 if i else 1.9, sill=True)
    fs = facades(W, D)
    front_s, right_s = [-3.3, -1.1], [0.6, 2.8]
    for i in range(NF):
        z0 = G + FLOOR * i + 0.7
        for name, f in fs.items():
            ss = {'front': front_s, 'right': right_s, 'back': [-2.9, 0.0, 2.9], 'left': [-2.6, 0.0, 2.6]}[name]
            for s in ss:
                window(B, f, s, z0, 1.0, 1.9, lintel=True)
    # Ground floor: arched shop windows under red awnings, an arched door.
    window(B, fs['front'], -3.3, 0.55, 1.6, 2.5, frame='green', key=False, sill=False, arch=True)
    awning(B, fs['front'], -3.3, G - 0.35, 2.2, 0.9, 'red')
    door(B, fs['front'], -1.0, 1.3, 2.7, col='green')
    for s in right_s:
        window(B, fs['right'], s, 0.55, 1.6, 2.5, frame='green', key=False, sill=False, arch=True)
        awning(B, fs['right'], s, G - 0.35, 2.2, 0.9, 'red')
    for name in ('back', 'left'):
        for s in (-2.6, 2.6):
            window(B, fs[name], s, 0.9, 1.1, 1.9)
    rounded_hip(B, hx, hy, eaves + 0.38, 3.4, 'terra')
    for cx, cy in ((-2.2, 2.0), (1.0, 2.6)):
        B.prism(circle(0.42, 8), eaves, eaves + 5.0, 'brick', smooth=True, offset=(cx, cy))
        B.prism(circle(0.55, 8), eaves + 5.0, eaves + 5.25, 'trim', smooth=True, offset=(cx, cy))
    ob = B.finish()
    entry(ob, W + 0.3, D + 0.3, eaves, NF + 1, 'tall')

def bell_mansard():
    # Three storeys of sand render under a bell-curved slate mansard with round dormers.
    B = Builder('Kit_BellMansard', 'yellow', 'slate')
    W, D = 7.2, 8.6
    G, NF = 3.4, 2
    eaves = G + FLOOR * NF
    hx, hy = W / 2, D / 2
    walls_rrect(B, hx, hy, 0.6, eaves, 'yellow')
    B.prism(rrect(hx + 0.1, hy + 0.1, 0.7), -PLINTH, G, 'stone')
    for k in range(1, 6):
        band(B, hx, hy, 0.6, k * 0.62 - 0.08, 0.06, 'plinth', grow=0.12, segs=1)
    band(B, hx, hy, 0.6, G, 0.2, 'trim', grow=0.16)
    band(B, hx, hy, 0.6, eaves, 0.18, 'trim', grow=0.14)
    band(B, hx, hy, 0.6, eaves + 0.18, 0.2, 'trim', grow=0.3)
    fs = facades(W, D)
    for i in range(NF):
        z0 = G + FLOOR * i + 0.7
        for name, f in fs.items():
            for s in ([-1.9, 0.0, 1.9] if name in ('front', 'back') else [-2.6, 0.0, 2.6]):
                window(B, f, s, z0, 0.9, 1.8, shutters='green' if name == 'front' or (i == 0 and name == 'back') else None)
    # Curved balcony on the first floor.
    n, u, off = fs['front']
    pts = [(1.3 * math.cos(a), -off - 0.95 * math.sin(a)) for a in [math.pi * k / 8 for k in range(9)]]
    B.prism([(x, -off + 0.0) for x, _ in pts[:1]] + pts + [(-1.3, -off)], G + 0.2, G + 0.38, 'trim')
    for k in range(9):
        x, y = pts[k]
        B.box(x, y, G + 0.38, 0.05, 0.05, 0.9, 'iron')
    rail = [(1.3 * math.cos(a), -off - 0.95 * math.sin(a)) for a in [math.pi * k / 8 for k in range(9)]]
    for k in range(8):
        (x0, y0), (x1, y1) = rail[k], rail[k + 1]
        c = Vector(((x0 + x1) / 2, (y0 + y1) / 2, G + 1.28))
        dvec = Vector((x1 - x0, y1 - y0, 0))
        B.obox(c, dvec.normalized(), Vector((-dvec.y, dvec.x, 0)).normalized(), dvec.length + 0.05, 0.07, 0.07, 'iron')
    # Ground floor: round-headed door with a fanlight, two shop windows.
    door(B, fs['front'], 0.0, 1.2, 2.6, col='teal', depth=0.14)
    for s in (-1.9, 1.9):
        window(B, fs['front'], s, 0.7, 1.2, 2.2, key=True, depth=0.14, arch=True)
    for name in ('left', 'right', 'back'):
        for s in (-2.4, 2.4):
            window(B, fs[name], s, 0.9, 1.0, 1.9, depth=0.14)
    # The bell mansard: steep, flaring out at the foot, then a low curved top.
    z0 = eaves + 0.38
    rings = []
    prof = [(0.0, 0.0), (0.08, 0.35), (0.22, 0.9), (0.42, 1.6), (0.68, 2.2), (0.95, 2.6)]
    for inset, dz in prof:
        rings.append((rrect(hx + 0.3 - inset, hy + 0.3 - inset, 0.9 - inset * 0.5), z0 + dz))
    for k in range(1, 4):
        t = k / 3
        rings.append((rrect((hx - 0.65) * (1 - 0.55 * t * t), (hy - 0.65) * (1 - 0.4 * t * t), 0.4 + 0.3 * t), z0 + 2.6 + 0.9 * math.sin(t * math.pi / 2)))
    B.prism(rrect(hx + 0.3, hy + 0.3, 0.9), z0 - 0.2, z0, 'slate_dk')
    B.loft(rings, 'slate', smooth=True)
    # Round-roofed dormers with oeil-de-boeuf windows.
    for name, (dn, du, doff) in fs.items():
        for s in ((-1.6, 1.6) if name in ('front', 'back') else (-2.0, 2.0)):
            c = dn * (doff - 0.35) + du * s
            B.obox(c + Z * (z0 + 0.75), du, dn, 1.2, 1.2, 1.5, 'trim')
            # Barrel roof: half cylinder along the dormer's depth.
            segs = 6
            arc = [(0.72 * math.cos(math.pi * k / segs), 0.72 * math.sin(math.pi * k / segs)) for k in range(segs + 1)]
            verts = []
            for dd in (-0.65, 0.65):
                verts += [c + dn * dd + du * x + Z * (z0 + 1.5 + y) for x, y in arc]
            m = segs + 1
            B.poly(verts, [(i, i + 1, m + i + 1, m + i) for i in range(segs)], 'slate_dk', smooth=True)
            B.poly(verts[m:], [tuple(range(m))], 'trim')
            round_window(B, (dn, du, doff + 0.25), s, z0 + 1.0, 0.36)
    for cx in (-1.6, 1.6):
        B.box(cx, 0.0, eaves, 0.6, 0.9, 5.4, 'brick')
        B.box(cx, 0.0, eaves + 5.4, 0.8, 1.1, 0.15, 'trim')
    ob = B.finish()
    entry(ob, W + 0.6, D + 0.6, eaves, NF + 1, 'mid')

def cottage():
    # A small white cottage: a soft, bowed roof with deep rounded eaves, a round bay window, an
    # arched door under a hood and a round chimney.
    B = Builder('Kit_Cottage', 'white', 'terra')
    W, D = 7.6, 7.0
    eaves = 4.4
    hx, hy = W / 2, D / 2
    walls_rrect(B, hx, hy, 0.7, eaves, 'white')
    B.prism(rrect(hx + 0.08, hy + 0.08, 0.78), -PLINTH, 0.45, 'stone')
    fs = facades(W, D)
    # Roof: a bowed gable (ridge along the width) extruded across, the ends hipped back slightly.
    over = 0.55
    segs = 8
    prof = []
    for k in range(segs + 1):
        t = k / segs  # 0 front eave -> 1 back eave
        y = -(hy + over) + 2 * (hy + over) * t
        zz = 3.6 * (math.sin(math.pi * t) ** 0.75)
        prof.append((y, zz))
    rings = []
    xs = [-(hx + over) + 0.5, -(hx + over), hx + over, hx + over - 0.5]
    lifts = [0.85, 1.0, 1.0, 0.85]
    verts = []
    for x, l in zip(xs, lifts):
        verts += [(x, y * (0.92 if l < 1 else 1), eaves - 0.1 + zz * l) for y, zz in prof]
    m = segs + 1
    faces = []
    for r in range(3):
        faces += [(r * m + i, r * m + i + 1, (r + 1) * m + i + 1, (r + 1) * m + i) for i in range(segs)]
    B.poly(verts, faces, 'terra', smooth=True)
    # Gable ends (wall colour) under the roof.
    for x, base in ((-hx, 0), (hx, 2 * m)):
        pts = [(x, y, eaves - 0.1 + zz * 0.97) for y, zz in prof if abs(y) <= hy]
        B.poly([(x, -hy, eaves - 0.1)] + pts + [(x, hy, eaves - 0.1)], [tuple(range(len(pts) + 2))], 'white')
        round_window(B, (Vector((1 if x > 0 else -1, 0, 0)), Vector((0, 1 if x > 0 else -1, 0)), hx), 0.0, eaves + 1.4, 0.45)
    # Round bay window on the front, with a lead dome.
    n, u, off = fs['front']
    br = 1.3
    bc = (-1.4, -hy)
    arc = [(bc[0] + br * math.cos(a), bc[1] - br * 0.8 * math.sin(a)) for a in [math.pi * k / 8 for k in range(9)]]
    B.prism(arc, -PLINTH, 0.8, 'stone', smooth=True)
    B.prism(arc, 0.8, 0.95, 'trim', smooth=True)
    for k in range(8):
        (x0, y0), (x1, y1) = arc[k], arc[k + 1]
        a = Vector((x0, y0, 0))
        b = Vector((x1, y1, 0))
        B.poly([a + Z * 1.0, b + Z * 1.0, b + Z * 2.5, a + Z * 2.5], [(0, 1, 2, 3)], 'glass')
        B.box(x0, y0, 0.95, 0.1, 0.1, 1.6, 'trim')
    B.prism(arc, 2.5, 2.7, 'trim', smooth=True)
    roof_rings = []
    for k in range(4):
        t = k / 3
        roof_rings.append(([(bc[0] + (x - bc[0]) * (1 - 0.85 * t), bc[1] + (y - bc[1]) * (1 - 0.85 * t)) for x, y in arc], 2.7 + 0.7 * math.sin(t * math.pi / 2)))
    B.loft(roof_rings, 'slate', smooth=True)
    door(B, fs['front'], 1.6, 1.15, 2.5, col='teal')
    # Door hood: a small half-round canopy.
    awning(B, fs['front'], 1.6, 3.15, 1.7, 0.55, 'terra', stripes='terra')
    window(B, fs['front'], -1.4, 2.95, 1.0, 1.2, arch=True, sill=True, key=False, shutters='green')
    for name in ('back',):
        for s in (-1.8, 1.8):
            window(B, fs[name], s, 1.0, 1.0, 1.6, shutters='green', key=False)
    for name in ('left', 'right'):
        window(B, fs[name], 0.0, 1.0, 1.0, 1.6, shutters='green', key=False)
    B.prism(circle(0.45, 10), eaves, eaves + 4.6, 'brick', smooth=True, offset=(2.0, 1.4))
    B.prism(circle(0.58, 10), eaves + 4.6, eaves + 4.85, 'trim', smooth=True, offset=(2.0, 1.4))
    ob = B.finish()
    entry(ob, W + 1.1, D + 1.1, eaves, 1, 'small')

def dome_tower():
    # Five storeys with deeply rounded corners, a columned drum and a teal dome with a lantern.
    B = Builder('Kit_DomeTower', 'sand')
    W = D = 8.4
    G, NF = 3.8, 4
    eaves = G + FLOOR * NF
    h = W / 2
    walls_rrect(B, h, h, 1.8, eaves, 'sand', segs=4)
    B.prism(rrect(h + 0.1, h + 0.1, 1.9, 4), -PLINTH, G, 'cream')
    for k in range(1, 6):
        band(B, h, h, 1.8, k * 0.66 - 0.06, 0.06, 'plinth', grow=0.12, segs=2)
    band(B, h, h, 1.8, G, 0.25, 'trim', grow=0.16, segs=4)
    band(B, h, h, 1.8, eaves, 0.25, 'trim', grow=0.2, segs=4)
    band(B, h, h, 1.8, eaves + 0.25, 0.25, 'trim', grow=0.4, segs=4)
    B.prism(rrect(h + 0.3, h + 0.3, 2.1, 4), eaves + 0.5, eaves + 1.0, 'trim')  # parapet
    fs = facades(W, D)
    for i in range(NF):
        z0 = G + FLOOR * i + 0.7
        for name, f in fs.items():
            for s in (-1.3, 1.3):
                window(B, f, s, z0, 0.95, 1.9, lintel=True)
    for name, f in fs.items():
        if name == 'front':
            door(B, f, 0.0, 1.6, 3.0, col='wood', depth=0.14)
            for s in (-2.1, 2.1):
                window(B, f, s, 0.8, 0.9, 2.2, depth=0.14, arch=True)
        else:
            for s in (-1.4, 1.4):
                window(B, f, s, 0.8, 1.0, 2.2, depth=0.14, arch=True)
    # Drum with round windows, dome, lantern.
    zd = eaves + 1.0
    B.prism(circle(3.0, 16), eaves + 0.5, zd + 2.2, 'cream', smooth=True)
    B.prism(circle(3.2, 16), zd + 2.2, zd + 2.5, 'trim', smooth=True)
    for k in range(6):
        ang = -math.pi / 2 + k * math.pi / 3
        n = Vector((math.cos(ang), math.sin(ang), 0))
        u = Vector((-n.y, n.x, 0))
        round_window(B, (n, u, 2.95), 0.0, zd + 1.1, 0.45)
    B.dome(0, 0, 3.1, zd + 2.5, 'teal', n=16, rings=6, sz=1.15)
    zl = zd + 2.5 + 3.1 * 1.15
    B.prism(circle(0.7, 8), zl - 0.2, zl + 1.0, 'trim', smooth=True)
    B.dome(0, 0, 0.75, zl + 1.0, 'teal', n=8, rings=3)
    B.box(0, 0, zl + 1.7, 0.1, 0.1, 1.0, 'gold')
    ob = B.finish()
    entry(ob, W + 0.8, D + 0.8, eaves, NF + 1, 'rare')

def dutch_gable():
    # Three storeys of brick with a curly Dutch gable to the street (and the back), white arched
    # windows and half-round green awnings over the shop.
    B = Builder('Kit_DutchGable', 'brick', 'slate')
    W, D = 8.0, 9.4
    G, NF = 3.6, 2
    eaves = G + FLOOR * NF
    hx, hy = W / 2, D / 2
    walls_rrect(B, hx, hy, 0.25, eaves, 'brick')
    B.prism(rrect(hx + 0.08, hy + 0.08, 0.33), -PLINTH, 0.5, 'plinth')
    band(B, hx, hy, 0.25, G - 0.1, 0.22, 'trim', grow=0.1)
    band(B, hx, hy, 0.25, eaves - 0.1, 0.22, 'trim', grow=0.12)
    # The gable: a scrolled outline, symmetric, from the eaves up.
    half = [(4.0, 0.0), (4.0, 0.25), (3.55, 0.45), (3.25, 0.8), (3.2, 1.3), (3.15, 2.2), (2.75, 2.45), (2.35, 2.75), (2.1, 3.3), (2.05, 4.2), (1.7, 4.5), (1.2, 4.85), (0.7, 5.25), (0.35, 5.55), (0.0, 5.65)]
    half = [(x * W / 8.0, z) for x, z in half]
    outline = [(-x, z) for x, z in half] + [(x, z) for x, z in reversed(half)][1:]
    outline = list(reversed(outline))  # clockwise seen from the front -> left to right along the top
    for ysign in (-1, 1):
        y0 = ysign * hy
        pts3 = [Vector((x, y0, eaves + z)) for x, z in outline]
        back = [p - Vector((0, ysign * 0.4, 0)) for p in pts3]
        mcount = len(pts3)
        B.poly(pts3, [tuple(range(mcount))], 'brick')
        B.poly(back, [tuple(range(mcount))], 'brick')
        side = []
        for i in range(mcount - 1):
            side.append((i, i + 1, mcount + i + 1, mcount + i))
        B.poly(pts3 + back, side, 'trim')
        # Coping caps on the scroll steps and a round window in the gable.
        f = (Vector((0, ysign, 0)), Vector((-ysign, 0, 0)), hy)
        round_window(B, f, 0.0, eaves + 2.3, 0.6, segs=10)
        B.box(0.0, y0 + ysign * 0.05, eaves + 5.65, 0.35, 0.5, 0.45, 'trim')
    # The roof between the gables: ridge along the depth, below the gable outline.
    rise, over = 4.6, 0.3
    for s in (-1, 1):
        B.poly([(s * (hx + over), -hy + 0.2, eaves - 0.15), (s * (hx + over), hy - 0.2, eaves - 0.15), (0, hy - 0.2, eaves + rise), (0, -hy + 0.2, eaves + rise)], [(0, 1, 2, 3)], 'slate')
    fs = facades(W, D)
    for i in range(NF):
        z0 = G + FLOOR * i + 0.7
        for name, f in fs.items():
            for s in ([-2.4, 0.0, 2.4] if name in ('front', 'back') else [-3.0, -1.0, 1.0, 3.0]):
                window(B, f, s, z0, 0.95, 1.9, frame='white')
    # Gable windows.
    for f in (fs['front'], fs['back']):
        for s in (-1.3, 1.3):
            window(B, f, s, eaves + 0.5, 0.7, 1.3, frame='white')
    # Ground floor shop.
    for s in (-2.3, 2.3):
        window(B, fs['front'], s, 0.55, 2.0, 2.4, frame='green', sill=False, segs=4, arch=True)
        awning(B, fs['front'], s, G - 0.25, 2.6, 1.0, 'green', stripes='white')
    door(B, fs['front'], 0.0, 1.1, 2.6, col='wood')
    for name in ('back', 'left', 'right'):
        for s in ((-2.0, 2.0) if name == 'back' else (-2.6, 0.0, 2.6)):
            window(B, fs[name], s, 0.9, 1.0, 1.9, frame='white')
    B.box(0.0, hy - 1.4, eaves, 0.7, 0.7, rise + 1.2, 'brick_dk')
    ob = B.finish()
    entry(ob, W + 0.6, D + 0.8, eaves, NF + 1, 'mid', paint='brick')

def flat_awning(B, f, s, z_top, w, out, col, stripes='trim', drop=0.55):
    # A straight canvas awning sloping out from the wall, with a striped valance.
    n, u, off = f
    q = [n * off + u * (s - w / 2) + Z * z_top, n * off + u * (s + w / 2) + Z * z_top,
         n * (off + out) + u * (s + w / 2) + Z * (z_top - drop), n * (off + out) + u * (s - w / 2) + Z * (z_top - drop)]
    B.poly(q + [p - Z * 0.05 for p in q], [(0, 1, 2, 3), (7, 6, 5, 4), (3, 2, 6, 7)], col)
    for k in range(int(w / 0.5)):
        B.obox(n * (off + out) + u * (s - w / 2 + 0.25 + k * 0.5) + Z * (z_top - drop - 0.15), u, n, 0.46, 0.04, 0.28, stripes if k % 2 else col)

def rooftop(B, hx, hy, z, seed=0):
    # Rooftop clutter on a flat roof: a stair house, air-conditioning boxes, a skylight, a water
    # tank or an aerial.
    B.box(-hx * 0.45, hy * 0.25, z, 2.4, 2.6, 2.4, 'machine')
    B.box(-hx * 0.45, hy * 0.25, z + 2.4, 2.7, 2.9, 0.15, 'flat')
    B.box(-hx * 0.45 + 1.21, hy * 0.25, z, 0.02, 1.0, 2.0, 'wood')
    for k, (ax, ay) in enumerate(((0.35, -0.35), (0.55, -0.1), (0.15, 0.45))):
        B.box(hx * ax, hy * ay, z, 1.2, 0.9, 0.8, 'machine')
        B.box(hx * ax, hy * ay, z + 0.8, 0.9, 0.6, 0.05, 'iron')
    # Skylight: a glass ridge.
    sx, sy = hx * 0.1, -hy * 0.45
    B.poly([(sx - 1.2, sy - 0.7, z), (sx + 1.2, sy - 0.7, z), (sx + 1.2, sy, z + 0.6), (sx - 1.2, sy, z + 0.6),
            (sx + 1.2, sy + 0.7, z), (sx - 1.2, sy + 0.7, z)], [(0, 1, 2, 3), (3, 2, 4, 5)], 'glass')
    B.poly([(sx - 1.2, sy - 0.7, z), (sx - 1.2, sy, z + 0.6), (sx - 1.2, sy + 0.7, z), (sx + 1.2, sy - 0.7, z), (sx + 1.2, sy, z + 0.6), (sx + 1.2, sy + 0.7, z)], [(0, 1, 2), (5, 4, 3)], 'machine')
    if seed % 2:
        B.prism(circle(0.9, 8), z + 1.2, z + 3.0, 'wood', smooth=True, offset=(hx * 0.5, hy * 0.5))
        B.cone(hx * 0.5, hy * 0.5, 1.0, z + 3.0, 0.6, 'iron', n=8)
        for ax, ay in ((-0.6, -0.6), (0.6, -0.6), (0.6, 0.6), (-0.6, 0.6)):
            B.box(hx * 0.5 + ax, hy * 0.5 + ay, z, 0.12, 0.12, 1.2, 'iron')
    else:
        B.box(hx * 0.6, hy * 0.6, z, 0.08, 0.08, 4.0, 'iron')
        B.box(hx * 0.6, hy * 0.6, z + 3.2, 1.4, 0.06, 0.06, 'iron')
        B.box(hx * 0.6, hy * 0.6, z + 3.7, 0.9, 0.06, 0.06, 'iron')

def parapet(B, hx, hy, z, h, col, roof='flat'):
    # A flat roof inside a parapet wall.
    B.box(0, 0, z - 0.05, 2 * hx - 0.3, 2 * hy - 0.3, 0.1, roof)
    for (cx, cy, sx, sy) in ((0, -hy + 0.12, 2 * hx, 0.24), (0, hy - 0.12, 2 * hx, 0.24), (-hx + 0.12, 0, 0.24, 2 * hy), (hx - 0.12, 0, 0.24, 2 * hy)):
        B.box(cx, cy, z, sx, sy, h, col)
        B.box(cx, cy, z + h, sx + (0.2 if sx > sy else 0.1), sy + (0.2 if sy > sx else 0.1), 0.12, 'trim')

def shopfronts(B, f, ss, G, w=2.0, frame='green', awning_cols=('red', 'green')):
    for k, s in enumerate(ss):
        window(B, f, s, 0.45, w, G - 1.3, frame=frame, sill=False)
        flat_awning(B, f, s, G - 0.55, w + 0.4, 1.1, awning_cols[k % len(awning_cols)])

def flat_block():
    # A wide five-storey block of cream stucco, the everyday building of the reference: shops under
    # awnings, a regular grid of windows, cornice, parapet and a cluttered flat roof.
    B = Builder('Kit_FlatBlock', 'stucco')
    W, D = 13.0, 10.5
    G, NF = 3.8, 4
    eaves = G + FLOOR * NF
    hx, hy = W / 2, D / 2
    walls_rrect(B, hx, hy, 0.15, eaves, 'stucco', segs=1)
    B.prism(rrect(hx + 0.08, hy + 0.08, 0.2, 1), -PLINTH, 0.4, 'plinth')
    band(B, hx, hy, 0.15, G - 0.2, 0.3, 'trim', grow=0.12, segs=1)
    band(B, hx, hy, 0.15, G + FLOOR - 0.1, 0.14, 'trim', grow=0.08, segs=1)
    band(B, hx, hy, 0.15, eaves - 0.1, 0.35, 'trim', grow=0.25, segs=1)
    fs = facades(W, D)
    front = [-4.8, -2.4, 0.0, 2.4, 4.8]
    side = [-3.2, -1.1, 1.1, 3.2]
    for i in range(NF):
        z0 = G + FLOOR * i + 0.75
        for name, f in fs.items():
            for s in (front if name in ('front', 'back') else side):
                window(B, f, s, z0, 1.05, 1.75, lintel=(i < NF - 1) and name != 'back', bars=name != 'back', sill=True)
    shopfronts(B, fs['front'], [-4.6, -1.8, 3.6], G, w=2.2)
    door(B, fs['front'], 1.0, 1.2, 2.6, col='wood')
    shopfronts(B, fs['right'], [-2.6, 1.6], G, w=2.4, awning_cols=('green',))
    for name in ('left', 'back'):
        for s in ((-3.6, 0.0, 3.6) if name == 'back' else (-2.4, 2.4)):
            window(B, fs[name], s, 0.9, 1.1, 1.9, bars=False)
    parapet(B, hx + 0.1, hy + 0.1, eaves + 0.25, 0.8, 'stucco')
    rooftop(B, hx, hy, eaves + 0.25, seed=0)
    ob = B.finish()
    entry(ob, W, D, eaves, NF + 1, 'tall', stretch=True)

def slate_block():
    # Four storeys of grey stone under a straight slate mansard with gabled dormers, iron balconies
    # on the first floor: the grey-roofed blocks of the reference.
    B = Builder('Kit_SlateBlock', 'greystone', 'slate')
    W, D = 12.0, 10.5
    G, NF = 3.8, 3
    eaves = G + FLOOR * NF
    hx, hy = W / 2, D / 2
    walls_rrect(B, hx, hy, 0.15, eaves, 'greystone', segs=1)
    B.prism(rrect(hx + 0.1, hy + 0.1, 0.2, 1), -PLINTH, G - 0.2, 'stone')
    for k in range(1, 6):
        band(B, hx, hy, 0.15, k * 0.6 - 0.05, 0.05, 'plinth', grow=0.12, segs=1)
    band(B, hx, hy, 0.15, G - 0.2, 0.3, 'trim', grow=0.15, segs=1)
    band(B, hx, hy, 0.15, eaves - 0.15, 0.45, 'trim', grow=0.3, segs=1)
    for sx in (-1, 1):
        for sy in (-1, 1):
            B.box(sx * (hx - 0.25), sy * (hy - 0.25), G, 0.6, 0.6, eaves - G, 'trim')
    fs = facades(W, D)
    front = [-4.2, -2.1, 0.0, 2.1, 4.2]
    side = [-3.2, -1.1, 1.1, 3.2]
    for i in range(NF):
        z0 = G + FLOOR * i + 0.7
        for name, f in fs.items():
            for s in (front if name in ('front', 'back') else side):
                tall = i == 0 and name == 'front'
                window(B, f, s, z0 - (0.45 if tall else 0), 1.0, 1.85 + (0.45 if tall else 0), lintel=True, bars=name != 'back', sill=not tall)
    # Iron balconies on the first floor of the front.
    n, u, off = fs['front']
    for s in front:
        B.obox(n * (off + 0.35) + u * s + Z * (G + 0.25), u, n, 1.6, 0.7, 0.14, 'trim')
        B.obox(n * (off + 0.68) + u * s + Z * (G + 1.25), u, n, 1.6, 0.05, 0.05, 'iron')
        for k in range(7):
            B.obox(n * (off + 0.68) + u * (s - 0.75 + k * 0.25) + Z * (G + 0.8), u, n, 0.04, 0.04, 0.9, 'iron')
    for s in (-4.2, -2.1, 2.1, 4.2):
        window(B, fs['front'], s, 0.6, 1.3, 2.4, frame='trim', sill=False, arch=True, depth=0.12)
    door(B, fs['front'], 0.0, 1.5, 3.0, col='wood', depth=0.14)
    for name in ('back', 'left', 'right'):
        for s in ((-4.2, 0.0, 4.2) if name == 'back' else (-2.6, 2.6)):
            window(B, fs[name], s, 0.8, 1.1, 2.0, depth=0.12, bars=False)
    # Straight mansard: steep lower slope, then a low hip.
    z0 = eaves + 0.3
    lower = [(rrect(hx + 0.2, hy + 0.2, 0.3, 1), z0), (rrect(hx - 0.6, hy - 0.6, 0.2, 1), z0 + 2.7)]
    B.prism(rrect(hx + 0.2, hy + 0.2, 0.3, 1), z0 - 0.2, z0, 'slate_dk')
    B.loft(lower, 'slate', cap=False)
    rounded_hip(B, hx - 0.6, hy - 0.6, z0 + 2.7, 1.2, 'slate', r=0.2, over=0.0)
    # Gabled dormers.
    for name, (dn, du, doff) in fs.items():
        for s in ((-3.6, 0.0, 3.6) if name in ('front', 'back') else (-2.4, 2.4)):
            c = dn * (doff - 0.35) + du * s
            B.obox(c + Z * (z0 + 0.8), du, dn, 1.2, 1.3, 1.6, 'greystone')
            B.poly([c + dn * 0.65 + du * -0.75 + Z * (z0 + 1.6), c + dn * 0.65 + du * 0.75 + Z * (z0 + 1.6), c + dn * 0.65 + Z * (z0 + 2.3),
                    c - dn * 0.65 + du * -0.75 + Z * (z0 + 1.6), c - dn * 0.65 + du * 0.75 + Z * (z0 + 1.6), c - dn * 0.65 + Z * (z0 + 2.3)],
                   [(0, 2, 5, 3), (1, 4, 5, 2)], 'slate_dk')
            B.poly([c + dn * 0.65 + du * -0.6 + Z * (z0 + 1.6), c + dn * 0.65 + du * 0.6 + Z * (z0 + 1.6), c + dn * 0.65 + Z * (z0 + 2.2)], [(0, 1, 2)], 'trim')
            window(B, (dn, du, doff + 0.3), s, z0 + 0.35, 0.65, 1.0, bars=False, sill=False)
    for cx, cy in ((-2.8, 1.5), (2.8, -1.5)):
        B.box(cx, cy, eaves, 0.7, 1.4, 5.6, 'brick')
        B.box(cx, cy, eaves + 5.6, 0.9, 1.6, 0.15, 'trim')
    ob = B.finish()
    entry(ob, W, D, eaves, NF + 1, 'tall', stretch=True)

def brick_works():
    # A red-brown brick block: pilasters between the bays, big arched openings below, white
    # windows above, a flat roof with a water tank.
    B = Builder('Kit_BrickWorks', 'brick')
    W, D = 11.0, 10.0
    G, NF = 4.2, 3
    eaves = G + FLOOR * NF
    hx, hy = W / 2, D / 2
    walls_rrect(B, hx, hy, 0.1, eaves, 'brick', segs=1)
    B.prism(rrect(hx + 0.08, hy + 0.08, 0.15, 1), -PLINTH, 0.6, 'stone')
    fs = facades(W, D)
    bays = [-3.75, -1.25, 1.25, 3.75]
    sbays = [-3.4, -1.1, 1.1, 3.4]
    for name, (n, u, off) in fs.items():
        L = W if name in ('front', 'back') else D
        nb = len(bays) if name in ('front', 'back') else len(sbays)
        step = L / nb
        for k in range(nb + 1):
            s = -L / 2 + k * step
            B.obox(n * (off + 0.12) + u * s + Z * (eaves / 2), u, n, 0.5, 0.24, eaves, 'brick_dk')
    band(B, hx, hy, 0.1, G - 0.15, 0.25, 'stone', grow=0.25, segs=1)
    band(B, hx, hy, 0.1, eaves - 0.2, 0.5, 'brick_dk', grow=0.3, segs=1)
    for i in range(NF):
        z0 = G + FLOOR * i + 0.7
        for name, f in fs.items():
            for s in (bays if name in ('front', 'back') else sbays):
                window(B, f, s, z0, 1.3, 1.8, frame='white', bars=name != 'back', depth=0.0)
    for name, f in fs.items():
        for s in (bays if name in ('front', 'back') else sbays[1:3]):
            if name == 'front' and s == 1.25:
                door(B, f, s, 1.6, 3.2, col='green', frame='stone', depth=0.0)
            else:
                window(B, f, s, 0.7, 1.7, 2.9, frame='stone', arch=True, sill=False, segs=4)
    parapet(B, hx, hy, eaves + 0.3, 0.5, 'brick_dk')
    rooftop(B, hx, hy, eaves + 0.3, seed=1)
    ob = B.finish()
    entry(ob, W, D, eaves, NF + 1, 'mid', paint='brick', stretch=True)

def townhouse():
    # A narrow four-storey house with its gable to the street and a steep tile roof: the narrow
    # fronts that close up a row.
    B = Builder('Kit_Townhouse', 'stucco', 'terra')
    W, D = 6.0, 10.0
    G, NF = 3.5, 3
    eaves = G + FLOOR * NF
    hx, hy = W / 2, D / 2
    walls_rrect(B, hx, hy, 0.05, eaves, 'stucco', segs=1)
    B.prism(rrect(hx + 0.06, hy + 0.06, 0.1, 1), -PLINTH, 0.5, 'plinth')
    band(B, hx, hy, 0.05, G - 0.15, 0.25, 'trim', grow=0.1, segs=1)
    band(B, hx, hy, 0.05, eaves - 0.1, 0.25, 'trim', grow=0.15, segs=1)
    fs = facades(W, D)
    for i in range(NF):
        z0 = G + FLOOR * i + 0.7
        for s in (-1.3, 1.3):
            window(B, fs['front'], s, z0, 1.0, 1.8, lintel=True, shutters='green' if i else None)
            window(B, fs['back'], s, z0, 1.0, 1.8, bars=False)
        for name in ('left', 'right'):
            window(B, fs[name], 0.0, z0, 0.9, 1.6, bars=False)
    window(B, fs['front'], -1.3, 0.6, 1.8, 2.3, frame='green', sill=False)
    flat_awning(B, fs['front'], -1.3, G - 0.5, 2.2, 1.0, 'red')
    door(B, fs['front'], 1.4, 1.1, 2.5, col='teal')
    # Steep roof, ridge from front to back, gable ends to the street and the yard.
    rise, over = 4.2, 0.35
    for sx in (-1, 1):
        B.poly([(sx * (hx + over), -hy - over, eaves - 0.25), (sx * (hx + over), hy + over, eaves - 0.25), (0, hy + over, eaves + rise), (0, -hy - over, eaves + rise)], [(0, 1, 2, 3)], 'terra')
        B.poly([(sx * (hx + over), -hy - over, eaves - 0.25), (sx * (hx + over), hy + over, eaves - 0.25), (sx * (hx + over), hy + over, eaves - 0.45), (sx * (hx + over), -hy - over, eaves - 0.45)], [(0, 1, 2, 3)], 'terra_dk')
    for sy in (-1, 1):
        B.poly([(-hx, sy * hy, eaves - 0.1), (hx, sy * hy, eaves - 0.1), (0, sy * hy, eaves + rise * (hx / (hx + over)) - 0.2)], [(0, 1, 2)], 'stucco')
        window(B, (Vector((0, sy, 0)), Vector((-sy, 0, 0)), hy), 0.0, eaves + 0.5, 0.9, 1.4, bars=False)
    B.box(1.2, 2.5, eaves, 0.6, 0.6, rise + 1.0, 'brick')
    ob = B.finish()
    entry(ob, W, D, eaves, NF + 1, 'mid', stretch=True)

def glass_block():
    # The one modern building: a turquoise glass curtain wall between white fins and floor bands,
    # on a recessed ground floor, machinery on its flat roof.
    B = Builder('Kit_GlassBlock', None)
    W, D = 10.0, 10.0
    G, NF = 4.2, 6
    eaves = G + 3.4 * NF
    hx, hy = W / 2, D / 2
    B.prism(rrect(hx - 0.6, hy - 0.6, 0.1, 1), -PLINTH, G, 'machine')
    # Curtain wall: one glass box, white fins and floor bands proud of it.
    B.prism(rrect(hx, hy, 0.05, 1), G, eaves, 'aqua')
    for name, (n, u, off) in facades(W, D).items():
        L = W
        for k in range(8):
            s = -L / 2 + 0.05 + k * (L - 0.1) / 7
            B.obox(n * (off + 0.08) + u * s + Z * ((G + eaves) / 2), u, n, 0.14, 0.16, eaves - G, 'mullion')
        for k in range(NF + 1):
            B.obox(n * (off + 0.08) + Z * (G + 3.4 * k), u, n, L + 0.1, 0.16, 0.3, 'mullion')
        # Ground floor glazing under the overhang, pillars at the corners.
        B.obox(n * (off - 0.62) + Z * (G / 2), u, n, L - 1.3, 0.04, G - 0.4, 'glass')
    for sx in (-1, 1):
        for sy in (-1, 1):
            B.box(sx * (hx - 0.3), sy * (hy - 0.3), -PLINTH, 0.5, 0.5, G + PLINTH, 'mullion')
    B.box(0, -hy + 0.3, G - 0.6, W, 0.6, 0.6, 'mullion')
    B.box(0, 0, eaves, W + 0.2, D + 0.2, 0.5, 'mullion')
    B.box(0, 0, eaves + 0.5, 4.5, 3.5, 2.2, 'machine')
    for k in range(3):
        B.prism(circle(0.5, 8), eaves + 2.7, eaves + 3.1, 'iron', offset=(-1.4 + k * 1.4, 0.0))
    ob = B.finish()
    # Its glass is the facade itself: mark the aqua panels as glass for the game.
    entry(ob, W, D, eaves, NF + 1, 'rare', paint='none')

turret_corner()
bell_mansard()
cottage()
dome_tower()
dutch_gable()
flat_block()
slate_block()
brick_works()
townhouse()
glass_block()

objs = [bpy.data.objects[k['name']] for k in KIT]
for k, o in zip(KIT, objs):
    me = o.data
    # The solid footprint (what a car would hit: walls, plinth, steps, bays and turrets near the
    # ground, not the awnings or the roof's eaves above) is the physics box: centre the model on
    # it and list its size.
    low = []
    for poly in me.polygons:
        zs = [me.vertices[i].co.z for i in poly.vertices]
        if min(zs) < 2.0 and max(zs) > -0.5:
            low += [me.vertices[i].co for i in poly.vertices]
    x0, x1 = min(c.x for c in low), max(c.x for c in low)
    y0, y1 = min(c.y for c in low), max(c.y for c in low)
    shift = Vector(((x0 + x1) / 2, (y0 + y1) / 2, 0))
    for v in me.vertices:
        v.co -= shift
    k['w'], k['d'] = round(x1 - x0, 2), round(y1 - y0, 2)
    me.update()
    k['tris'] = sum(len(p.vertices) - 2 for p in me.polygons)
    k['top'] = round(max(v.co.z for v in me.vertices), 2)
    me.color_attributes.active_color = me.color_attributes['Col']

# Export all kit buildings into one .glb (each its own node, at the origin).
bpy.context.view_layer.update()
for o in bpy.data.objects:
    o.select_set(o in objs)
bpy.context.view_layer.objects.active = objs[0]
bpy.ops.export_scene.gltf(filepath=GLB, use_selection=True, export_format='GLB', export_apply=True,
                          export_vertex_color='NAME', export_vertex_color_name='Col', export_all_vertex_colors=False, export_materials='EXPORT', export_yup=True)

if MANIFEST:
    with open(MANIFEST, 'w') as fh:
        fh.write('// Generated by scripts/town-kit/build_kit.py (do not edit): the sunny town\'s building kit in\n')
        fh.write('// public/models/town-kit.glb. Per building: its footprint (w along the street, d away from it,\n')
        fh.write('// in m), the height of its eaves above the ground (the physics box\'s top), the highest point\n')
        fh.write('// of its roof, its storeys, which lots it suits (small, mid, tall or rare), the palette its\n')
        fh.write('// walls are repainted from, and whether it may be stretched along the street.\n')
        fh.write('export const TOWN_KIT = [\n')
        for k in KIT:
            fh.write(f"  {{ name: '{k['name']}', w: {k['w']}, d: {k['d']}, eaves: {k['eaves']}, top: {k['top']}, storeys: {k['storeys']}, size: '{k['size']}', paint: '{k['paint']}', stretch: {str(k['stretch']).lower()}, tris: {k['tris']} }},\n")
        fh.write('];\n')

if RENDER:
    # A contact sheet of the kit for review.
    import os
    x = 0.0
    for o in objs:
        w = o.dimensions.x
        o.location = (x + w / 2, 0, 0)
        x += w + 3
    sc = bpy.context.scene
    cx = x / 2 - 1.5
    me = bpy.data.meshes.new('Ground')
    me.from_pydata([(-100, -100, 0), (100, -100, 0), (100, 100, 0), (-100, 100, 0)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new('Ground', me)
    sc.collection.objects.link(g)
    gm = bpy.data.materials.new('GroundMat')
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.25, 0.32, 0.2, 1)
    me.materials.append(gm)
    ld = bpy.data.lights.new('Sun', 'SUN'); ld.energy = 4.0; ld.angle = math.radians(3)
    sun = bpy.data.objects.new('Sun', ld); sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))
    w = sc.world or bpy.data.worlds.new('World'); sc.world = w
    bg = w.node_tree.nodes.get('Background')
    bg.inputs[0].default_value = (0.62, 0.75, 0.92, 1); bg.inputs[1].default_value = 0.9
    for name, ang in (('front', 28), ('back', 208)):
        cd = bpy.data.cameras.new(name); cd.type = 'ORTHO'; cd.ortho_scale = x * 0.92
        cam = bpy.data.objects.new(name, cd); sc.collection.objects.link(cam)
        a = math.radians(ang)
        target = Vector((cx, 0, 7))
        cam.location = target + Vector((math.sin(a) * 60, -math.cos(a) * 60, 38))
        cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.camera = cam
        sc.render.engine = 'BLENDER_EEVEE'
        sc.render.resolution_x, sc.render.resolution_y = 2000, 900
        sc.view_settings.view_transform = 'AgX'
        sc.render.filepath = os.path.join(RENDER, f'kit_{name}.png')
        bpy.ops.render.render(write_still=True)

result = {'kit': KIT}
print(json.dumps(KIT))
