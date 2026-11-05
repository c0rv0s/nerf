import * as THREE from 'three';
import { EnvironmentBatch } from './environment-design.js';

const art = new Map();
function texture(name) {
  if (!art.has(name)) {
    const t = new THREE.TextureLoader().load(new URL('../textures/' + name + '.webp', import.meta.url).href);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    art.set(name, t);
  }
  return art.get(name);
}

export function citySky(scene) {
  const map = texture('neon-night-skyline');
  map.wrapS = THREE.MirroredRepeatWrapping;
  const g = new THREE.SphereGeometry(410, 80, 48), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i)*4, THREE.MathUtils.clamp(.09+(uv.getY(i)-.5)*2.25, 0, 1));
  scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({map, side:THREE.BackSide, fog:false})));
}

const noise = `
float cityHash(vec2 p) { return fract(sin(dot(mod(p,997.),vec2(12.9898,78.233)))*4375.5453); }
float cityNoise(vec2 p) {
  vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(cityHash(i),cityHash(i+vec2(1,0)),f.x),mix(cityHash(i+vec2(0,1)),cityHash(i+1.),f.x),f.y);
}`;
const rooms = `
vec3 p=vCityPos; vec3 n=normalize(vCityNormal);
if(abs(n.y)<.5){
  vec2 wall=vec2(abs(n.x)>.5?p.z:p.x,p.y);
  vec2 tile=wall/vec2(3.15,2.8), st=fract(tile);
  float id=cityHash(floor(tile)+floor(dot(p.xz,n.xz))*1.71);
  float rim=smoothstep(.13,.16,st.x)*(1.-smoothstep(.83,.86,st.x))*smoothstep(.24,.28,st.y)*(1.-smoothstep(.79,.83,st.y));
  float slat=1.-.55*smoothstep(.012,.025,.04-abs(st.x-.49));
  float blind=.65+.35*smoothstep(.015,.06,fract(st.y*6.));
  vec3 tint=mix(vec3(.05,.40,.54),vec3(.97,.45,.17),step(.58,id));
  tint=mix(tint,vec3(.88,.15,.36),step(.89,id));
  diffuseColor.rgb=vec3(.018,.024,.049)+diffuseColor.rgb*.17+vec3(.018,.014,.029)*smoothstep(.80,.84,st.y);
  float curtain=.43+.57*smoothstep(.05,.58,abs(sin((st.x+.13*id)*9.4)));
  cityLight=rim*slat*blind*curtain*tint*(id>.64?.08+.42*id:.012);
  if(p.x>=-24.02 && p.x<=.02 && p.z>=-50.02 && p.z<=-25.98 && p.y<=20.01){
    diffuseColor.rgb=vec3(.068,.021,.071)+vec3(.018,.011,.024)*cityNoise(wall*.24);
    cityLight*=.07;
  }
} else { diffuseColor.rgb=vec3(.054,.058,.091)+.14*diffuseColor.rgb; }`;
const street = `
vec2 p=vCityPos.xz;
float pools=cityNoise(p*vec2(.24,.60));
float ripple=cityNoise(p*vec2(1.7,9.0));
vec3 ray=reflect(normalize(vCityPos-cameraPosition),vec3(0,1,0));
vec2 r=ray.xz/max(.085,ray.y);
vec2 jitter=vec2(ripple-.5,pools-.5)*1.8;
vec2 a=(p+14.0*r+jitter-vec2(-12,-26))/vec2(11,3.8);
vec2 b=(p+5.0*r+jitter-vec2(.2,-33))/vec2(3.2,10.);
vec2 c=(p+7.0*r+jitter-vec2(-22,0))/vec2(26.,3.3);
vec2 grid = abs(fract((p+vec2(1.5*mod(floor(p.y/2.8),2.),0.))/vec2(3.,2.8)+.5)-.5);
float joint=smoothstep(.0,.014,min(grid.x,grid.y));
float wet=smoothstep(.20,.79,pools)*(.10+1.42*ripple*ripple)*(.55+.45*joint);
vec2 pad=(p+1.1*r+jitter*.36-vec2(4.,-13.))/vec2(2.2,1.5);

diffuseColor.rgb=vec3(.024,.032,.060)*(.32+.48*pools+.14*ripple)*(.62+.38*joint);
cityLight=wet*(vec3(.015,.64,.85)/(1.+dot(pad,pad))+vec3(.95,.028,.23)/(1.+dot(a,a))+vec3(.19,.25,.95)/(1.+dot(b,b))+vec3(.015,.52,.67)/(1.+dot(c,c)));
`;

export function citySurface(kind, options={}) {
  const {tex, repeat, ...props} = options;
  const m=new THREE.MeshStandardMaterial({color:0xffffff, roughness:kind==='road'?.48:.8, ...props});
  m.onBeforeCompile=s=>{
    s.vertexShader='varying vec3 vCityPos, vCityNormal;\n'+s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvCityPos=(modelMatrix*vec4(transformed,1.)).xyz; vCityNormal=mat3(modelMatrix)*normal;');
    s.fragmentShader='varying vec3 vCityPos, vCityNormal;\n'+noise+'\n'+s.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\nvec3 cityLight=vec3(0.);\n'+(kind==='road'?street:rooms)).replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance+=cityLight;');
  };
  m.customProgramCacheKey=()=>'neon-city-'+kind;
  return m;
}

const signs = new Map();
function marquee(blade) {
  if(signs.has(blade)) return signs.get(blade);
  const c=document.createElement('canvas'); c.width=blade?192:1024; c.height=blade?896:256;
  const g=c.getContext('2d'), w=c.width,h=c.height;
  const gradient=g.createLinearGradient(0,0,w,h); gradient.addColorStop(0,'#312039'); gradient.addColorStop(.46,'#120e24'); gradient.addColorStop(1,'#49253d');
  g.fillStyle=gradient;g.fillRect(0,0,w,h);
  for (const [k,color] of [[5,'#5c9fa8'],[12,'#ff8bbd'],[21,'#8d4565']]) {
    g.strokeStyle=color;g.lineWidth=k===12?3:2;g.strokeRect(k,k,w-2*k,h-2*k);
  }
  g.textAlign='center';g.textBaseline='middle';g.lineJoin='round';
  const letters=(txt,x,y,size)=>{
    g.font='italic 900 '+size+'px Arial, sans-serif';g.shadowColor='#ff247f';g.shadowBlur=17;
    g.strokeStyle='#ff498b';g.lineWidth=7;g.strokeText(txt,x,y);g.shadowBlur=0;
    g.fillStyle='#793253';g.fillText(txt,x,y);g.lineWidth=1.8;g.strokeStyle='#fff0de';g.strokeText(txt,x,y);
  };
  if(blade) Array.from('ARCADE').forEach((s,i)=>letters(s,w/2,99+i*137,115));
  else {
    for (const side of [-1,1]) for(let j=0;j<3;j++) {
      g.fillStyle=j===1?'#ffabc8':'#4ababc';g.fillRect(w/2+side*403-(side===1?0:64),119+j*10,64-j*8,3);
    }
    g.fillStyle='#79e9e2';g.font='bold 26px Arial';g.fillText('M I D N I G H T',w/2,49);
    letters('ARCADE',w/2,153,153);
  }
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=8;
  const m=new THREE.MeshBasicMaterial({map:t,toneMapped:false});signs.set(blade,m);return m;
}

export function arcadeFront(scene) {
  const batch=new EnvironmentBatch(scene);
  const panel=new THREE.MeshBasicMaterial({map:texture('neon-prize-windows')});
  const ink=new THREE.MeshStandardMaterial({color:0x322638,metalness:.35,roughness:.45});
  const pink=new THREE.MeshBasicMaterial({color:0xff87b5,toneMapped:false});
  const mint=new THREE.MeshBasicMaterial({color:0x71cfcc,toneMapped:false});
  function face(x,y,z,w,h,yaw,material,tile) {
    const g=new THREE.PlaneGeometry(w,h);
    if(tile!==undefined) {
      const uv=g.attributes.uv;
      for(let i=0;i<uv.count;i++)uv.setX(i,(tile+.006+.988*uv.getX(i))/3);
    }
    g.rotateY(yaw);g.translate(x,y,z);batch.add(g,material);
  }
  function display(x,y,z,w,h,yaw,tile) {
    batch.box(x,y,z,w+.15,h+.17,.09,ink,yaw);
    face(x+Math.sin(yaw)*.06,y,z+Math.cos(yaw)*.06,w,h,yaw,panel,tile);
  }
  batch.box(-12,12.14,-25.82,20.6,3.55,.32,ink);
  face(-12,12.14,-25.64,20.4,3.48,0,marquee(false));
  batch.box(.58,11.5,-28.4,.99,12.5,2.48,ink);
  face(1.09,11.5,-28.4,2.43,12.38,Math.PI/2,marquee(true));
  for(const [y,m] of [[4.35,mint],[4.58,pink],[14.48,mint],[17.58,pink],[17.84,mint],[19.60,pink]]) {
    batch.box(-12,y,-25.87,24,.085,.22,m);
    batch.box(.13,y,-38,.22,.085,24,m);
  }
  // Ribbon windows flank the actual sniper opening.
  for(const x of [-20,-4]) {
    display(x,7.96,-25.90,7.65,2.03,0,2);
    for(const dx of [-2,0,2]) batch.box(x+dx,7.96,-25.78,.07,2.12,.1,ink);
  }
  for(const z of [-30,-38,-46]){
    display(.06,7.96,z,7.70,2.03,Math.PI/2,2);
    for(const dz of [-2,0,2])batch.box(.15,7.96,z+dz,.09,2.12,.07,ink);
  }
  for(const x of [-1,.8,2.6,4.4])batch.box(x,11.38,-20,.07,.03,5.6,pink);
  for(const x of [-23.66,-.34])for(const dx of [-.13,.13])batch.box(x+dx,16.8,-25.85,.095,5.24,.16,mint);
  for(const [x,w,t] of [[-22,3.45,0],[-12,6.9,1],[-2,3.45,0]]) display(x,2.17,-25.92,w,3.38,0,t);
  for(const [z,t] of [[-30.8,0],[-36.8,1],[-47.0,1]])display(.06,2.24,z,4.9,3.65,Math.PI/2,t);
  for(const x of [24,32,40])display(x,3.0,-21.93,7.0,4.9,0,2);
  for(const x of [-23,-12,-1])display(x,2.0,21.93,x===-12?7:4.2,3.15,Math.PI,2);
  for(const [x,z,t] of [[-26,5,1],[28,-14,0],[42,13,2],[-65,12,1]])display(x,.72,z+1.06,6.6,1.12,0,t);
  batch.flush('neon-shopfronts');
}

export function palmFeather(curve,angle,scale){
  const pts=[], side=new THREE.Vector3(-Math.sin(angle),0,Math.cos(angle));
  const tri=(a,b,c)=>pts.push(...a.toArray(),...b.toArray(),...c.toArray());
  for(let i=0;i<11;i++){
    const t=i/11, a=curve.getPoint(t), b=curve.getPoint((i+1)/11);
    for(const sign of [-1,1]){
      const width=(.12+.46*Math.sin(Math.PI*(.10+.87*t)))*scale;
      const tip=curve.getPoint(Math.min(1,t+.18)).addScaledVector(side,sign*width);tip.y-=width*.6;
      tri(a,b,tip);
    }
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));g.computeVertexNormals();return g;
}
