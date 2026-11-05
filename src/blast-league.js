import * as THREE from 'three';
import {EnvironmentBatch, roundedDeckGeometry} from './environment-design.js';

const palette = ['#132d3e','#f15a31','#f7e3ab','#4cb9b9'];
const graphics = new Map();
const printDepth = {polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-8};
const printGap = .04;
function leaguePrint(label, number, accent) {
  const key = label+number;
  if (graphics.has(key)) return graphics.get(key);
  const c=document.createElement('canvas'); c.width=1024; c.height=384;
  const g=c.getContext('2d'), [ink,,cream]=palette;
  g.fillStyle=ink;g.fillRect(0,0,1024,384);
  g.save();g.transform(1,0,-.31,1,0,0);
  for(let i=0;i<4;i++){
    g.fillStyle=i===3?cream:accent;g.fillRect(66+i*56,-2,31-i*3,400);
  }
  g.restore();
  g.fillStyle=accent;g.fillRect(0,0,1024,16);g.fillRect(0,357,1024,9);
  g.fillStyle=cream;g.font='italic 900 275px Arial';g.textAlign='center';g.textBaseline='middle';
  g.fillText(number,547,165,525);
  g.fillStyle=accent;g.font='900 43px Arial';g.fillText(label,542,307,680);
  for(let i=0;i<7;i++){g.fillStyle=i<5?cream:accent;g.fillRect(843+i*15,62,9,19);}
  for(let i=0;i<4;i++){g.fillStyle=accent;g.fillRect(894,122+i*13,121-i*18,5);}
  const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=8;
  const material=new THREE.MeshBasicMaterial({map:tex,toneMapped:false,...printDepth});
  graphics.set(key,material);return material;
}

let mural;
const banners=[];
function paintBanner(g,art,tile,title,accent) {
  const w=g.canvas.width,h=g.canvas.height;
  g.fillStyle='#172e41';g.fillRect(0,0,w,h);
  g.save();g.beginPath();g.moveTo(w*.63,0);g.lineTo(w,0);g.lineTo(w,h);g.lineTo(w*.48,h);g.closePath();g.clip();
  if(art){
    const side=art.width/3, cropH=(side-6)*h/(w*.52);
    g.drawImage(art,tile*side+3,art.height*[.14,.32,.36][tile],side-6,cropH,w*.48,0,w*.52,h);
  }
  g.restore();
  for(let j=0;j<8;j++)for(let i=0;i<21-j*2;i++){
    g.fillStyle=j%2===0?'#377183':'#2c5364';g.beginPath();g.arc(10+i*15+j*5,12+j*14,2.3,0,Math.PI*2);g.fill();
  }
  g.fillStyle=accent;g.fillRect(0,0,w,7);g.fillRect(0,h-12,w,12);
  g.save();g.translate(w*.268,h*.45);g.transform(1,0,-.16,1,0,0);
  g.textAlign='center';g.textBaseline='middle';g.fillStyle='#ffe5b1';g.font='900 115px Arial';g.fillText(title[0],0,-37,w*.44);
  g.font='900 85px Arial';g.fillText(title[1],0,48,w*.46);
  g.fillStyle=accent;for(let i=0;i<3;i++)g.fillRect(-175+i*12,97+i*6,350-i*36,3);
  g.restore();
}
function muralMaterial(){
  if(!mural){
    const map=new THREE.TextureLoader().load(new URL('../textures/blast-league-prints.webp',import.meta.url).href,loaded=>{
      for(const [tile,{ctx,title,accent,tex}] of banners.entries()){
        paintBanner(ctx,loaded.image,tile,title,accent);tex.needsUpdate=true;
      }
    });
    map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=8;
    mural=new THREE.MeshBasicMaterial({map,color:0xe8e1cf,toneMapped:false,...printDepth});
  }
  return mural;
}
function banner(tile,title,accent){
  if(!banners[tile]){
    const c=document.createElement('canvas');c.width=1536;c.height=256;
    const ctx=c.getContext('2d'), image=muralMaterial().map.image;
    paintBanner(ctx,image,tile,title,accent);
    const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=8;
    banners[tile]={ctx,title,accent,tex,material:new THREE.MeshBasicMaterial({map:tex,toneMapped:false,...printDepth})};
  }
  return banners[tile].material;
}

let roof;
export function roofLiner(){
  if(roof)return roof;
  const c=document.createElement('canvas');c.width=256;c.height=128;
  const g=c.getContext('2d');
  for(let x=0;x<256;x+=16){
    const grad=g.createLinearGradient(x,0,x+16,0);
    for(const [stop,col] of [[0,'#172b37'],[.18,'#2a4049'],[.34,'#233a47'],[.74,'#203643'],[.83,'#112432'],[1,'#132a35']])grad.addColorStop(stop,col);
    g.fillStyle=grad;g.fillRect(x,0,16,128);
  }
  g.fillStyle='#10222f';g.fillRect(0,0,256,2);
  const map=new THREE.CanvasTexture(c);map.colorSpace=THREE.SRGBColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(24,17);map.anisotropy=8;
  roof=new THREE.MeshBasicMaterial({map,side:THREE.DoubleSide,toneMapped:false});return roof;
}

export function dressBlastCourt(scene){
  const batch=new EnvironmentBatch(scene);
  const ink=new THREE.MeshStandardMaterial({color:0x153144,roughness:.68});
  const ivory=new THREE.MeshStandardMaterial({color:0xdfd0af,roughness:.68});
  const orange=new THREE.MeshBasicMaterial({color:0xff8653,toneMapped:false});
  const glow=new THREE.MeshBasicMaterial({color:0xffe5ad,toneMapped:false});
  const cold=new THREE.MeshBasicMaterial({color:0x86dddc,toneMapped:false});
  const face=(x,y,z,w,h,yaw,material,tile)=>{
    const g=new THREE.PlaneGeometry(w,h);
    if(tile!=null){
      const uv=g.attributes.uv;
      for(let i=0;i<uv.count;i++)uv.setX(i,(tile+.006+.988*uv.getX(i))/3);
    }
    g.rotateY(yaw);g.translate(x,y,z);batch.add(g,material);
  };
  const labels=[leaguePrint('CENTER COURT','01',palette[1]),leaguePrint('TRAINING DECK','02','#ffa943'),leaguePrint('COOLANT RUN','03',palette[3])];
  function enamel(x,y,z,w,h,yaw,material,tile){
    const n=Math.sin(yaw), k=Math.cos(yaw);
    batch.box(x,y,z,w+.18,h+.18,.10,ink,yaw);
    // Keep printed faces clear of their 10 cm backing at shallow angles.
    face(x+(.05+printGap)*n,y,z+(.05+printGap)*k,w,h,yaw,material,tile);
  }
  function ribbon(x,y,z,w,d,h,r,material){
    const g=roundedDeckGeometry(w,d,h,r);
    g.translate(x,y,z);batch.add(g,material);
  }
  for(const [w,d,y,h,r,m] of [[18.08,18.08,.20,.25,2.12,ink],[18.10,18.10,3.36,.29,2.12,ivory],[18.11,18.11,3.70,.08,2.12,orange],[9.12,9.12,4.24,.31,1.22,ink],[9.10,9.10,8.57,.23,1.22,ivory]]){
    ribbon(2,y,0,w,d,h,r,m);
  }
  for(const side of [-1,1]){
    enamel(2,1.99,side*9.065,11.90,2.46,side>0?0:Math.PI,labels[0]);
    enamel(2+side*4.57,6.68,0,6.09,2.63,side*Math.PI/2,labels[0]);
  }
  ribbon(2,13.80,-7,14.10,14.10,.24,1.52,ink);
  ribbon(2,14.10,-7,14.11,14.11,.11,1.52,glow);
  for(const radius of [2.6,4.9]){
    const ring=new THREE.RingGeometry(radius,radius+.105,64);ring.rotateX(Math.PI/2);ring.translate(2,13.58,-7);batch.add(ring,glow);
  }
  // One team print per wing, flanking the original route signs.
  const pi=Math.PI;
  for(const [x,y,z,w,h,yaw,t] of [
    [-76.91,14,-26,16,13,pi/2,1],[76.91,15,22,18,14,-pi/2,2],
    [-23,15,56.90,15,12,pi,1],[43,15,56.90,9,11,pi,2],
    [-24.18,4.92,-12,10.4,6.6,pi/2,1],[29.17,4.73,12,10.4,5.4,-pi/2,2],
    [-25.82,5.52,-37.5,10.2,6.5,-pi/2,1],[30.82,4.36,13,10.7,5,-pi/2+pi,2],
  ])enamel(x,y,z,w,h,yaw,muralMaterial(),t);
  for(const [x,z,yaw,t] of [[-25.84,-16,-pi/2,1],[29.16,-13,-pi/2,2],[30.84,-13,pi/2,2]])
    enamel(x,4.4,z,11.3,3.24,yaw,labels[t]);
  enamel(-24.15,8.62,9,10.5,1.90,pi/2,labels[1]);
  enamel(0,20.18,-56.90,47.5,6.9,0,banner(0,['BLAST','COMPLEX'],palette[1]));
  enamel(-76.90,20.4,0,35.5,5.55,pi/2,banner(1,['TRAINING','DECK'],'#eda644'));
  enamel(76.90,20.4,-5,35.5,5.55,-pi/2,banner(2,['COOLANT','RUN'],palette[3]));
  for(const [x,z] of [[-60.4,-15],[-45.4,-28],[-60.4,-41]])for(const side of [-1,1]){
    const yaw=side>0?0:pi;
    enamel(x-5,1.28,z+side*1.27,4.5,1.28,yaw,labels[1]);
    for(let j=0;j<5;j++)batch.box(x+4+j*.60,1.68,z+side*1.231,.32,.18,.045,j<4?ivory:orange);
  }
  for(const side of [-1,1])for(const x of [-3.6,7.6]){
    batch.box(x,3.52,side*9.092,1.12,.27,.065,ink);
    for(const dx of [-.29,0,.29])batch.box(x+dx,3.52,side*9.14,.18,.13,.06,orange);
  }
  // Short battens and their housings hang directly beneath the roof trusses.
  for(const x of [-58,-30,26,54])for(let z=-48;z<=48;z+=16) {
    batch.box(x,21.52,z,1.19,.20,5.4,ink);
    for(const dx of [-.31,.31])batch.box(x+dx,21.39,z,.15,.085,4.96,x<0?glow:cold);
  }
  batch.flush('blast-league-dressing');
}

const courtPaint=`
vec2 p=vCourtP.xz;
float dist=length(p-vec2(2.,0.));
vec2 tile=abs(fract(p/vec2(3.,6.)+.5)-.5);
float seam=smoothstep(.003,.014,min(tile.x,tile.y));
float rub=.5+.5*sin(p.y*6.9+sin(p.x*14.2+p.y*2.0)*.42);
float scuff=smoothstep(.70,.99,.5+.5*sin(dot(p,vec2(24.7,3.51))+.58*sin(p.y*3.1)))*smoothstep(.44,.93,sin(dot(p,vec2(.71,1.22)))*cos(p.y*.94));
vec3 field=vec3(.034,.105,.132)+diffuseColor.rgb*.24;
if(p.x>30.)field=vec3(.027,.12,.13)+diffuseColor.rgb*.13;
if(vCourtP.y>1.)field=vec3(.048,.133,.127)+diffuseColor.rgb*.23;
if(vCourtP.y<.12 && p.x<28. && p.x>-25. && abs(p.y)<28.){
  float aa=max(fwidth(dist),.018);
  float arc=min(abs(dist-13.04),abs(dist-20.66));
  float stripe=1.-smoothstep(.053,.053+aa,arc);
  float dash=step(.51,fract((atan(p.y,p.x-2.)+3.1416)*12.73));
  float ticks=(1.-smoothstep(.11,.11+aa,abs(dist-19.94)))*dash;
  float lane=min(abs(abs(p.x-2.)-21.),abs(abs(p.y)-24.5));
  stripe=max(stripe,1.-smoothstep(.062,.062+aa,lane));
  field=mix(field,vec3(.63,.63,.43),stripe*.78);
  field=mix(field,vec3(.88,.31,.075),ticks*.78);
}
diffuseColor.rgb=field*(.84+.16*seam)*(.965+.035*rub)+vec3(.011,.014,.014)*scuff;`;
const wallPaint=`
vec3 p=vCourtP, n=normalize(vCourtN);
float q=abs(n.x)>.6?p.z:p.x;
vec2 f=abs(fract(vec2(q/3.8,p.y/2.55)+.5)-.5);
float joint=smoothstep(.005,.025,min(f.x,f.y));
vec3 team=diffuseColor.rgb;
vec3 paint=mix(vec3(.029,.063,.086),team,.49);
float at=mod(p.y+1.,10.0);
if(at>6.0 && at<6.46)paint=mix(team,vec3(.63,.55,.39),.79);
if(at>6.59 && at<6.74)paint=vec3(.72,.24,.06);
if(p.y>10. && p.y<20.)paint=mix(paint,vec3(.30,.27,.22),.62);
if(p.y<1.1)paint=vec3(.037,.062,.068);
diffuseColor.rgb=paint*(.68+.32*joint);
`;
export function blastFinish(kind,options){
  const {tex,repeat,...props}=options;
  const m=new THREE.MeshStandardMaterial({roughness:.76,metalness:.06,...props});
  m.onBeforeCompile=s=>{
    s.vertexShader='varying vec3 vCourtP,vCourtN;\n'+s.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvCourtP=(modelMatrix*vec4(transformed,1.)).xyz;vCourtN=mat3(modelMatrix)*normal;');
    s.fragmentShader='varying vec3 vCourtP,vCourtN;\n'+s.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\n'+(kind==='floor'?courtPaint:wallPaint));
  };
  m.customProgramCacheKey=()=>'blast-league-'+kind;
  return m;
}
