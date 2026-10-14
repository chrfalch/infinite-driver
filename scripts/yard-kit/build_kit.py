# Builds the sunny town's yard kit (src/terrain/yard-kit.js, public/models/yard-kit.glb): the
# things that stand in front of the houses (crates, a café table with chairs and a parasol,
# benches, planters and pots, bins, mailboxes, fences and hedges, a bicycle, a wheelbarrow, a
# doghouse, a gnome), in the same rounded, diorama-like look and colours as the building kit
# (scripts/town-kit/build_kit.py), modelled from code so they can be tweaked and re-run:
#
#   blender -b --python scripts/yard-kit/build_kit.py -- public/models/yard-kit.glb src/terrain/yard-kit.js [render dir]
#
# Each prop is one mesh object named after its kit entry, in Blender's axes (z up) with the front
# facing -y and the origin on the ground in the middle of its footprint; the exporter turns that to
# glTF's y up, the front facing +z. Colours are baked into a colour attribute (COLOR_0), its alpha
# 0.5 on the prop's main colour (which the game may repaint per prop) and 1 elsewhere; the lamp's
# glass is its own material (Glow), so the game can light it at night.
import bpy, bmesh, json, math, sys
from mathutils import Vector, noise

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = argv[0] if argv else 'yard-kit.glb'
MANIFEST = argv[1] if len(argv) > 1 else None
RENDER = argv[2] if len(argv) > 2 else None

X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
    for d in list(coll):
        if d.users == 0:
            coll.remove(d)

def srgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))

# Authoring colours (sRGB); baked into the colour attribute. Shared with the building kit where
# they overlap (terracotta, trim, iron, wood).
C = dict(
    wood='#b98550', wood_dk='#7d5530', wood_lt='#d6a874', plank='#a8794a', iron='#2c2c30', steel='#a7adb3',
    white='#f3eee3', trim='#f6f1e6', cream='#ecd3a2', terra='#c9552e', terra_dk='#9a3d22', pot='#c8693e', pot_dk='#a0522f',
    leaf='#4f8a3c', leaf_dk='#3a6b2e', leaf_lt='#6fa64b', hedge='#467f38', soil='#4a3526',
    pink='#e86a9a', yellow='#f2c94c', purple='#8e5cc2', orange='#f08a24', red='#c23b2e', blue='#3b6fb6',
    bin='#2f6b45', bin_dk='#24553a', rubber='#1f1f22', canvas='#efe7d3', stripe='#d24b3e',
    sage='#5f8f78', mail='#3f5a78', skin='#f0c09a', beard='#f4f1ea', glow='#fff2c0', stone='#a39a88',
)

class Builder:
    def __init__(self, name, main=None):
        self.name = name
        self.main = main  # the prop's main colour (marked in the colour's alpha), or None
        self.bm = bmesh.new()
        self.color = self.bm.loops.layers.color.new('Col')

    def poly(self, verts, faces, col, smooth=False):
        vs = [self.bm.verts.new(Vector(v)) for v in verts]
        rgb = (*srgb(C[col]), 0.5 if col == self.main else 1.0)
        for f in faces:
            face = self.bm.faces.new([vs[i] for i in f])
            face.smooth = smooth
            face.material_index = 1 if col == 'glow' else 0
            for loop in face.loops:
                loop[self.color] = rgb

    # A box with its own axes: u along it, n across it, w up it (sizes su, sn, sw), centre c.
    def obox(self, c, u, n, su, sn, sw, col, w=Z):
        c, u, n, w = Vector(c), Vector(u), Vector(n), Vector(w)
        v = []
        for dw in (-0.5, 0.5):
            for du, dn in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
                v.append(c + u * su * du + n * sn * dn + w * sw * dw)
        self.poly(v, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], col)

    def box(self, cx, cy, z0, sx, sy, sz, col):
        self.obox((cx, cy, z0 + sz / 2), X, Y, sx, sy, sz, col)

    # A plank from a to b (its width across `n`, its thickness the rest).
    def beam(self, a, b, width, thick, col, n=None):
        a, b = Vector(a), Vector(b)
        u = (b - a).normalized()
        n = Vector(n) if n is not None else perp(u)
        n = (n - u * n.dot(u)).normalized()
        self.obox((a + b) / 2, u, n, (b - a).length, width, thick, col, w=u.cross(n))

    # A loft through rings of 2D points (same count, counter-clockwise) at heights.
    def loft(self, rings, col, smooth=False, top=True, bottom=False, offset=(0, 0)):
        ox, oy = offset
        n = len(rings[0][0])
        verts = []
        for pts, z in rings:
            verts += [(ox + x, oy + y, z) for x, y in pts]
        faces = []
        for r in range(len(rings) - 1):
            a, b = r * n, (r + 1) * n
            faces += [(a + i, a + (i + 1) % n, b + (i + 1) % n, b + i) for i in range(n)]
        self.poly(verts, faces, col, smooth)
        if top:
            self.poly([(ox + x, oy + y, rings[-1][1]) for x, y in rings[-1][0]], [tuple(range(n))], col)
        if bottom:
            self.poly([(ox + x, oy + y, rings[0][1]) for x, y in rings[0][0]], [tuple(range(n))[::-1]], col)

    def cyl(self, cx, cy, r, z0, z1, col, n=12, smooth=True, bottom=False):
        self.loft([(circle(r, n), z0), (circle(r, n), z1)], col, smooth, True, bottom, (cx, cy))

    # A round rod from a to b, capped.
    def tube(self, a, b, r, col, n=6):
        a, b = Vector(a), Vector(b)
        u = (b - a).normalized()
        p = perp(u)
        q = u.cross(p)
        ring = [p * math.cos(2 * math.pi * i / n) * r + q * math.sin(2 * math.pi * i / n) * r for i in range(n)]
        verts = [a + d for d in ring] + [b + d for d in ring]
        faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        faces += [tuple(range(n))[::-1], tuple(range(n, 2 * n))]
        self.poly(verts, faces, col, smooth=True)

    # A ring (a tyre or a hoop) around `axis` through c: radius R, tube radius r.
    def torus(self, c, axis, R, r, col, n=16, m=6):
        c, axis = Vector(c), Vector(axis).normalized()
        p = perp(axis)
        q = axis.cross(p)
        verts = []
        for i in range(n):
            a = 2 * math.pi * i / n
            radial = p * math.cos(a) + q * math.sin(a)
            for j in range(m):
                b = 2 * math.pi * j / m
                verts.append(c + radial * (R + r * math.cos(b)) + axis * r * math.sin(b))
        faces = [(i * m + j, i * m + (j + 1) % m, ((i + 1) % n) * m + (j + 1) % m, ((i + 1) % n) * m + j) for i in range(n) for j in range(m)]
        self.poly(verts, faces, col, smooth=True)

    # A sphere squashed by (sx, sy, sz).
    def sphere(self, c, r, col, n=10, rings=6, s=(1, 1, 1)):
        c = Vector(c)
        verts = [c + Vector((0, 0, -r * s[2]))]
        for k in range(1, rings):
            phi = -math.pi / 2 + math.pi * k / rings
            verts += [c + Vector((x * s[0], y * s[1], r * math.sin(phi) * s[2])) for x, y in circle(r * math.cos(phi), n)]
        verts.append(c + Vector((0, 0, r * s[2])))
        top = len(verts) - 1
        faces = [(0, 1 + (i + 1) % n, 1 + i) for i in range(n)]
        for k in range(rings - 2):
            a, b = 1 + k * n, 1 + (k + 1) * n
            faces += [(a + i, a + (i + 1) % n, b + (i + 1) % n, b + i) for i in range(n)]
        a = 1 + (rings - 2) * n
        faces += [(a + i, a + (i + 1) % n, top) for i in range(n)]
        self.poly(verts, faces, col, smooth=True)

    # A lumpy blob of leaves: a subdivided box of size (sx, sy, sz) pushed out to a rounded shape
    # and roughened with noise (seeded, so a re-run gives the same shape).
    def blob(self, c, size, col, seed=0, cuts=3, rough=0.12, round_=0.55, freq=3.0):
        c = Vector(c)
        tmp = bmesh.new()
        bmesh.ops.create_cube(tmp, size=1.0)
        bmesh.ops.subdivide_edges(tmp, edges=tmp.edges[:], cuts=cuts, use_grid_fill=True)
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        off = Vector((seed * 7.31, seed * 3.17, seed * 5.93))
        for v in tmp.verts:
            d = v.co.normalized()
            box = Vector((v.co.x * 2, v.co.y * 2, v.co.z * 2))
            p = box.lerp(d, round_)  # between a box (0) and a ball (1)
            p = Vector((p.x * hx, p.y * hy, p.z * hz))
            k = 1 + rough * noise.noise(p * freq + off)
            v.co = p * k
        verts = [c + v.co for v in tmp.verts]
        idx = {v: i for i, v in enumerate(tmp.verts)}
        faces = [tuple(idx[v] for v in f.verts) for f in tmp.faces]
        tmp.free()
        self.poly(verts, faces, col, smooth=True)

    # A clump of foliage filling an ellipsoid of size (sx, sy, sz): overlapping knobbly balls in a
    # few shades, the bigger ones low and in the middle.
    def bush(self, c, size, cols, seed=0, count=6):
        c = Vector(c)
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        r = min(hx, hy, hz)
        for i in range(count):
            a = 2.399 * i + seed
            t = (i + 0.5) / count
            p = Vector((math.cos(a) * math.sqrt(t), math.sin(a) * math.sqrt(t), 0.0))
            p.z = 0.55 - 0.9 * (1 - t) if count > 2 else 0.0
            rr = r * (0.75 - 0.25 * t) if count > 1 else r
            q = Vector((p.x * (hx - rr * 0.8), p.y * (hy - rr * 0.8), p.z * (hz - rr)))
            self.lump(c + q, rr, cols[i % len(cols)], seed * 13 + i)

    # A knobbly ball of leaves (a roughened icosphere).
    def lump(self, c, r, col, seed=0, rough=0.16, s=(1, 1, 1)):
        tmp = bmesh.new()
        bmesh.ops.create_icosphere(tmp, subdivisions=2, radius=r)
        off = Vector((seed * 7.31, seed * 3.17, seed * 5.93))
        for v in tmp.verts:
            v.co *= 1 + rough * noise.noise(v.co * (4.0 / r) * 0.5 + off)
            v.co = Vector((v.co.x * s[0], v.co.y * s[1], v.co.z * s[2]))
        verts = [Vector(c) + v.co for v in tmp.verts]
        idx = {v: i for i, v in enumerate(tmp.verts)}
        faces = [tuple(idx[v] for v in f.verts) for f in tmp.faces]
        tmp.free()
        self.poly(verts, faces, col, smooth=True)

    def finish(self):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        me.materials.append(BODY)
        me.materials.append(GLOW)
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob

def perp(u):
    p = u.cross(Z)
    if p.length < 1e-3:
        p = u.cross(X)
    return p.normalized()

def circle(r, n, a0=0.0):
    return [(r * math.cos(a0 + 2 * math.pi * i / n), r * math.sin(a0 + 2 * math.pi * i / n)) for i in range(n)]

def rrect(hx, hy, r, segs=2):
    # A rounded rectangle, counter-clockwise, 4 * (segs + 1) points.
    r = min(r, hx - 1e-3, hy - 1e-3)
    pts = []
    for cx, cy, a0 in ((hx - r, -hy + r, -math.pi / 2), (hx - r, hy - r, 0), (-hx + r, hy - r, math.pi / 2), (-hx + r, -hy + r, math.pi)):
        for k in range(segs + 1):
            a = a0 + (math.pi / 2) * k / segs
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

def mat(name, hexcol, rough, emit=0.0):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    b = m.node_tree.nodes.get('Principled BSDF')
    lin = tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in srgb(hexcol))
    b.inputs['Base Color'].default_value = (*lin, 1)
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*lin, 1)
        b.inputs['Emission Strength'].default_value = emit
    if name == 'Body':
        # Shows the baked colours in Blender's renders (the game reads COLOR_0 itself).
        attr = m.node_tree.nodes.new('ShaderNodeVertexColor')
        attr.layer_name = 'Col'
        m.node_tree.links.new(attr.outputs['Color'], b.inputs['Base Color'])
    return m

BODY = mat('Body', '#ffffff', 0.8)
GLOW = mat('Glow', C['glow'], 0.3, 0.6)

KIT = []

# `body`: how the game should treat it: 'loose' (light, knocked flying, a dynamic body with the
# listed mass in kg) or 'fixed' (planted in the ground: a static collider); `shape`: its
# collider (box or cylinder, from w, d, h).
def entry(ob, body, shape='box', mass=0):
    KIT.append({'name': ob.name, 'body': body, 'shape': shape, 'mass': mass})

# ---- Crates and the like ------------------------------------------------------------------------

def crate_shell(B, cx, cy, z0, s, col='wood', dark='wood_dk', lid=True):
    # A slatted wooden crate of side s: a dark core with three slats proud of each side, corner
    # posts and rims.
    t = s * 0.1
    B.box(cx, cy, z0 + 0.01, s - 0.04, s - 0.04, s - 0.02 if lid else s * 0.9, dark)
    gap = s * 0.04
    slat = (s - 2 * t - 2 * gap) / 3
    for k in range(3):
        z = z0 + t + k * (slat + gap) + slat / 2
        for u, n in ((X, -Y), (X, Y), (Y, X), (Y, -X)):
            B.obox(Vector((cx, cy, z)) + n * (s / 2 - 0.02), u, n, s - 2 * t, 0.03, slat, col)
    for sx in (-1, 1):
        for sy in (-1, 1):
            B.box(cx + sx * (s - t) / 2, cy + sy * (s - t) / 2, z0, t, t, s, dark if col != dark else 'wood_lt')
    zs = (z0, z0 + s - t) if lid else (z0,)
    for z in zs:
        for sx in (-1, 1):
            B.box(cx + sx * (s - t) / 2, cy, z, t, s - 2 * t, t, col)
            B.box(cx, cy + sx * (s - t) / 2, z, s - 2 * t, t, t, col)
    if lid:
        for k in (-1, 0, 1):
            B.box(cx + k * s * 0.27, cy, z0 + s - 0.04, s * 0.22, s - 2 * t, 0.04, col)

def crate():
    B = Builder('Yard_Crate', 'wood')
    crate_shell(B, 0, 0, 0, 1.0)
    entry(B.finish(), 'loose', 'box', 28)

def crate_stack():
    # Two crates, and a smaller one on top, as left by a shop door.
    B = Builder('Yard_CrateStack', 'wood')
    crate_shell(B, -0.52, 0, 0, 1.0)
    crate_shell(B, 0.55, 0.05, 0, 0.9)
    crate_shell(B, -0.4, 0.05, 1.0, 0.7)
    entry(B.finish(), 'fixed')

def fruit_crates():
    # Open fruit crates on a stand: oranges, apples and lemons.
    B = Builder('Yard_FruitCrates', 'wood_lt')
    for x in (-0.58, 0.58):
        B.beam((x, -0.3, 0), (x, -0.3, 0.6), 0.06, 0.06, 'wood_dk')
        B.beam((x, 0.3, 0), (x, 0.3, 0.6), 0.06, 0.06, 'wood_dk')
    B.box(0, 0, 0.55, 1.3, 0.7, 0.05, 'wood_dk')
    for k, (x, fruit) in enumerate(((-0.42, 'orange'), (0, 'red'), (0.42, 'yellow'))):
        crate_shell(B, x, 0, 0.6, 0.4, 'wood_lt', 'wood', lid=False)
        B.box(x, 0, 0.6, 0.36, 0.36, 0.3, 'soil')
        for i in range(3):
            for j in range(3):
                B.sphere((x - 0.11 + i * 0.11, -0.11 + j * 0.11, 0.97 + 0.02 * ((i + j + k) % 2)), 0.055, fruit, n=6, rings=4)
    entry(B.finish(), 'fixed')

def pallet():
    B = Builder('Yard_Pallet', 'plank')
    for x in (-0.55, 0, 0.55):
        B.box(x, 0, 0, 0.1, 0.8, 0.1, 'wood_dk')
    for k in range(5):
        B.box(0, -0.36 + k * 0.18, 0.1, 1.2, 0.12, 0.03, 'plank')
    entry(B.finish(), 'loose', 'box', 20)

def barrel():
    B = Builder('Yard_Barrel', 'wood')
    rings = []
    H, R = 0.9, 0.3
    for k in range(7):
        t = k / 6
        rings.append((circle(R * (0.86 + 0.14 * math.sin(math.pi * t)), 14), H * t))
    B.loft(rings, 'wood', smooth=True)
    B.loft([(circle(R * 0.84, 14), H - 0.001), (circle(R * 0.84, 14), H + 0.01)], 'wood_dk')
    for t in (0.12, 0.4, 0.6, 0.88):
        r = R * (0.86 + 0.14 * math.sin(math.pi * t)) + 0.012
        B.loft([(circle(r, 14), H * t - 0.025), (circle(r, 14), H * t + 0.025)], 'iron', smooth=True, top=False)
    entry(B.finish(), 'loose', 'cylinder', 40)

# ---- Café furniture -----------------------------------------------------------------------------

def table_parts(B, cx, cy):
    B.cyl(cx, cy, 0.36, 0.72, 0.75, 'trim', n=16, bottom=True)
    B.cyl(cx, cy, 0.03, 0.06, 0.72, 'iron', n=6)
    for a in range(3):
        ang = 2 * math.pi * a / 3
        B.beam((cx, cy, 0.04), (cx + 0.26 * math.cos(ang), cy + 0.26 * math.sin(ang), 0.02), 0.05, 0.04, 'iron')
    B.cyl(cx, cy, 0.08, 0.0, 0.06, 'iron', n=8)

def chair_parts(B, cx, cy, yaw, col='sage'):
    # A bistro chair facing yaw (0: its front to -y).
    c, s = math.cos(yaw), math.sin(yaw)
    def P(x, y, z):
        return Vector((cx + x * c - y * s, cy + x * s + y * c, z))
    fwd = Vector((-s, c, 0))  # toward its back
    side = Vector((c, s, 0))
    seat = [P(x, y, 0) for x, y in rrect(0.21, 0.2, 0.06)]
    B.loft([([(p.x, p.y) for p in seat], 0.43), ([(p.x, p.y) for p in seat], 0.47)], col, bottom=True)
    for lx, ly in ((-0.18, -0.17), (0.18, -0.17)):
        B.tube(P(lx, ly, 0.45), P(lx * 1.1, ly * 1.15, 0), 0.018, col)
    for lx in (-0.18, 0.18):
        # Back legs run on up into the back's frame.
        B.tube(P(lx * 1.1, 0.22, 0), P(lx, 0.18, 0.45), 0.018, col)
        B.tube(P(lx, 0.18, 0.45), P(lx * 0.95, 0.24, 0.88), 0.018, col)
    B.obox(P(0, 0.235, 0.82), side, fwd, 0.36, 0.025, 0.1, col)
    B.obox(P(0, 0.215, 0.64), side, fwd, 0.34, 0.025, 0.05, col)
    B.tube(P(-0.19, -0.18, 0.15), P(0.19, -0.18, 0.15), 0.01, col, n=4)
    B.tube(P(-0.19, 0.2, 0.15), P(0.19, 0.2, 0.15), 0.01, col, n=4)

def cafe_table():
    B = Builder('Yard_CafeTable', 'trim')
    table_parts(B, 0, 0)
    entry(B.finish(), 'loose', 'cylinder', 12)

def chair():
    B = Builder('Yard_Chair', 'sage')
    chair_parts(B, 0, 0, 0)
    entry(B.finish(), 'loose', 'box', 6)

def cafe_set():
    # A café table with two chairs and a striped parasol.
    B = Builder('Yard_CafeSet', 'stripe')
    table_parts(B, 0, 0)
    chair_parts(B, -0.62, 0.0, math.pi / 2)
    chair_parts(B, 0.62, 0.05, -math.pi / 2 + 0.25)
    B.cyl(0, 0, 0.022, 0.75, 2.35, 'white', n=6)
    n = 8
    R, z0, z1 = 1.25, 1.95, 2.4
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        col = 'stripe' if i % 2 == 0 else 'canvas'
        p0 = (R * math.cos(a0), R * math.sin(a0), z0)
        p1 = (R * math.cos(a1), R * math.sin(a1), z0)
        # Each panel twice, its underside a little below (so it shows from under the parasol too).
        B.poly([p0, p1, (0, 0, z1)], [(0, 1, 2)], col)
        B.poly([(p0[0], p0[1], z0 - 0.02), (p1[0], p1[1], z0 - 0.02), (0, 0, z1 - 0.02)], [(2, 1, 0)], col)
        # A short valance below each panel, open at the back the same way.
        q0 = (p0[0] * 0.985, p0[1] * 0.985, z0)
        q1 = (p1[0] * 0.985, p1[1] * 0.985, z0)
        B.poly([p0, p1, (p1[0], p1[1], z0 - 0.12), (p0[0], p0[1], z0 - 0.12)], [(3, 2, 1, 0)], col)
        B.poly([q0, q1, (q1[0], q1[1], z0 - 0.12), (q0[0], q0[1], z0 - 0.12)], [(0, 1, 2, 3)], col)
    B.sphere((0, 0, z1 + 0.03), 0.04, 'white', n=6, rings=4)
    entry(B.finish(), 'fixed')

def bench():
    B = Builder('Yard_Bench', 'wood')
    W = 1.6
    for x in (-0.68, 0.68):
        # Cast-iron ends: front leg, back leg running up into the back, an arm.
        B.beam((x, -0.2, 0), (x, -0.18, 0.44), 0.06, 0.05, 'iron', n=X)
        B.beam((x, 0.22, 0), (x, 0.2, 0.44), 0.06, 0.05, 'iron', n=X)
        B.beam((x, 0.2, 0.44), (x, 0.3, 0.86), 0.06, 0.05, 'iron', n=X)
        B.beam((x, -0.24, 0.42), (x, 0.22, 0.42), 0.06, 0.05, 'iron', n=X)
        B.beam((x, -0.2, 0.64), (x, 0.24, 0.66), 0.05, 0.05, 'iron', n=X)
        B.beam((x, -0.2, 0.44), (x, -0.2, 0.64), 0.05, 0.05, 'iron', n=X)
    for k in range(4):
        B.box(0, -0.18 + k * 0.12, 0.45, W, 0.1, 0.035, 'wood')
    for k in range(3):
        a = Vector((0, 0.22 + k * 0.028, 0.56 + k * 0.12))
        B.obox(a, X, Vector((0, 0.24, -1)).normalized(), W, 0.03, 0.09, 'wood', w=Vector((0, 1, 0.24)).normalized())
    entry(B.finish(), 'fixed')

# ---- Plants -------------------------------------------------------------------------------------

def flowers(B, cx, cy, z, spread, cols, count, seed):
    for i in range(count):
        a = 2.399 * i + seed
        r = spread * math.sqrt((i + 0.5) / count)
        B.sphere((cx + r * math.cos(a), cy + r * math.sin(a) * 0.8, z + 0.03 * math.sin(i * 1.7)), 0.04, cols[i % len(cols)], n=5, rings=3)

def planter():
    B = Builder('Yard_Planter', 'wood')
    W, D, H = 1.2, 0.45, 0.45
    B.box(0, 0, 0, W, D, H, 'wood_dk')
    for k in range(3):
        for u, n, L in ((X, -Y, W), (X, Y, W), (Y, X, D), (Y, -X, D)):
            B.obox(Vector((0, 0, 0.08 + k * 0.14)) + n * ((D if u == X else W) / 2), u, n, L + 0.03, 0.03, 0.12, 'wood')
    for sy in (-1, 1):
        B.box(0, sy * D / 2, H, W + 0.06, 0.07, 0.04, 'wood_lt')
    for sx in (-1, 1):
        B.box(sx * W / 2, 0, H, 0.07, D - 0.07, 0.04, 'wood_lt')
    B.box(0, 0, H - 0.06, W - 0.04, D - 0.04, 0.08, 'soil')
    for k, x in enumerate((-0.38, 0, 0.38)):
        B.bush((x, 0, H + 0.16), (0.46, 0.46, 0.4), (('leaf', 'leaf_dk'), ('leaf_dk', 'leaf_lt'), ('leaf_lt', 'leaf'))[k], seed=k + 1, count=5)
    flowers(B, -0.38, -0.06, H + 0.3, 0.17, ('pink', 'white'), 7, 0.3)
    flowers(B, 0.38, -0.06, H + 0.3, 0.17, ('yellow', 'orange'), 7, 1.1)
    flowers(B, 0, -0.06, H + 0.3, 0.17, ('purple', 'pink'), 6, 2.2)
    entry(B.finish(), 'fixed')

def flower_pot():
    B = Builder('Yard_FlowerPot', 'pot')
    B.loft([(circle(0.17, 12), 0), (circle(0.24, 12), 0.38)], 'pot', smooth=True, top=False, bottom=True)
    B.loft([(circle(0.25, 12), 0.34), (circle(0.27, 12), 0.36), (circle(0.27, 12), 0.44), (circle(0.25, 12), 0.44)], 'pot_dk', smooth=True, top=False)
    B.cyl(0, 0, 0.25, 0.36, 0.42, 'soil', n=12)
    B.bush((0, 0, 0.62), (0.52, 0.52, 0.46), ('leaf', 'leaf_dk', 'leaf_lt'), seed=4, count=5)
    flowers(B, 0, -0.04, 0.84, 0.18, ('red', 'pink', 'white'), 9, 0.7)
    entry(B.finish(), 'loose', 'cylinder', 18)

def urn_topiary():
    # A ball tree in a stone urn, by a front door.
    B = Builder('Yard_Topiary', 'stone')
    B.box(0, 0, 0, 0.44, 0.44, 0.1, 'stone')
    B.loft([(circle(0.09, 12), 0.1), (circle(0.09, 12), 0.2), (circle(0.17, 12), 0.26), (circle(0.25, 12), 0.38), (circle(0.27, 12), 0.52),
            (circle(0.25, 12), 0.6), (circle(0.29, 12), 0.62), (circle(0.29, 12), 0.68)], 'stone', smooth=True)
    B.cyl(0, 0, 0.025, 0.66, 1.15, 'wood_dk', n=6)
    B.blob((0, 0, 1.4), (0.62, 0.62, 0.62), 'hedge', seed=6, rough=0.06, round_=1.0, freq=9.0)
    entry(B.finish(), 'loose', 'cylinder', 45)

def hedge():
    B = Builder('Yard_Hedge', 'hedge')
    # A trimmed hedge: a squared-off block, its top and faces bulging in big soft clumps.
    B.blob((0, 0, 0.42), (1.86, 0.5, 0.84), 'hedge', seed=2, cuts=4, rough=0.05, round_=0.3, freq=5.0)
    for i in range(6):
        x = -0.72 + 1.44 * i / 5
        B.lump((x, 0.02 * math.sin(i * 2.1), 0.64 + 0.03 * math.sin(i * 1.3)), 0.3, 'hedge', seed=20 + i, rough=0.1, s=(1.0, 0.95, 0.85))
        for side in (-1, 1):
            B.lump((x + 0.1 * side, side * 0.1, 0.3), 0.28, 'hedge', seed=40 + i * 2 + (side > 0), rough=0.1, s=(1.0, 0.75, 1.1))
    entry(B.finish(), 'fixed')

# ---- Around the gate ----------------------------------------------------------------------------

def picket_fence():
    # A 2 m stretch of white picket fence, its posts at the ends (rows of them share a post).
    B = Builder('Yard_PicketFence', 'white')
    for x in (-1.0, 1.0):
        B.box(x, 0, 0, 0.09, 0.09, 1.0, 'white')
        B.loft([(rrect(0.055, 0.055, 0.01, 1), 1.0), (rrect(0.02, 0.02, 0.01, 1), 1.07)], 'white', offset=(x, 0))
    for z in (0.25, 0.7):
        B.box(0, 0.05, z, 2.0, 0.035, 0.08, 'white')
    n = 11
    for k in range(n):
        x = -0.9 + 1.8 * k / (n - 1)
        pts = [(x - 0.04, -0.012), (x + 0.04, -0.012), (x + 0.04, 0.012), (x - 0.04, 0.012)]
        B.loft([(pts, 0.05), (pts, 0.86)], 'white', top=False)
        B.poly([(x - 0.04, -0.012, 0.86), (x + 0.04, -0.012, 0.86), (x, -0.012, 0.95),
                (x - 0.04, 0.012, 0.86), (x + 0.04, 0.012, 0.86), (x, 0.012, 0.95)],
               [(0, 1, 2), (5, 4, 3), (1, 4, 5, 2), (3, 0, 2, 5)], 'white')
    entry(B.finish(), 'fixed')

def mailbox():
    B = Builder('Yard_Mailbox', 'mail')
    B.box(0, 0, 0, 0.09, 0.09, 1.0, 'wood')
    B.box(0, 0.02, 0.98, 0.2, 0.42, 0.04, 'wood_dk')
    # A tunnel box: a flat-bottomed, round-topped profile along y.
    prof = [(-0.11, 0)] + [(0.11 * math.cos(math.pi - math.pi * k / 6), 0.1 + 0.11 * math.sin(math.pi - math.pi * k / 6)) for k in range(7)] + [(0.11, 0)]
    prof = prof[::-1]
    m = len(prof)
    verts = [(x, -0.2, 1.02 + z) for x, z in prof] + [(x, 0.24, 1.02 + z) for x, z in prof]
    faces = [(i, (i + 1) % m, m + (i + 1) % m, m + i) for i in range(m)]
    B.poly(verts, faces, 'mail', smooth=True)
    B.poly(verts[m:], [tuple(range(m))], 'mail')
    B.poly(verts[:m], [tuple(range(m))[::-1]], 'iron')
    B.box(0.12, 0.1, 1.12, 0.02, 0.04, 0.12, 'red')
    B.box(0.12, 0.13, 1.2, 0.02, 0.1, 0.06, 'red')
    entry(B.finish(), 'fixed')

def wheelie_bin():
    B = Builder('Yard_WheelieBin', 'bin')
    B.loft([(rrect(0.25, 0.3, 0.05), 0.04), (rrect(0.29, 0.36, 0.05), 0.98)], 'bin', bottom=True)
    B.loft([(rrect(0.31, 0.38, 0.05), 0.98), (rrect(0.31, 0.38, 0.05), 1.04), (rrect(0.29, 0.36, 0.06), 1.06)], 'bin_dk')
    B.box(0, 0.38, 0.96, 0.46, 0.06, 0.06, 'bin_dk')  # handle bar at the back
    B.box(0, -0.37, 0.92, 0.2, 0.04, 0.05, 'bin_dk')  # lid lip at the front
    for x in (-0.24, 0.24):
        B.torus((x, 0.3, 0.1), X, 0.07, 0.03, 'rubber', n=10, m=4)
    B.tube((-0.28, 0.3, 0.1), (0.28, 0.3, 0.1), 0.015, 'steel')
    entry(B.finish(), 'loose', 'box', 15)

def garden_lamp():
    B = Builder('Yard_GardenLamp', 'iron')
    B.cyl(0, 0, 0.12, 0, 0.15, 'iron', n=8)
    B.cyl(0, 0, 0.04, 0.15, 1.7, 'iron', n=8)
    B.cyl(0, 0, 0.07, 1.62, 1.72, 'iron', n=8)
    sq = [(-0.11, -0.11), (0.11, -0.11), (0.11, 0.11), (-0.11, 0.11)]
    sq2 = [(-0.14, -0.14), (0.14, -0.14), (0.14, 0.14), (-0.14, 0.14)]
    B.loft([(sq, 1.72), (sq2, 2.05)], 'glow')
    for x, y in sq:
        B.tube((x, y, 1.72), (x * 1.27, y * 1.27, 2.05), 0.012, 'iron', n=4)
    B.loft([(circle(0.22, 4, math.pi / 4), 2.05), (circle(0.22, 4, math.pi / 4), 2.08), (circle(0.03, 4, math.pi / 4), 2.24)], 'iron')
    B.sphere((0, 0, 2.27), 0.035, 'iron', n=6, rings=4)
    entry(B.finish(), 'fixed')

# ---- Odds and ends ------------------------------------------------------------------------------

def bicycle():
    # A town bike on its stand, side on to the street (its length along x).
    B = Builder('Yard_Bicycle', 'blue')
    R = 0.33
    rear, front = Vector((-0.52, 0, R + 0.02)), Vector((0.52, 0, R + 0.02))
    for c in (rear, front):
        B.torus(c, Y, R, 0.022, 'rubber', n=18, m=4)
        B.torus(c, Y, R - 0.03, 0.01, 'steel', n=18, m=3)
        for k in range(6):
            a = math.pi * k / 6
            d = Vector((math.cos(a), 0, math.sin(a))) * (R - 0.03)
            B.tube(c - d, c + d, 0.004, 'steel', n=3)
    crank = Vector((-0.05, 0, 0.3))
    seat = Vector((-0.2, 0, 0.82))
    head = Vector((0.38, 0, 0.86))
    for a, b in ((rear, crank), (rear, seat - Vector((-0.02, 0, 0.1))), (crank, seat), (crank, head - Vector((0.03, 0, 0.12))), (head, front)):
        B.tube(a, b, 0.02, 'blue')
    B.tube(head, head + Vector((-0.02, 0, 0.16)), 0.018, 'blue')
    B.tube(head + Vector((-0.06, -0.24, 0.17)), head + Vector((-0.06, 0.24, 0.17)), 0.013, 'iron')
    for s in (-1, 1):
        B.tube(head + Vector((-0.06, s * 0.24, 0.17)), head + Vector((-0.14, s * 0.26, 0.17)), 0.018, 'rubber')
    B.sphere(seat + Vector((0, 0, 0.04)), 0.09, 'wood_dk', n=8, rings=4, s=(1.4, 0.7, 0.35))
    # A rack and a basket.
    B.box(-0.5, 0, 0.72, 0.36, 0.14, 0.02, 'iron')
    B.tube(rear, Vector((-0.5, 0, 0.72)), 0.008, 'iron', n=3)
    B.loft([(rrect(0.13, 0.16, 0.03), 0.84), (rrect(0.15, 0.18, 0.03), 1.06)], 'wood_lt', bottom=True, offset=(0.56, 0))
    B.tube(Vector((0.5, 0, 0.84)), head, 0.008, 'iron', n=3)
    B.tube(crank, crank + Vector((0.05, -0.12, -0.15)), 0.012, 'steel', n=4)  # the stand
    entry(B.finish(), 'loose', 'box', 16)

def wheelbarrow():
    B = Builder('Yard_Wheelbarrow', 'red')
    B.loft([(rrect(0.24, 0.2, 0.05), 0.3), (rrect(0.36, 0.3, 0.06), 0.58)], 'red', top=False, bottom=True)
    B.loft([(rrect(0.37, 0.31, 0.06), 0.58), (rrect(0.37, 0.31, 0.06), 0.61), (rrect(0.34, 0.28, 0.06), 0.61)], 'red', top=False)
    B.loft([(rrect(0.34, 0.28, 0.06), 0.55), (rrect(0.34, 0.28, 0.06), 0.56)], 'soil')
    B.torus((0.58, 0, 0.18), Y, 0.15, 0.04, 'rubber', n=14, m=4)
    B.tube((0.58, -0.06, 0.18), (0.58, 0.06, 0.18), 0.03, 'steel')
    for y in (-0.2, 0.2):
        B.tube((0.58, y * 0.3, 0.18), (-0.95, y, 0.5), 0.018, 'wood_dk')
        B.tube((-0.95, y, 0.5), (-1.2, y * 1.05, 0.55), 0.024, 'rubber')
        B.tube((-0.3, y, 0.36), (-0.36, y, 0.0), 0.016, 'wood_dk')
    entry(B.finish(), 'loose', 'box', 22)

def doghouse():
    B = Builder('Yard_Doghouse', 'cream')
    W, D, H = 0.9, 1.1, 0.6
    B.box(0, 0, 0, W + 0.06, D + 0.06, 0.06, 'wood_dk')
    # Walls with gable ends (front and back).
    gable = [(-W / 2, 0.06), (W / 2, 0.06), (W / 2, H), (0, H + 0.38), (-W / 2, H)]
    verts = [(x, -D / 2, z) for x, z in gable] + [(x, D / 2, z) for x, z in gable]
    m = len(gable)
    B.poly(verts, [tuple(range(m))[::-1], tuple(range(m, 2 * m))] + [(i, (i + 1) % m, m + (i + 1) % m, m + i) for i in range(m)], 'cream')
    # The door: an arch, dark, just proud of the front.
    arch = [(-0.16, 0.06)] + [(0.16 * math.cos(math.pi - math.pi * k / 6), 0.36 + 0.16 * math.sin(math.pi - math.pi * k / 6)) for k in range(7)] + [(0.16, 0.06)]
    B.poly([(x, -D / 2 - 0.005, z) for x, z in arch], [tuple(range(len(arch)))], 'iron')
    # Roof: two slabs overhanging.
    for s in (-1, 1):
        a = Vector((0, -D / 2 - 0.08, H + 0.38 + 0.03))
        eave = Vector((s * (W / 2 + 0.1), 0, -(0.38 + 0.1 * 0.38 / (W / 2)) - 0.0))
        c = a + eave / 2 + Vector((0, (D + 0.16) / 2, 0))
        u = eave.normalized()
        B.obox(c, u, Y, eave.length + 0.04, D + 0.16, 0.05, 'terra', w=u.cross(Y) * (-1 if s < 0 else 1))
    B.box(0, 0, H + 0.38, 0.06, D + 0.18, 0.06, 'terra_dk')
    B.box(0, -D / 2 - 0.01, 0.62, 0.22, 0.02, 0.08, 'wood_lt')  # name board
    B.cyl(0.42, -0.72, 0.1, 0, 0.07, 'red', n=10)  # food bowl
    entry(B.finish(), 'fixed')

def gnome():
    B = Builder('Yard_Gnome', 'blue')
    B.cyl(0, 0, 0.11, 0, 0.04, 'stone', n=10)
    B.loft([(circle(0.1, 10), 0.04), (circle(0.09, 10), 0.18), (circle(0.06, 10), 0.3)], 'blue', smooth=True)
    B.sphere((0, -0.01, 0.34), 0.065, 'skin', n=10, rings=6)
    B.loft([(circle(0.06, 10), 0.34), (circle(0.0, 10), 0.18)], 'beard', smooth=True, offset=(0, -0.045), top=False)
    B.sphere((0, -0.07, 0.345), 0.018, 'pink', n=6, rings=4)
    B.loft([(circle(0.07, 10), 0.37), (circle(0.035, 10), 0.46), (circle(0.004, 10), 0.53)], 'red', smooth=True)
    for s in (-1, 1):
        B.sphere((s * 0.08, -0.04, 0.22), 0.025, 'skin', n=6, rings=4)
        B.sphere((s * 0.05, -0.08, 0.04), 0.03, 'wood_dk', n=6, rings=4, s=(1, 1.4, 0.7))
    entry(B.finish(), 'loose', 'cylinder', 3)

crate()
crate_stack()
fruit_crates()
pallet()
barrel()
cafe_table()
chair()
cafe_set()
bench()
planter()
flower_pot()
urn_topiary()
hedge()
picket_fence()
mailbox()
wheelie_bin()
garden_lamp()
bicycle()
wheelbarrow()
doghouse()
gnome()

objs = [bpy.data.objects[k['name']] for k in KIT]
for k, o in zip(KIT, objs):
    me = o.data
    # Centre the model on its footprint and stand it on the ground; list its size.
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    zs = [v.co.z for v in me.vertices]
    shift = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs)))
    for v in me.vertices:
        v.co -= shift
    k['w'], k['d'], k['h'] = round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2), round(max(zs) - min(zs), 2)
    me.update()
    k['tris'] = sum(len(p.vertices) - 2 for p in me.polygons)
    me.color_attributes.active_color = me.color_attributes['Col']

bpy.context.view_layer.update()
for o in bpy.data.objects:
    o.select_set(o in objs)
bpy.context.view_layer.objects.active = objs[0]
bpy.ops.export_scene.gltf(filepath=GLB, use_selection=True, export_format='GLB', export_apply=True,
                          export_vertex_color='NAME', export_vertex_color_name='Col', export_all_vertex_colors=False, export_materials='EXPORT', export_yup=True)

if MANIFEST:
    with open(MANIFEST, 'w') as fh:
        fh.write('// Generated by scripts/yard-kit/build_kit.py (do not edit): the sunny town\'s yard props in\n')
        fh.write('// public/models/yard-kit.glb (crates, café furniture, plants, fences, bins and so on, to stand in\n')
        fh.write('// front of the houses). Per prop: its size (w along the street, d away from it, h up, in m), how\n')
        fh.write('// the game should treat it (loose: a dynamic body of `mass` kg the car can knock about; fixed: a\n')
        fh.write('// static collider), its collider\'s shape, and its triangles.\n')
        fh.write('export const YARD_KIT = [\n')
        for k in KIT:
            fh.write(f"  {{ name: '{k['name']}', w: {k['w']}, d: {k['d']}, h: {k['h']}, body: '{k['body']}', shape: '{k['shape']}', mass: {k['mass']}, tris: {k['tris']} }},\n")
        fh.write('];\n')

if RENDER:
    # A contact sheet of the kit for review, and a front-garden scene.
    import os
    PER_ROW = 7
    x = 0.0
    width = 0.0
    for i, o in enumerate(objs):
        if i % PER_ROW == 0:
            x = 0.0
        w = max(o.dimensions.x, 0.6)
        o.location = (x + w / 2, (i // PER_ROW) * 3.2, 0)
        x += w + 0.8
        width = max(width, x)
    sc = bpy.context.scene
    me = bpy.data.meshes.new('Ground')
    me.from_pydata([(-300, -300, 0), (300, -300, 0), (300, 300, 0), (-300, 300, 0)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new('Ground', me)
    sc.collection.objects.link(g)
    gm = bpy.data.materials.new('GroundMat')
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.42, 0.4, 0.34, 1)
    me.materials.append(gm)
    ld = bpy.data.lights.new('Sun', 'SUN'); ld.energy = 4.0; ld.angle = math.radians(3)
    sun = bpy.data.objects.new('Sun', ld); sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))
    w = sc.world or bpy.data.worlds.new('World'); sc.world = w
    bg = w.node_tree.nodes.get('Background')
    bg.inputs[0].default_value = (0.62, 0.75, 0.92, 1); bg.inputs[1].default_value = 0.9
    rows = (len(objs) - 1) // PER_ROW
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 2000, 1300
    sc.view_settings.view_transform = 'AgX'
    for name, ang in (('front', 22), ('back', 202)):
        cd = bpy.data.cameras.new(name); cd.type = 'ORTHO'; cd.ortho_scale = width * 1.0
        cam = bpy.data.objects.new(name, cd); sc.collection.objects.link(cam)
        a = math.radians(ang)
        target = Vector((width / 2 - 0.4, 3.2 * rows / 2 + 1.0, 0.6))
        cam.location = target + Vector((math.sin(a) * 30, -math.cos(a) * 30, 17))
        cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.camera = cam
        sc.render.filepath = os.path.join(RENDER, f'yard_{name}.png')
        bpy.ops.render.render(write_still=True)

print(json.dumps(KIT))
