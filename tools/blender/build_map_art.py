"""Editable, deterministic Nerf art library. Run with Blender --background --python this_file.
Author in game coordinates (Y up); save in Blender Z up; export evaluated meshes back to Y up.
Every collection is one runtime mesh, with material colors baked into vertex colors.
"""
import bpy, math, json, pathlib
from mathutils import Vector
from math import sin, cos, pi
ROOT = pathlib.Path(__file__).resolve().parents[2]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for c in list(bpy.data.collections):
    if c.name != 'Collection': bpy.data.collections.remove(c)
MATS = {}
COL = None

def coord(p): return (p[0], -p[2], p[1])
def color(hex):
    v = [(hex >> s & 255) / 255 for s in (16,8,0)]
    return tuple(x / 12.92 if x <= .04045 else ((x+.055)/1.055)**2.4 for x in v)
def material(hex):
    if hex not in MATS:
        m = bpy.data.materials.new(f'pigment_{hex:06x}')
        m.diffuse_color = (*color(hex),1)
        m.use_nodes = True
        p = m.node_tree.nodes.get('Principled BSDF')
        p.inputs['Base Color'].default_value = m.diffuse_color
        p.inputs['Roughness'].default_value = .65
        MATS[hex] = m
    return MATS[hex]
def asset(name):
    global COL
    COL = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(COL)
def adopt(o,name,col):
    o.name = name
    for c in list(o.users_collection): c.objects.unlink(o)
    COL.objects.link(o)
    o.data.materials.append(material(col))
    return o
def mesh(name,verts,faces,col,smooth=False):
    m=bpy.data.meshes.new(name)
    m.from_pydata([coord(p) for p in verts],[],faces); m.update()
    o=bpy.data.objects.new(name,m); COL.objects.link(o)
    m.materials.append(material(col))
    for f in m.polygons: f.use_smooth=smooth
    return o
def ell(name,p,s,col,seg=12,rings=8):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg,ring_count=rings,location=coord(p))
    o=adopt(bpy.context.object,name,col); o.scale=(s[0],s[2],s[1])
    for f in o.data.polygons: f.use_smooth=True
    return o
def box(name,p,s,col,bevel=.04):
    bpy.ops.mesh.primitive_cube_add(size=1,location=coord(p))
    o=adopt(bpy.context.object,name,col); o.scale=(s[0],s[2],s[1])
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if bevel:
        mod=o.modifiers.new('Soft carved edges','BEVEL'); mod.width=bevel; mod.segments=1
        mod=o.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL')
    return o
def tube(name,points,r,col,sides=6):
    verts=[]; previous_u=None
    for i,p in enumerate(points):
        tangent=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])
        tangent.normalize()
        u=previous_u-tangent*previous_u.dot(tangent) if previous_u is not None else tangent.cross(Vector((0,1,0)))
        if u.length < .01: u=tangent.cross(Vector((0,0,1)))
        u.normalize(); previous_u=u.copy(); v=tangent.cross(u).normalized()
        rr=r[i] if isinstance(r,list) else r
        verts += [tuple(Vector(p)+rr*(u*cos(a*2*pi/sides)+v*sin(a*2*pi/sides))) for a in range(sides)]
    faces=[tuple(reversed(range(sides)))]
    for j in range(len(points)-1):
        for k in range(sides): faces.append((j*sides+k,j*sides+(k+1)%sides,(j+1)*sides+(k+1)%sides,(j+1)*sides+k))
    faces.append(tuple((len(points)-1)*sides+k for k in range(sides)))
    return mesh(name,verts,faces,col,True)
def blade(name,pts,thick,col):
    # Closed polygon with beveled edges, including non-convex silhouettes.
    normal=(Vector(pts[1])-Vector(pts[0])).cross(Vector(pts[2])-Vector(pts[0])).normalized()
    verts=[tuple(Vector(p)+normal*dz) for dz in (-thick/2,thick/2) for p in pts]; n=len(pts)
    faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name,verts,faces,col)
def leaf(name,start,end,width,col,steps=6):
    a,b=Vector(start),Vector(end); d=b-a
    side=d.cross(Vector((0,1,0)))
    if side.length<.001: side=Vector((1,0,0))
    side.normalize(); verts=[]
    for i in range(steps+1):
        t=i/steps; center=a+d*t+Vector((0,sin(pi*t)*width*.5,0))
        w=max(.002,sin(pi*t)**.85*width)
        verts.extend([tuple(center-side*w),tuple(center+Vector((0,width*.12*sin(pi*t),0))),tuple(center+side*w)])
    faces=[]
    for i in range(steps):
        for j in range(2): faces.append((i*3+j,(i+1)*3+j,(i+1)*3+j+1,i*3+j+1))
    o=mesh(name,verts,faces,col,True)
    return o

def statue(kind):
    asset('statue_'+kind)
    stone=0xcbb994; gold=0xd9ad51; dark=0x6b512f
    # Capsule silhouette retained at original 2.45x character scale.
    tube('pill torso',[(0,1.02,0),(0,1.35,0),(0,2.75,0),(0,3.08,0)],[.38,1.03,1.03,.38],stone,16)
    ell('rounded shoulders',(0,2.82,0),(1.03,.63,1.03),stone,16)
    ell('rounded base',(0,1.25,0),(1.03,.64,1.03),stone,16)
    ell('pill head',(0,3.97,0),(.735,.735,.735),stone,16,10)
    box('inset visor',(0,4.07,.69),(1.02,.34,.17),0x34434b,.07)
    # Draped ceremonial sash wraps the torso, pleats follow the lower curve.
    for i in range(7):
        x=-.7+i*.23; z=math.sqrt(max(.01,1.06**2-x*x))
        tube('carved robe pleat',[(x,2.65,z),(x*.92,1.9,z+.04),(x*.85,1.02,z*.85)],[.075,.065,.025],0xae9b7a,5)
    tube('diagonal gold sash',[(-.87,2.7,.58),(-.5,2.48,.97),(0,2.1,1.075),(.6,1.62,.85),(.88,1.35,.52)],.09,gold)
    for side in (-1,1):
        # Leaf-by-leaf laurel, rather than a solid conical hat.
        for i in range(6):
            a=.18+i*.25; x=side*.77*sin(a); z=.77*cos(a)
            leaf('laurel leaf',(x,4.4,z),(x+side*.23,4.65+i*.025,z-.09),.11,gold)
    if kind in ('winged','hermes'):
        for side in (-1,1):
            for i in range(6):
                start=Vector((side*.5,2.82,-.6))
                end=Vector((side*(1.1+i*.26),5.15-i*.2,-.66))
                d=end-start; across=Vector((-d.y,d.x,0)).normalized()*.14
                blade('overlapping flight feather',[tuple(start),tuple(start+d*.38+across),tuple(start+d*.85+across*.8),tuple(end),tuple(start+d*.8-across*.7),tuple(start+d*.26-across)],.1,gold if i%2 else 0xb9893f)
        if kind=='hermes':
            for side in (-1,1):
                for i in range(3): leaf('winged helmet',(side*.57,4.34,0),(side*(1.1+i*.18),4.58+i*.25,-.18),.13,gold)
    if kind in ('sun','winged'):
        pts=[(sin(i*2*pi/32)*1.18,4.22+cos(i*2*pi/32)*1.18,-.54) for i in range(33)]
        tube('sun halo',pts,.085,gold)
        if kind=='sun':
            for i in range(12):
                a=i*pi/6
                tube('sun ray',[(sin(a)*1.32,4.22+cos(a)*1.32,-.54),(sin(a)*1.66,4.22+cos(a)*1.66,-.54)],[.085,.01],gold)
    if kind in ('guardian','trident','thunder'):
        for i in range(5):
            x=(i-2)*.28
            blade('crown crenellation',[(x-.16,4.47,.08),(x-.12,4.85,.08),(x,5.22-abs(i-2)*.13,.08),(x+.12,4.85,.08),(x+.16,4.47,.08)],.3,gold)
    if kind=='guardian':
        blade('sword blade',[(1.8,1.35,.45),(1.68,4.65,.45),(1.98,5.2,.45),(2.22,4.65,.45),(2.08,1.35,.45)],.16,gold)
        tube('sword fuller',[(1.94,1.7,.55),(1.96,4.6,.55)],.028,0xf6d988,4)
        box('crossguard',(1.94,1.34,.45),(1.1,.16,.3),dark)
        tube('sword grip',[(1.94,.75,.45),(1.94,1.34,.45)],.12,dark)
        ell('shield',(-1.12,2.34,.72),(.79,1.05,.19),gold,16,10)
        tube('shield rim',[(-1.12+sin(a*2*pi/24)*.7,2.34+cos(a*2*pi/24)*.96,.83) for a in range(25)],.055,dark)
        blade('shield sun emblem',[(-1.12,2.95,.94),(-.77,2.34,.94),(-1.12,1.73,.94),(-1.47,2.34,.94)],.035,0xf3ddaa)
    if kind=='trident':
        tube('trident staff',[(1.64,.18,.13),(1.64,5.3,.13)],.09,dark)
        tube('trident fork',[(1.13,5.7,.13),(1.13,5.02,.13),(1.64,4.83,.13),(2.15,5.02,.13),(2.15,5.7,.13)],.095,gold)
        for x,y in [(1.13,5.7),(1.64,5.98),(2.15,5.7)]:
            blade('trident spear',[(x-.14,y-.25,.13),(x,y+.32,.13),(x+.14,y-.25,.13)],.16,gold)
    if kind=='thunder':
        blade('lightning bolt',[(1.63,4.6,.3),(.96,3.03,.3),(1.53,3.15,.3),(1.02,1.25,.3),(2.35,3.59,.3),(1.7,3.4,.3),(2.23,4.6,.3)],.2,0xffd778)

for k in ('hermes','sun','guardian','trident','winged','thunder'):
    statue(k)
    for obj in COL.objects: obj.location.z -= .59

# Fish: cross-sections give each species its own face, abdomen and narrow caudal joint.
for kind,height,width,primary,accent in [('tang',.65,.24,0x2877d2,0xffd84b),('butterfly',.76,.19,0xf0d867,0x252e39),('parrot',.43,.33,0x35bba9,0xe977a0),('angel',.8,.18,0xe1dfe0,0x333744)]:
    asset('fish_'+kind)
    verts=[]; rings=12
    stations=[(.85,.05),(.69,.5),(.35,.94),(-.12,1),(-.52,.65),(-.8,.14)]
    for x,s in stations:
        for i in range(rings):
            a=i*2*pi/rings; verts.append((x,sin(a)*height*s,cos(a)*width*s))
    faces=[]
    for j in range(len(stations)-1):
        for i in range(rings): faces.append((j*rings+i,j*rings+(i+1)%rings,(j+1)*rings+(i+1)%rings,(j+1)*rings+i))
    faces.extend([tuple(reversed(range(rings))),tuple(range((len(stations)-1)*rings,len(stations)*rings))])
    mesh('contoured body',verts,faces,primary,True)
    blade('tail fan',[(-.76,0,0),(-1.29,.43,0),(-1.14,0,0),(-1.29,-.43,0)],.045,accent)
    finH=1.3 if kind=='angel' else height*1.32
    blade('dorsal sail',[(.35,height*.76,0),(-.22,finH,0),(-.69,height*.54,0)],.035,accent)
    blade('anal fin',[(.17,-height*.75,0),(-.33,-finH*.83,0),(-.7,-height*.36,0)],.035,accent)
    for side in (-1,1):
        ell('eye',(.55,.15,side*width*.71),(.065,.065,.03),0x08151d,8,6)
        ell('eye glint',(.569,.17,side*(width*.71+.025)),(.02,.02,.01),0xe5f1da,6,4)
        leaf('pectoral fin',(.25,-.05,side*width),(-.15,-.3,side*(width+.24)),.15,accent)
        if kind in ('angel','butterfly'):
            for x in (-.27,.16): tube('vertical stripe',[(x,height*.81,side*.09),(x,.2,side*(width+.007)),(x,-.3,side*width*.93),(x,-height*.8,side*.08)],.045,accent,4)
        else:
            tube('gill contour',[(.43,.27,side*width*.83),(.32,0,side*(width+.01)),(.4,-.23,side*width*.87)],.022,accent,4)

# Organic understory plants. Leaves carry a folded center ridge and curved tips.
asset('fern')
for i in range(7):
    a=i*2*pi/7; d=Vector((cos(a),0,sin(a))); length=1.05+(i%3)*.2
    pts=[tuple(d*(t*length)+Vector((0,sin(t*pi*.78)*.85,0))) for t in (0,.25,.5,.75,1)]
    tube('arching rachis',pts,[.025,.022,.018,.012,.005],0x66864a,5)
    for j in range(1,7):
        t=j/7; center=d*(t*length)+Vector((0,sin(t*pi*.78)*.85,0)); across=Vector((-d.z,0,d.x))
        for side in (-1,1):
            end=center+across*side*(.29*(1-t)+.055)+d*.16+Vector((0,.045,0))
            leaf('paired fern leaflet',center,end,.065*(1-t)+.025,0x397352 if j%2 else 0x57955e)
asset('broadleaf')
for i in range(8):
    a=i*2*pi/8; end=(cos(a)*(1+(i%2)*.3),.75+(i%3)*.4,sin(a)*(1+(i%2)*.3))
    tube('petiole',[(0,0,0),(end[0]*.36,end[1]*.68,end[2]*.36)],.035,0x4f7847)
    leaf('folded lance leaf',(end[0]*.2,end[1]*.43,end[2]*.2),end,.26,0x487d55 if i%2 else 0x72a36b)
asset('conservatory_leaf')
leaf('curved palm blade',(0,-.5,0),(.16,.5,.07),.3,0xffffff)
asset('kelp')
for i in range(4):
    a=i*2*pi/4; h=1.3+(i%3)*.55; pts=[]
    for j in range(4):
        t=j/3; pts.append((cos(a)*(.15+sin(t*3)*.3),t*h,sin(a)*(.15+t*.4)))
    tube('kelp stipe',pts,[.035,.03,.02,.004],0x8b9e49,4)
    for j in range(1,4):
        p=Vector(pts[j]); end=p+Vector((cos(a+j)*.55,.24,sin(a+j)*.55))
        leaf('waving kelp blade',p,end,.16,0x609766 if j%2 else 0xa8ae55,steps=3)

for variant in range(3):
    asset('mushrooms_'+str(variant))
    for j in range(3):
        x=(j-1)*.62; z=sin(j*2+variant)*.25; h=.65+j*.24; r=.42+j*.12
        tube('curved stalk',[(x,0,z),(x-.13,h*.5,z+.06),(x,h,z)],[.12,.085,.07],0xc3c6a0)
        verts=[]; n=16
        profile=[(0,h+.27),(r*.44,h+.23),(r*.84,h+.1),(r,h-.07),(r*.9,h-.16),(r*.25,h-.19),(0,h-.19)]
        for rr,y in profile:
            for k in range(n):
                a=k*2*pi/n; uneven=1+.07*sin(a*3+variant)
                verts.append((x+cos(a)*rr*uneven,y+.04*sin(a*2+j)*(rr/r),z+sin(a)*rr*uneven))
        faces=[]
        for ring in range(len(profile)-1):
            for k in range(n): faces.append((ring*n+k,ring*n+(k+1)%n,(ring+1)*n+(k+1)%n,(ring+1)*n+k))
        o=mesh('sculpted cap',verts,faces,[0xad729d,0xd0a160,0x72ab9e][variant],True)
        for k in range(12):
            a=k*2*pi/12
            tube('underside gill',[(x+cos(a)*r*.22,h-.185,z+sin(a)*r*.22),(x+cos(a)*r*.85,h-.13,z+sin(a)*r*.85)],.014,0xe1d9ad,4)
        for k in range(5):
            a=k*2.4+j; ell('cap speckle',(x+cos(a)*r*.53,h+.2,z+sin(a)*r*.53),(.045,.019,.045),0xe7d7b5,6,4)
asset('root_cluster')
for i in range(5):
    a=i*2*pi/5
    tube('twisted exposed root',[(0,.55,0),(cos(a)*.45,.3,sin(a)*.45),(cos(a+.2)*.85,.13,sin(a+.2)*.85),(cos(a+.35)*1.4,0,sin(a+.35)*1.4)],[.18,.14,.09,.012],0x77674e,7)

asset('snail')
ell('soft foot',(0,.13,0),(.66,.15,.23),0x82b6a0)
ell('head',(.48,.27,0),(.2,.22,.19),0xa0d1b5)
ell('shell',(-.12,.57,0),(.42,.45,.29),0x658ca0,16,10)
for side in (-1,1):
    pts=[]
    for i in range(49):
        t=i/48; a=t*pi*4.2; r=.34*(1-t)+.025
        pts.append((-.12+cos(a)*r,.57+sin(a)*r,side*(.29*math.sqrt(max(.01,1-(r/.42)**2))+.019)))
    tube('luminous shell spiral',pts,.022,0xb6eed0,5)
    tube('eyestalk',[(.49,.36,side*.09),(.65,.63,side*.17)],[.035,.021],0xa0d1b5)
    ell('eye',(.65,.64,side*.17),(.04,.04,.04),0x233b3d,8,6)
asset('beetle')
ell('thorax',(.3,.23,0),(.18,.2,.19),0x355861)
ell('left elytron',(-.08,.27,.12),(.34,.22,.15),0x388f83)
ell('right elytron',(-.08,.27,-.12),(.34,.22,.15),0x53a596)
ell('head',(.49,.21,0),(.12,.12,.15),0x263d48)
for side in (-1,1):
    for j in range(3):
        x=.23-j*.2
        tube('jointed leg',[(x,.25,side*.13),(x-.12,.19,side*.37),(x+.07,.02,side*.47)],[.027,.023,.013],0x344753,5)
    tube('antenna',[(.5,.27,side*.1),(.67,.4,side*.15),(.76,.39,side*.23)],.018,0xc8b678,5)
asset('crab')
ell('carapace',(0,.28,0),(.45,.23,.32),0xb97155)
for side in (-1,1):
    for j in range(4):
        z=-.24+j*.15
        tube('walking leg',[(side*.3,.28,z),(side*.62,.18,z-.08),(side*.76,.015,z+.07)],[.043,.033,.019],0xd2936b,5)
    tube('claw arm',[(side*.3,.3,.22),(side*.6,.4,.43),(side*.55,.48,.65)],.07,0xb97155)
    ell('claw palm',(side*.54,.47,.7),(.16,.13,.19),0xe0a478)
    for k in (-1,1): tube('pincer',[(side*.54+k*.1,.48,.77),(side*.54+k*.08,.5,.95),(side*.54,.5,1.01)],[.065,.04,.008],0xe8b68a,5)
    tube('eyestalk',[(side*.18,.4,.21),(side*.2,.6,.28)],.026,0x9b6b52)
    ell('eye',(side*.2,.6,.28),(.05,.05,.05),0x26363a,8,6)

# Large animals preserve game dimensions and animation pivot locations.
def loft(name,stations,top,belly,n=16):
    verts=[]
    for x,w,ty,by in stations:
        for i in range(n):
            a=i*2*pi/n; sy=sin(a); verts.append((x,sy*(ty if sy>=0 else -by),cos(a)*w))
    faces=[]
    for j in range(len(stations)-1):
        for i in range(n): faces.append((j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i))
    faces.extend([tuple(reversed(range(n))),tuple(range((len(stations)-1)*n,len(stations)*n))])
    o=mesh(name,verts,faces,top,True); o.data.materials.append(material(belly))
    for p in o.data.polygons:
        # Blender Z is game Y.
        if p.center.z < -.1: p.material_index=1
    return o
asset('whale_body')
loft('blue whale body',[(14.15,2.15,.72,-1.45),(13.55,3.32,1.02,-1.92),(12.15,3.62,1.28,-2.18),(9.55,3.55,1.58,-2.35),(6.25,3.32,1.88,-2.45),(2.65,3,2.02,-2.38),(-.85,2.66,1.92,-2.15),(-4.15,2.25,1.66,-1.78),(-7.1,1.68,1.28,-1.28),(-9.55,1.06,.82,-.78),(-11.45,.48,.4,-.36),(-12.35,.2,.18,-.16)],0x416c82,0x86a6b0,20)
blade('swept dorsal',[(-3.15,1.65,0),(-4.3,2.25,0),(-5.1,2.7,0),(-5.0,1.7,0),(-5.92,1.46,0)],.22,0x355c72)
for side in (-1,1):
    tube('jaw seam',[(14.2,-.48,side*2.05),(13.4,-.25,side*3.3),(11,-.16,side*3.57),(8.2,-.3,side*3.44),(6.2,-.55,side*3.18)],.045,0x244b61)
    ell('whale eye',(8.5,.3,side*3.44),(.17,.12,.065),0x111f2c,10,6)
    for j in range(5):
        z=side*(.3+j*.37)
        tube('throat pleat',[(13.7,-1.22,z),(11.7,-2.01,z*1.12),(8.7,-2.27,z*1.12),(5.5,-2.35,z*.9)],.025,0x658897,5)
    ell('blowhole',(9.35,1.57,side*.19),(.22,.045,.1),0x213f51,8,6)
asset('whale_fluke')
# local pivot at -12.35, 0, 0, lateral span comparable to original
for side in (-1,1):
    blade('fluke lobe',[(0,0,0),(-.7,.08,side*.8),(-1.8,.16,side*3.5),(-3.6,.16,side*5.3),(-3.05,.08,side*2.1),(-3.45,0,side*.5),(-2.6,0,0)],.16,0x416c82)
for side,which in [(1,'left'),(-1,'right')]:
    asset('whale_'+which+'_pec')
    blade('curved pectoral',[(.2,0,0),(.0,.02,side*3.35),(-1.7,.04,side*7),(-5.4,-.05,side*10),(-4.3,-.03,side*6.8),(-2.8,0,side*5.2),(-1.8,0,side)],.14,0x577e91)
asset('shark_body')
loft('great white body',[(3.35,.42,.34,-.3),(3.02,.82,.62,-.58),(2.3,.98,.78,-.72),(1.1,1.04,.86,-.78),(-.25,.94,.82,-.7),(-1.35,.68,.61,-.5),(-2.15,.38,.36,-.3),(-2.75,.18,.18,-.15)],0x64747b,0xd9ded4,16)
blade('swept dorsal',[(.65,.72,0),(.04,1.7,0),(-.25,1.9,0),(-.31,1.02,0),(-.82,.66,0)],.11,0x52646c)
for side in (-1,1):
    ell('black eye',(2.42,.28,side*.92),(.085,.07,.045),0x080f17,10,6)
    tube('mouth crease',[(3.05,-.24,side*.76),(2.68,-.37,side*.89),(2.1,-.43,side*.91),(1.8,-.35,side*.94)],.027,0x273944,5)
    for j in range(5):
        x=1.45-j*.17
        tube('gill slit',[(x+.04,.32,side*.97),(x,.05,side*1.043),(x-.08,-.34,side*.96)],.025,0x344750,4)
    for j in range(4):
        x=2.12+j*.19
        blade('tooth',[(x,-.36,side*.93),(x+.09,-.38,side*.93),(x+.04,-.47,side*.93)],.018,0xf0eee0)
asset('shark_tail')
blade('crescent caudal fin',[(0,0,0),(-.5,.95,0),(-1.1,1.78,0),(-.93,.58,0),(-.77,.13,0),(-.88,-.45,0),(-1.1,-1.48,0),(-.56,-.87,0)],.1,0x637780)
for side,which in [(1,'left'),(-1,'right')]:
    asset('shark_'+which+'_pec')
    blade('swept pectoral',[(0,0,0),(-.6,.02,side*1.13),(-2.23,0,side*1.93),(-1.81,0,side*.66),(-1.77,0,side*.03)],.07,0x778d94)

import runpy
runpy.run_path(str(ROOT/'tools/blender/export_map_art.py'))
OUT=ROOT/'assets/models'
# Collections are separate, at original game origins. Hide all but guardian for opening.
for coll in bpy.context.scene.collection.children:
    coll.hide_viewport=coll.name!='statue_guardian'
    coll.hide_render=coll.name!='statue_guardian'
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'map-art.blend'))

