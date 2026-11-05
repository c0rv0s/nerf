import * as THREE from 'three';
import {EnvironmentBatch} from './environment-design.js';

const images=new Map();
function art(name){
  if(!images.has(name)){
    const t=new THREE.TextureLoader().load(new URL('../textures/'+name+'.webp',import.meta.url).href);
    t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=8;images.set(name,t);
  }
  return images.get(name);
}

export function rescueSky(scene){
  const tex=art('tidebreaker-squall');
  tex.wrapS=THREE.MirroredRepeatWrapping;
  // The playable ocean supplies the horizon; sample only the sky above it.
  const g=new THREE.SphereGeometry(630,72,48),uv=g.attributes.uv;
  for(let i=0;i<uv.count;i++)uv.setXY(i,uv.getX(i)*2,THREE.MathUtils.clamp(.464+(uv.getY(i)-.5)*1.24,.460,.99));
  const sky=new THREE.Mesh(g,new THREE.MeshBasicMaterial({map:tex,side:THREE.BackSide,fog:false,depthWrite:false,toneMapped:false}));
  sky.rotation.y=1.1;sky.renderOrder=-99;sky.frustumCulled=false;scene.add(sky);return sky;
}

const signCache=new Map();
function marking(name,caption,light=false){
  const key=name+caption+light;if(signCache.has(key))return signCache.get(key);
  const c=document.createElement('canvas');c.width=896;c.height=256;
  const g=c.getContext('2d'),cream='#efdfb8',ink='#163842',verm='#de603b';
  g.fillStyle=light?cream:ink;g.fillRect(0,0,896,256);
  g.fillStyle=light?ink:cream;g.fillRect(12,16,872,4);g.fillRect(12,236,872,4);
  g.save();g.translate(95,119);g.strokeStyle=light?ink:cream;g.lineWidth=6;
  g.beginPath();g.arc(0,0,57,0,2*Math.PI);g.stroke();
  for(let i=0;i<3;i++){g.beginPath();g.moveTo(-45,12+i*11);g.quadraticCurveTo(-26,-2+i*11,-7,11+i*11);g.quadraticCurveTo(12,22+i*11,38,5+i*11);g.stroke();}
  g.fillStyle=verm;g.beginPath();g.moveTo(-15,0);g.lineTo(5,-43);g.lineTo(20,2);g.fill();g.restore();
  g.fillStyle=light?ink:cream;g.textBaseline='middle';g.font='bold 137px Helvetica,Arial,sans-serif';g.fillText(name,184,113,676);
  g.font='bold 31px Helvetica,Arial,sans-serif';g.fillText(caption,192,207,650);
  g.fillStyle=verm;g.fillRect(12,243,872,8);
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=8;
  const m=new THREE.MeshBasicMaterial({map:t,toneMapped:false});signCache.set(key,m);return m;
}

export function rescueFittings(parent){
  const batch=new EnvironmentBatch(parent);
  const gunmetal=new THREE.MeshStandardMaterial({color:0x28454a,roughness:.55,metalness:.32});
  const ivory=new THREE.MeshStandardMaterial({color:0xc8c7ad,roughness:.61,metalness:.18});
  const yellow=new THREE.MeshStandardMaterial({color:0xd59431,roughness:.57,metalness:.19});
  const lamp=new THREE.MeshBasicMaterial({color:0xffce80,toneMapped:false});
  const window=new THREE.MeshBasicMaterial({map:art('tidebreaker-watchroom'),color:0xf5ece1,toneMapped:false});
  const face=(x,y,z,w,h,yaw,m,tile)=>{
    const g=new THREE.PlaneGeometry(w,h);
    if(tile!==undefined){const uv=g.attributes.uv;for(let i=0;i<uv.count;i++)uv.setX(i,(tile+.006+.988*uv.getX(i))/3);}
    g.rotateY(yaw);g.translate(x,y,z);batch.add(g,m);
  };
  const mount=(x,y,z,w,h,yaw,m,tile)=>{
    const nx=Math.sin(yaw),nz=Math.cos(yaw);
    batch.box(x,y,z,w+.17,h+.16,.10,gunmetal,yaw);
    face(x+nx*.065,y,z+nz*.065,w,h,yaw,m,tile);
  };
  const pi=Math.PI;
  for(const side of [-1,1]){
    for(let j=0;j<4;j++)
      mount(52+(j-1.5)*3.64,11.72,side*7.65,3.45,2.40,side>0?0:pi,window,j%3===0?0:1);
    for(let j=0;j<3;j++)
      mount(52+side*9.09,11.72,(j-1)*3.8,3.58,2.40,side*pi/2,window,j%2);
    batch.box(52,13.25,side*7.73,18.25,.19,.36,ivory);
    batch.box(52+side*9.12,13.25,0,.36,.19,15.3,ivory);
    mount(34.50,4.45,side*13.7,12.2,3.52,-pi/2,marking(side<0?'TB–07':'WATCH','NORTH ATLANTIC  /  OPERATIONS',true));
    for(const z of [side*6.4,side*21.4]){
      batch.box(34.37,5.70,z,.34,.49,1.44,gunmetal);
      batch.box(34.18,5.65,z,.06,.23,1.08,lamp);
    }
    mount(10.60,25.78,5+side*2.28,4.07,1.97,side>0?0:pi,window,side>0?0:1);
  }
  mount(42.88,9.60,0,10.4,1.51,-pi/2,marking('TIDEBREAKER','METEOROLOGICAL STATION'));
  mount(34.47,2.48,-22.0,2.37,2.39,-pi/2,window,2);
  mount(-13.3,5.28,-6.34,1.5,.9,0,window,2);
  for(const [x,z,yaw,n] of [[-23,-10.22,0,'01'],[-28,10.78,0,'02'],[-6.22,10,pi/2,'03'],[13.78,-11,pi/2,'04'],[22,12.78,0,'05']])
    mount(x,1.59,z,6.65,1.54,yaw,marking('N / '+n,'TIDE SERVICE   •   FREIGHT'));
  for(const [x,z,top] of [[55,-4,19.6],[57.6,-4,17.0]]){
    batch.beam(new THREE.Vector3(x,14.4,z),new THREE.Vector3(x,top,z),.07,ivory,6);
    batch.box(x,top-1,z,1.72,.07,.07,gunmetal);
    batch.box(x,top-.46,z,1.05,.07,.07,gunmetal);
  }
  // The crane chords meet at the apex. Tie each diagonal to the matching chord.
  for(const z of [3.95,6.05]){
    const crown=x=>x<15?24+7*(x+13)/28:24+7*(37-x)/22;
    for(const [a,b] of [[-13,-6],[-6,1],[1,8],[8,15],[15,20.5],[20.5,26],[26,31.5],[31.5,37]]){
      batch.beam(new THREE.Vector3(a,24,z),new THREE.Vector3(b,crown(b),z),.115,yellow,5);
      if(crown(a)>24.1)batch.beam(new THREE.Vector3(a,crown(a),z),new THREE.Vector3(b,24,z),.115,yellow,5);
    }
  }
  for(const x of [-8,6,24,33]){
    batch.box(x,23.84,5,.90,.23,1.3,gunmetal);
    batch.box(x,23.69,5,.66,.085,1.06,lamp);
  }
  batch.flush('tidebreaker-rescue-fittings');
}

let padSkin;
export function rescueLandingMat(){
  if(padSkin)return padSkin;
  const c=document.createElement('canvas');c.width=c.height=768;const g=c.getContext('2d');
  g.fillStyle='#294448';g.fillRect(0,0,768,768);
  g.strokeStyle='#314d50';g.lineWidth=2;
  for(let k=0;k<768;k+=50){g.beginPath();g.moveTo(k,0);g.lineTo(k,768);g.moveTo(0,k);g.lineTo(768,k);g.stroke();}
  g.translate(384,384);
  for(let i=0;i<72;i++){g.save();g.rotate(i*Math.PI/36);g.fillStyle=i%6?'#8a9885':'#e2cb92';g.fillRect(-1.8,-355,3.6,i%6?9:19);g.restore();}
  g.textAlign='center';g.fillStyle='#e4d9b7';g.font='bold 43px Arial';g.fillText('TB–07',0,208);g.font='bold 16px Arial';g.fillText('N O R T H   A T L A N T I C',0,234);
  let seed=8129;const rnd=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);
  g.fillStyle='rgba(17,37,43,.36)';for(let i=0;i<16000;i++)g.fillRect(rnd()*768-384,rnd()*768-384,rnd()*4+.6,1.0);
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=8;
  padSkin=new THREE.MeshStandardMaterial({map:t,roughness:.55,metalness:.18});return padSkin;
}

export function rescueDeck(material){
  material.roughness=.49;material.metalness=.22;
  material.onBeforeCompile=s=>{
    s.vertexShader='varying vec3 vWetDeck;\n'+s.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvWetDeck=(modelMatrix*vec4(transformed,1.)).xyz;');
    s.fragmentShader='varying vec3 vWetDeck;\n'+s.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      vec2 p=vWetDeck.xz;
      vec3 viewRay=reflect(normalize(vWetDeck-cameraPosition),vec3(0,1,0));
      vec2 r=viewRay.xz/max(.09,viewRay.y);
      float ripple=.5+.5*sin(p.y*9.7+1.6*sin(p.x*.72)+sin(p.y*1.2));
      float pools=smoothstep(.08,.95,.55+.22*sin(p.y*.65+p.x*.27)+.24*cos(p.x*.8-p.y*.22));
      diffuseColor.rgb*=vec3(.18,.28,.34)*(.94-.23*pools);
      vec2 a=(p+r*max(1.,11.7-vWetDeck.y)-vec2(43.,0.))/vec2(3.3,8.);
      vec2 b=(p+r*max(1.,24.-vWetDeck.y)-vec2(6.,5.))/vec2(16.,2.2);
      vec3 sheen=pools*(.26+.74*ripple)*(vec3(.40,.21,.059)/(1.+dot(a,a))+vec3(.28,.19,.064)/(1.+dot(b,b))+vec3(.026,.049,.065));
      if(vWetDeck.y>7.8 && abs(p.y)>30.0 && abs(p.y)<39.1){
        float side=abs(p.y);
        float edge=min(abs(side-31.30),abs(side-37.75));
        float line=1.-smoothstep(.09,.09+max(fwidth(side),.02),edge);
        float worn=.69+.25*sin(4.9*p.x+cos(p.y*12.3));
        diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.67,.39,.085),line*worn);
      }`).replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance+=sheen;');
  };
  material.customProgramCacheKey=()=>'tidebreaker-wet-deck';
  return material;
}

export function rescuePaint(material){
  material.onBeforeCompile=s=>{
    s.vertexShader='varying vec3 vHull;\n'+s.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvHull=(modelMatrix*vec4(transformed,1.)).xyz;');
    s.fragmentShader='varying vec3 vHull;\n'+s.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      vec3 p=vHull;
      float wear=clamp(.44+diffuseColor.r*.80,.42,.98);
      vec3 paint=vec3(.036,.18,.185);
      if(p.x>=33.7){
        paint=p.y>2.2?vec3(.74,.69,.53):vec3(.032,.072,.106);
        if(p.y>2.14 && p.y<2.35 || p.y>6.64 && p.y<6.95)paint=vec3(.69,.17,.057);
        if(p.y>7.01 && p.y<8.12)paint=vec3(.055,.12,.14);
      }else if(p.y>3.4)paint=vec3(.74,.43,.074);
      else if(p.x<0. && abs(p.z)<7.)paint=vec3(.135,.16,.16);
      diffuseColor.rgb=paint*wear+vec3(.12,.051,.028)*(1.-smoothstep(.30,.48,diffuseColor.r));
    `);
  };
  material.customProgramCacheKey=()=>'tidebreaker-painted-hulls';
  return material;
}

export function boatPaint(){
  const m=new THREE.MeshStandardMaterial({roughness:.49,metalness:.18});
  m.onBeforeCompile=s=>{
    s.vertexShader='varying vec3 vBoat;\n'+s.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvBoat=position;');
    s.fragmentShader='varying vec3 vBoat;\n'+s.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      float y=-vBoat.x, station=abs(vBoat.y);
      vec3 paint=vec3(.75,.095,.023);
      if(y<-.77)paint=vec3(.043,.063,.071);
      if(abs(y-.10)<.13 || station>2.63 && station<2.96)paint=vec3(.84,.78,.58);
      if(y>.45 && y<1.13 && station<2.53 && abs(fract((vBoat.y+.33)/1.25)-.5)<.38)paint=vec3(.038,.097,.122);
      diffuseColor.rgb=paint;`);
  };
  m.customProgramCacheKey=()=>'rescue-capsule';
  return m;
}
