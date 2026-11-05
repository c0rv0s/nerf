import * as THREE from 'three';

const paintings = new Map();
export function orbitalArt(name) {
  if (!paintings.has(name)) {
    const map = new THREE.TextureLoader().load(new URL('../textures/'+name+'.webp', import.meta.url).href);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    if (name === 'asteroid-basalt') {
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(.66,.66);
    } else if (name !== 'kepler-panels') map.wrapS = THREE.RepeatWrapping;
    paintings.set(name,map);
  }
  return paintings.get(name);
}

let stars;
export function beltStarfield(random) {
  if (stars) return stars;
  const size = 1024;
  const faces = Array.from({length:6}, () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', {alpha:false});
    ctx.fillStyle = '#040610';
    ctx.fillRect(0,0,size,size);
    for (let i=0; i<2100; i++) {
      const x=random()*size, y=random()*size;
      const d=1+(2*x/size-1)**2+(2*y/size-1)**2;
      if (random()>1/(d*Math.sqrt(d))) continue;
      const brightness=random()**3, radius=(.39+brightness*.90)*Math.sqrt(d);
      const hue=random();
      ctx.fillStyle=hue<.15?'#ffdcad':hue>.65?'#abcfff':'#e3e8fa';
      ctx.globalAlpha=.29+brightness*.67;
      ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();
      if (brightness>.98) {
        const glow=ctx.createRadialGradient(x,y,0,x,y,4.4*radius);
        glow.addColorStop(0,'rgba(197,219,255,.36)');
        glow.addColorStop(1,'rgba(197,219,255,0)');
        ctx.fillStyle=glow;ctx.fillRect(x-5*radius,y-5*radius,10*radius,10*radius);
      }
    }
    return canvas;
  });
  stars=new THREE.CubeTexture(faces);
  stars.colorSpace=THREE.SRGBColorSpace;
  stars.needsUpdate=true;
  return stars;
}

function painted(m, key, paint) {
  m.onBeforeCompile = s => {
    s.vertexShader='varying vec3 vSurveyP,vSurveyN;\n'+s.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvSurveyP=(modelMatrix*vec4(transformed,1.)).xyz;vSurveyN=mat3(modelMatrix)*normal;');
    s.fragmentShader='varying vec3 vSurveyP,vSurveyN;\n'+s.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\n'+paint);
  };
  m.customProgramCacheKey=()=>key;
  return m;
}

export function beltBasalt(vertexColors=false) {
  const map = orbitalArt('asteroid-basalt');
  return painted(new THREE.MeshStandardMaterial({map, bumpMap:map, bumpScale:.09, roughness:.91, vertexColors}), 'belt-basalt', `
    vec3 p=vSurveyP;
    float fault=abs(sin(dot(p,vec3(.42,.83,.27))+.53*sin(p.x*.74+p.z*.54)+.29*sin(p.z*1.31+p.y*.64)));
    float vein=(1.-smoothstep(.013,.10,fault))*(.40+.60*smoothstep(-.6,.5,sin(p.z*.7+sin(p.x*1.38))));
    float branching=abs(sin(.85*p.x+p.y*1.67+.62*p.z+.61*sin(.78*p.z)));
    float fine=(1.-smoothstep(.012,.048,branching))*smoothstep(.23,.78,sin(.54*p.x+.37*p.z));
    float ore=max(vein*.78,fine*.44);
    diffuseColor.rgb=mix(diffuseColor.rgb*1.31,vec3(.62,.32,.116)*(.52+2.8*diffuseColor.r),ore);
  `);
}

export function surveyHull() {
  return painted(new THREE.MeshStandardMaterial({roughness:.73,metalness:.18}), 'kepler-hull', `
    vec3 p=vSurveyP,n=normalize(vSurveyN);
    bool deck=abs(n.y)>.65;
    vec2 uv=deck?p.xz:(abs(n.x)>.65?p.zy:p.xy);
    vec2 tile=uv/(deck?vec2(3.1,2.):vec2(3.1,.85));
    vec2 f=fract(tile), gate=min(f,1.-f);
    float id=fract(sin(dot(floor(tile),vec2(15.31,57.27)))*9374.21);
    vec3 base=deck?mix(vec3(.088,.148,.155),vec3(.23,.277,.266),id):
        mix(vec3(.025,.139,.151),vec3(.036,.18,.185),id);
    if(!deck && p.y>8.40)base=vec3(.63,.48,.31);
    if(!deck && p.y>8.77)base=vec3(.55,.09,.032);
    float seam=smoothstep(.004,.025,min(gate.x,gate.y));
    float stud=1.-smoothstep(.011,.022,length((gate-vec2(.043,.080))*vec2(1.,.67)));
    diffuseColor.rgb=base*(.46+.54*seam)+vec3(.18)*stud;
  `);
}

export function keplerFittings(batch) {
  const plates=new THREE.MeshStandardMaterial({map:orbitalArt('kepler-panels'), roughness:.77,metalness:.08,emissive:0xffffff,emissiveMap:orbitalArt('kepler-panels'),emissiveIntensity:.13});
  const copper=new THREE.MeshStandardMaterial({color:0xad6038,roughness:.53,metalness:.46});
  const vermilion=new THREE.MeshStandardMaterial({color:0xb74722,roughness:.75});
  const ivory=new THREE.MeshStandardMaterial({color:0xcab88c,roughness:.71});
  const lamp=new THREE.MeshBasicMaterial({color:0xffc077,toneMapped:false});
  function panel(x,y,z,w,h,yaw,tile,flat=false) {
    const g=new THREE.PlaneGeometry(w,h), uv=g.attributes.uv;
    for(let i=0;i<uv.count;i++)uv.setX(i,(tile+.006+.988*uv.getX(i))/3);
    if(flat)g.rotateX(-Math.PI/2);
    g.rotateY(yaw);g.translate(x,y,z);batch.add(g,plates);
  }
  for(const [z,yaw] of [[-1.945,0],[-10.04,Math.PI]]) {
    panel(-4.12,11.37,z,2.88,2.98,yaw,0);
    panel(4.12,11.37,z,2.88,2.98,yaw,1);
    for(const x of [-5.83,5.83]) {
      batch.box(x,11.29,z,.19,4.12,.19,vermilion);
      batch.box(x,12.82,z,.22,.48,.24,lamp);
    }
  }
  for(const sign of [-1,1]){
    const yaw=sign*Math.PI/2;
    for(const [z,t] of [[-7.65,2],[-4.36,1]])panel(sign*6.46,11.24,z,3.0,2.47,yaw,t);
    panel(sign*4.8,10.39,-6,1.22,2.82,sign>0?Math.PI:0,1,true);
    batch.box(sign*6.48,13.11,-6,.18,.34,7.12,vermilion);
    for(let i=0;i<3;i++) {
      batch.box(sign*(7.7+i*.36),7.78,10.05,.13,.92,.12,copper);
      batch.box(sign*(7.7+i*.36),7.34,9.77,.13,.12,.65,copper);
    }
    for(const x of [-9.6,-8.5,-7.4,7.4,8.5,9.6])
      batch.box(x,8.83,sign*9.98,.36,.26,.085,vermilion);
    panel(sign*22.03,8.41,0,1.58,.69,sign*Math.PI/2,0);
    for(const x of [-11.2,11.2])panel(x,7.96,sign*10.035,2.55,1.48,sign>0?0:Math.PI,2);
    panel(0,8.0,sign*10.035,2.35,1.63,sign>0?0:Math.PI,0);
    for(const z of [-3,2.3,6.5])batch.box(sign*2.55,9.019,z,.12,.018,2.0,ivory);
  }
  for(const z of [-8.8,-5.9,-3.0]) {
    batch.box(-5.60,12.0,z,.09,.14,.66,lamp);
    panel(5.61,11.68,z,1.85,1.32,-Math.PI/2,1);
  }
}

export function beltSpecimens(scene,landings) {
  const specimens=[];
  for(const {x,y,z,w,d} of landings) {
    const seed=Math.abs(29*x+13*z);
    if(w<7 || seed%3===0)continue;
    for(let i=0;i<4;i++) {
      const a=seed+i*2.4;
      specimens.push([x+(seed%2?1:-1)*w*.38+Math.cos(a)*.26,y+.04,z+Math.sin(seed)*d*.24+Math.sin(a)*.24,a,i]);
    }
  }
  const chips=new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1,0),
    new THREE.MeshStandardMaterial({color:0x63c8bf,roughness:.43,metalness:.19,emissive:0x073132,flatShading:true}), specimens.length);
  const stamp=new THREE.Object3D();
  specimens.forEach(([x,y,z,a,i],j)=>{
    stamp.position.set(x,y,z);stamp.rotation.set(.3*Math.sin(a),a,.25*Math.cos(a));
    stamp.scale.set(.12+i*.027,.16+i*.072,.13+i*.036);stamp.updateMatrix();chips.setMatrixAt(j,stamp.matrix);
  });
  chips.name='belt-mineral-samples'; scene.add(chips);
}
