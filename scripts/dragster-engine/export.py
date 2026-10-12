# Converts the Blend Swap "Dragster Engine" (blendswap.com/blends/view/84608, CC BY 3.0) to
# public/models/dragster-engine.glb for src/render/dragster-engine.js:
#
#   blender -b Dragster_Engine_BlendSwap_Version.blend --python scripts/dragster-engine/export.py -- 0.16 public/models/dragster-engine.glb
#
# The model's parts are joined meshes; they are split into loose pieces and the moving ones picked
# out by where they sit: the crank, idler and blower pulleys, the throttle shaft (butterflies, arm,
# left lever), the throttle rod, the barrel valve's arm, and the return spring. The model's belt
# is dropped (the game builds one that runs). Everything else is one static mesh. Meshes are
# decimated (first argument: the static mesh's ratio), scaled to metres, turned to the chassis'
# axes (x forward, y up, z right) with the crank pulley's centre at the origin, and each moving
# part gets its pivot as its origin. Data the game needs rides along as glTF extras.
import bpy, json, math, sys
import numpy as np
from mathutils import Vector, Matrix
argv=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
RATIO=float(argv[0]) if argv else 0.16
OUT=argv[1] if len(argv)>1 else 'dragster-engine.glb'
for n in ('Render_Setup','Camera'):
    if n in bpy.data.objects: bpy.data.objects.remove(bpy.data.objects[n])
eng=[o for o in bpy.data.objects if o.type=='MESH']
for o in eng:
    bpy.context.view_layer.objects.active=o
    for m in list(o.modifiers):
        if m.type=='MIRROR': bpy.ops.object.modifier_apply(modifier=m.name)
bpy.ops.object.select_all(action='DESELECT')
for o in eng: o.select_set(True)
bpy.context.view_layer.objects.active=eng[0]
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.separate(type='LOOSE'); bpy.ops.object.mode_set(mode='OBJECT')
parts=[o for o in bpy.data.objects if o.type=='MESH']
def box(o):
    bb=[o.matrix_world@Vector(c) for c in o.bound_box]
    return [min(v[i] for v in bb) for i in range(3)],[max(v[i] for v in bb) for i in range(3)]
info={o.name:box(o) for o in parts}
def center(o):
    mn,mx=info[o.name]; return [(mn[i]+mx[i])/2 for i in range(3)]
def find(prefix,c,tol=0.03):
    hits=[o for o in parts if o.name.startswith(prefix) and all(abs(center(o)[i]-c[i])<tol for i in range(3))]
    assert len(hits)==1,(prefix,c,[h.name for h in hits])
    return hits[0]
groups={}
used=set()
def add(g,o):
    assert o.name not in used,o.name
    used.add(o.name); groups.setdefault(g,[]).append(o)
# The belt: rebuilt in the game.
for o in parts:
    if o.name.startswith('Engine_Front') and abs(center(o)[0]+0.45)<0.03 and abs(center(o)[1]+4.84)<0.03 and abs(center(o)[2]+1.48)<0.03:
        used.add(o.name); bpy.data.objects.remove(o)
parts=[o for o in bpy.data.objects if o.type=='MESH']
# Pulleys (blender coords: crank along y; x right-ish; z up)
# Options: BLOWER keeps the supercharger; TURN_HAT turns the injector hat round (with its
# throttle parts) so its scoop faces the other way.
BLOWER=True
TURN_HAT=True
PULLEYS={'crank':((0.0,-3.68),0.9),'idler':((-1.16,-2.12),0.68)}
if BLOWER: PULLEYS['blower']=((0.29,0.96),0.66)
for name,((cx,cz),r) in PULLEYS.items():
    for o in parts:
        if o.name in used or not (o.name.startswith('Engine_Front') or o.name.startswith('Supercharger_Parts')): continue
        mn,mx=info[o.name]
        if mn[1]<-5.2 or mx[1]>-4.4: continue
        corners=[(mn[0],mn[2]),(mn[0],mx[2]),(mx[0],mn[2]),(mx[0],mx[2])]
        if all(math.hypot(x-cx,z-cz)<=r for x,z in corners) or (math.hypot(center(o)[0]-cx,center(o)[2]-cz)<0.12 and mx[0]-mn[0]<2*r):
            add(name,o)
# Throttle: butterflies, screws, shaft, right arm (with its screws), left lever, collar.
T='Throttle_Accessories'
shaft=[(0.06,-3.78,3.67),(-1.31,-3.78,3.67),(0.0,-3.78,3.67),(1.3,-3.78,3.67),
       (-1.55,-3.83,3.64),(-1.07,-3.83,3.64),(-0.24,-3.83,3.64),(0.24,-3.83,3.64),(1.06,-3.83,3.64),(1.54,-3.83,3.64),
       (2.2,-3.29,3.76),(2.23,-3.59,3.77),(2.23,-3.55,3.63),(-2.03,-3.95,3.54),(2.06,-3.91,3.66),(2.02,-3.92,3.66)]
for c in shaft: add('throttle',find(T,c))
for c in [(2.27,-2.75,3.2),(2.27,-2.95,3.64),(2.27,-2.55,2.74),(2.27,-2.72,3.12),(2.29,-2.46,2.55),(2.29,-3.05,3.85)]: add('rod',find(T,c))
for c in [(2.2,-2.65,2.47),(2.23,-2.94,2.47),(2.23,-2.91,2.34)]: add('valveArm',find(T,c))
add('spring',find(T,(-1.99,-3.57,2.88)))
for g,os in groups.items(): print('GROUP',g,len(os),sorted(o.name for o in os)[:12])
# Pivots (blender coords)
SHAFT=Vector((0,-3.78,3.67))
VALVE=Vector((2.27,-2.78,2.49))
# Spring ends: principal axis of its vertices.
sp=groups['spring'][0]
vs=[sp.matrix_world@v.co for v in sp.data.vertices]
c=sum(vs,Vector())/len(vs)
A=np.array([[*(v-c)] for v in vs]); w,V=np.linalg.eigh(A.T@A); ax=Vector(V[:,2])
proj=[(v-c).dot(ax) for v in vs]
endA=c+ax*min(proj); endB=c+ax*max(proj)
# Rod ends: centres of the two rod-end eyes.
rodTop=Vector(center(find(T,(2.29,-3.05,3.85)))); rodBot=Vector(center(find(T,(2.29,-2.46,2.55))))
def moveThrottle(M):
    global SHAFT,VALVE,rodTop,rodBot,endA,endB
    for o in [o for o in bpy.data.objects if o.type=='MESH' and o.name.startswith('Throttle')]:
        o.matrix_world=M@o.matrix_world
    SHAFT,VALVE,rodTop,rodBot,endA,endB=[M@v for v in (SHAFT,VALVE,rodTop,rodBot,endA,endB)]
if TURN_HAT:
    # The fuel lines up to the barrel valve (and their end caps) would end in the air.
    for o in [o for o in bpy.data.objects if o.type=='MESH' and o.name.split('.')[0]=='Hoses_and_Pipes']:
        if o.name.split('.')[-1] in ('Hoses_and_Pipes','001','003','033','034','035','036','037'): bpy.data.objects.remove(o)
    # About the vertical through the middle of the hat's base on the blower.
    hat=bpy.data.objects['Throttle_Body']
    ws=[hat.matrix_world@v.co for v in hat.data.vertices]
    zmin=min(w.z for w in ws)
    base=[w for w in ws if w.z<zmin+0.3]
    c=sum(base,Vector())/len(base)
    print('HAT BASE',c)
    moveThrottle(Matrix.Translation((c.x,c.y,0))@Matrix.Rotation(math.pi,4,'Z')@Matrix.Translation((-c.x,-c.y,0)))
# No blower: its case, blanket and straps, drive snout, pulley and belt guard, and the hoses over
# it go. The injector hat (with the throttle parts) comes down onto the intake manifold, and the
# fuel lines up to it are squashed down to meet it.
DZ=2.2 if not BLOWER else 0
def gone(o):
    if BLOWER: return False
    n=o.name; mn,mx=info[n]; c=center(o); i=n.split('.')[-1]
    if n.startswith('Manifold_And_Supercharger'): return mx[2]>0
    if n.startswith('Supercharger_Parts'): return True
    if n.startswith('Engine_Front'): return mn[2]>-0.6 and abs(c[0]-0.29)<1.2
    if n.startswith('Hoses_and_Pipes'): return i in ('021','023','024','025') or (mn[2]>0.3 and mx[2]<=1.0)
    return False
for o in [o for o in bpy.data.objects if o.type=='MESH' and o.name not in used and gone(o)]: bpy.data.objects.remove(o)
for o in [o for o in bpy.data.objects if o.type=='MESH' and DZ]:
    if o.name.startswith('Hoses_and_Pipes') and info[o.name][1][2]>1.0 and not o.name.endswith('.048'):
        mw=o.matrix_world; inv=mw.inverted()
        for v in o.data.vertices:
            w=mw@v.co
            w.z-=DZ*max(0,min(1,(w.z+2.4)/4.6))
            v.co=inv@w
if DZ: moveThrottle(Matrix.Translation((0,0,-DZ)))
# Decimate everything (static dense parts more); then edge split for hard edges.
def tris(o): return sum(len(p.vertices)-2 for p in o.data.polygons)
before=sum(tris(o) for o in bpy.data.objects if o.type=='MESH')
for o in bpy.data.objects:
    if o.type!='MESH': continue
    t=tris(o)
    if t>200:
        m=o.modifiers.new('dec','DECIMATE'); m.decimate_type='COLLAPSE'
        m.ratio = RATIO if o.name not in used else 0.35
        o.modifiers.move(o.modifiers.find('dec'),0)  # before the edge split
# Join per group + static
def join(objs,name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active=objs[0]
    bpy.ops.object.convert(target='MESH')  # applies modifiers
    bpy.ops.object.join()
    ob=bpy.context.view_layer.objects.active; ob.name=name; ob.data.name=name
    ob.parent=None
    # Mesh data in world coordinates, so pivots below can be given in world coordinates.
    ob.data.transform(ob.matrix_world); ob.matrix_world=Matrix()
    return ob
root=bpy.data.objects.get('Dragster_Engine')
out={}
static=[o for o in bpy.data.objects if o.type=='MESH' and o.name not in used]
for o in static+[x for g in groups.values() for x in g]:
    mw=o.matrix_world.copy(); o.parent=None; o.matrix_world=mw
out['static']=join(static,'static')
for g,os in groups.items(): out[g]=join(os,g)
if root: bpy.data.objects.remove(root)
# Strip UVs and unused material slots
for ob in out.values():
    while ob.data.uv_layers: ob.data.uv_layers.remove(ob.data.uv_layers[0])
    bpy.context.view_layer.objects.active=ob
    bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True)
    bpy.ops.object.material_slot_remove_unused()
after=sum(tris(o) for o in out.values())
print('TRIS',before,'->',after,{k:tris(v) for k,v in out.items()})
# Engine frame: origin at the crank pulley centre. Car frame (x fwd, y up, z right) = (-by, bz, -bx) * S.
S=0.085
ORIGIN=Vector((0,-4.82,-3.68))
def car(p): p=Vector(p)-ORIGIN; return [round(-p.y*S,5),round(p.z*S,5),round(-p.x*S,5)]
pivots={'crank':Vector((0,-4.82,-3.68)),'idler':Vector((-1.16,-4.82,-2.12)),'blower':Vector((0.29,-4.82,0.96)),
        'throttle':SHAFT,'valveArm':VALVE,'rod':rodTop,'spring':endB if endB.z>endA.z else endA}
# Spring: its fixed end is the low one (on the stud).
fixed=endA if endA.z<endB.z else endB; moving=endB if fixed is endA else endA
pivots['spring']=fixed
# Pulley radii from mesh extents (outer, tooth tips)
def radius(ob,c):
    return max(math.hypot((ob.matrix_world@v.co).x-c.x,(ob.matrix_world@v.co).z-c.z) for v in ob.data.vertices)
meta={'scale':S,'pulleys':{k:{'center':car(pivots[k]),'radius':round(radius(out[k],pivots[k])*S,5)} for k in PULLEYS},
      'beltY':car((0,-4.84,0))[0],'beltWidth':0.57*S,
      'throttleShaft':car(SHAFT),'valvePivot':car(VALVE),'rodTop':car(rodTop),'rodBottom':car(rodBot),
      'springFixed':car(fixed),'springMoving':car(moving)}
# Set origins at pivots; transform all to the car frame.
R=Matrix.Rotation(math.radians(90),4,'Z')  # blender -> (gltf y-up) = car axes
for k,ob in out.items():
    p=pivots.get(k,ORIGIN)
    ob.data.transform(Matrix.Translation(-p))
    ob.matrix_world=Matrix.Translation(p)
for ob in out.values():
    ob.data.transform(Matrix.Scale(S,4))
    ob.matrix_world=Matrix.Translation((ob.matrix_world.translation-ORIGIN)*S)
    ob.data.transform(R)
    ob.matrix_world=Matrix.Translation(R@ob.matrix_world.translation)
    ob.data.update()
out['static']['belt']={'x':meta['beltY'],'width':round(meta['beltWidth'],5)}
for k in PULLEYS: out[k]['radius']=meta['pulleys'][k]['radius']
out['rod']['bottom']=meta['rodBottom']
out['spring']['moving']=meta['springMoving']
print('META',json.dumps(meta))
bpy.ops.object.select_all(action='DESELECT')
for ob in out.values(): ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT,export_format='GLB',use_selection=True,export_texcoords=False,export_normals=True,export_materials='EXPORT',export_image_format='NONE',export_yup=True,export_apply=True,export_extras=True)
