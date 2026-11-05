import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

const images = new Map();
function artwork(name) {
  if (!images.has(name)) {
    const texture = new THREE.TextureLoader().load(new URL('../textures/'+name+'.webp',import.meta.url).href);
    texture.colorSpace=THREE.SRGBColorSpace;
    texture.anisotropy=8;
    images.set(name,texture);
  }
  return images.get(name);
}

export function atriumEvening(scene) {
  const sky=new THREE.Mesh(new THREE.SphereGeometry(380,64,32),new THREE.MeshBasicMaterial({
    map:artwork('atrium-evening'),side:THREE.BackSide,fog:false,color:0xe8e9ff
  }));
  scene.add(sky);
}

// One repeating terrazzo tile has real mipmaps, so the chips recede into a quiet floor.
function terrazzo() {
  const c=document.createElement('canvas');c.width=c.height=512;
  const g=c.getContext('2d');g.fillStyle='#34485f';g.fillRect(0,0,512,512);
  let state=84931;const rnd=()=>((state=Math.imul(state,1664525)+1013904223>>>0)/4294967296);
  const colors=['#76848b','#62758a','#637284','#273e51','#24374b','#9b9486','#506579'];
  for(let i=0;i<14900;i++){
    const x=rnd()*512,y=rnd()*512,r=.3+rnd()**3*2.5;
    g.fillStyle=colors[i%colors.length];g.beginPath();g.moveTo(x-r,y+.2*r);g.lineTo(x-.42*r,y-r);
    g.lineTo(x+r,y-.34*r);g.lineTo(x+.25*r,y+r*.59);g.closePath();g.fill();
  }
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;
  t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;return t;
}
let floor,wall;
export function atriumFinish(kind){
  const paving=kind==='floor';
  if(paving?floor:wall)return paving?floor:wall;
  const mat=new THREE.MeshStandardMaterial({color:paving?0xece8ed:0x356567,roughness:paving?.36:.43,metalness:paving?.18:.13});
  if(paving)mat.map=terrazzo();
  mat.customProgramCacheKey=()=> 'atrium-'+kind;
  mat.onBeforeCompile=s=>{
    s.vertexShader='varying vec3 atriumP;\n'+s.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\natriumP=(modelMatrix*vec4(transformed,1.)).xyz;');
    s.fragmentShader=`varying vec3 atriumP;
      float atriumHash(vec2 p){vec3 v=fract(p.xyx*.1031);v+=dot(v,v.yzx+33.33);return fract((v.x+v.y)*v.z);}
      float rule(float coord,float halfWidth){float w=max(fwidth(coord),.001);return (1.-smoothstep(halfWidth-w*.5,halfWidth+w*.5,abs(fract(coord+.5)-.5)))*(1.-smoothstep(.18,.5,w));}
      `+s.fragmentShader.replace('#include <map_fragment>',paving?`
        vec2 p=atriumP.xz;
        vec3 face=normalize(cross(dFdx(atriumP),dFdy(atriumP)));
        vec2 slabUV=abs(face.y)>.5?p:vec2(abs(face.x)>.5?p.y:p.x,atriumP.y);
        diffuseColor.rgb*=texture2D(map,slabUV*.30).rgb;
        vec2 diagonal=vec2(p.x+p.y,p.x-p.y)/7.;
        float brass=max(rule(diagonal.x,.004),rule(diagonal.y,.004));
        float border=1.-smoothstep(.022,.07+fwidth(p.x)*.6,abs(abs(p.x)-5.8));
        diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.59,.37,.125),max(brass,border)*.80*abs(face.y));
      `:`
        vec3 face=normalize(cross(dFdx(atriumP),dFdy(atriumP)));
        vec2 t=vec2(abs(face.x)>.5?atriumP.z:atriumP.x,atriumP.y)/vec2(1.65,2.8);
        vec2 id=floor(t);
        float mortar=max(rule(t.x,.012),rule(t.y,.009));
        float edgeGlow=max(rule(t.x-.03,.009),rule(t.y-.02,.009));
        diffuseColor.rgb*=.79+.32*atriumHash(id)+.10*sin(t.y*2.+1.1*sin(t.x));
        diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.017,.038,.048),mortar*.7);
        diffuseColor.rgb+=edgeGlow*vec3(.017,.03,.027);
      `);
  };
  if(paving)floor=mat;else wall=mat;return mat;
}

const V=(x,y,z)=>new THREE.Vector3(x,y,z);
const gold=0xe4ae64,bronze=0x9b754d,jade=0x226468;
export function conservatoryTrim(scene) {
  const groups=new Map(), frame=new THREE.Object3D();
  function add(g,color,group='metal'){
    const c=new THREE.Color(color),values=new Float32Array(g.attributes.position.count*3);
    for(let i=0;i<values.length;i+=3)c.toArray(values,i);
    g.setAttribute('color',new THREE.BufferAttribute(values,3));
    if(!groups.has(group))groups.set(group,[]);
    groups.get(group).push(g);
  }
  function box(x,y,z,w,h,d,color,group){
    add(new THREE.BoxGeometry(w,h,d).translate(x,y,z),color,group);
  }
  function bar(from,to,r,color,group){
    const delta=to.clone().sub(from),g=new THREE.CylinderGeometry(r,r,delta.length(),6);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0,1,0),delta.normalize()));
    const m=from.clone().lerp(to,.5);add(g.translate(m.x,m.y,m.z),color,group);
  }
  function pillar(x,z,side,end=false) {
    const local=(u,y,depth)=>end?V(x+u,y,z-side*depth):V(x-side*depth,y,z+u);
    const block=(u,y,depth,w,h,d,c,group)=>{
      const p=local(u,y,depth);box(p.x,y,p.z,end?w:d,h,end?d:w,c,group);
    };
    block(0,13,.05,1.26,26,.58,jade);
    for(const u of [-.53,-.30,.30,.53])block(u,13,.36,.095,25.2,.13,gold);
    for(const [y,w,h] of [[.46,1.64,.92],[1.15,1.5,.12],[24.9,1.48,.17],[25.55,1.84,.95],[26.24,2.18,.24]])block(0,y,.16,w,h,.72,bronze);
    block(0,12.1,.60,.78,2.32,.76,bronze);
    block(0,12.1,1.02,.53,1.85,.16,0xffde9b,'lamps');
    for(const u of [-.29,0,.29])block(u,12.1,1.12,.039,1.95,.06,gold);
  }
  for(const side of [-1,1]){
    for(const z of [-47,-24,0,24,47])pillar(side*31.58,z,side);
    for(const x of [-18,16])pillar(x,side*47.62,side,true);
    for(const y of [22.25,25.55]) {
      box(side*31.79,y,0,.26,.13,95,gold);
      box(0,y,side*47.74,63,.13,.26,gold);
    }
  }
  for(const z of [-49,-36,-24,-12,0,12,24,36,49]){
    const point=a=>V(31.77*Math.cos(a),27+13.7*Math.sin(a),z);
    for(let i=0;i<32;i++)bar(point(i*Math.PI/32),point((i+1)*Math.PI/32),.105,gold);
    for(let i=3;i<32;i+=4){
      const p=point(i*Math.PI/32);box(p.x,p.y,z,.36,.26,.63,bronze);
    }
  }
  for(const side of [-1,1]){
    for(const y of [.18,.74]){
      box(0,y,side*7.035,15.98,.07,.067,gold);
      box(side*9.035,y,0,.067,.07,9.98,gold);
    }
    for(let u=-7;u<=7;u++){
      const z=side*7.07, x=side*9.07;
      bar(V(u-.47,.23,z),V(u,.64,z),.026,bronze);
      bar(V(u,.64,z),V(u+.47,.23,z),.026,bronze);
      if(Math.abs(u)<5){
        bar(V(x,.23,u-.47),V(x,.64,u),.026,bronze);
        bar(V(x,.64,u),V(x,.23,u+.47),.026,bronze);
      }
    }
  }
  // Fanlights fit inside the existing elliptical vault.
  const fanMat=new THREE.MeshBasicMaterial({map:artwork('atrium-sunburst'),color:0xffeedc,side:THREE.DoubleSide});
  const fan=new THREE.CircleGeometry(1,44,0,Math.PI);
  const uv=fan.attributes.uv;
  for(let i=0;i<uv.count;i++)uv.setY(i,(uv.getY(i)-.5)*2);
  const fans=[];
  function fanlight(x,y,z,rx,ry,yaw=0,lean=0){
    frame.position.set(x,y,z);frame.rotation.order='YXZ';frame.rotation.set(lean,yaw,0,'YXZ');frame.scale.set(rx,ry,1);
    frame.updateMatrix();fans.push(fan.clone().applyMatrix4(frame.matrix));
  }
  for(const side of [-1,1]){
    fanlight(0,27.06,side*48.68,31.6,13.55,side===1?Math.PI:0);
    for(const z of [-42,-30,-18,-6,6,18,30,42])fanlight(side*31.59,26.88,z,5.84,3.6,-side*Math.PI/2,.22);
  }
  fan.dispose();const fanMesh=new THREE.Mesh(mergeGeometries(fans),fanMat);fans.forEach(g=>g.dispose());scene.add(fanMesh);

  function portal(x,z,yaw) {
    const loc=(u,y,depth)=>V(x+Math.cos(yaw)*u+Math.sin(yaw)*depth,y,z-Math.sin(yaw)*u+Math.cos(yaw)*depth);
    for(const [width,top,rad,color] of [[5.45,8.73,.18,bronze],[5.13,8.35,.095,gold]]){
      const outline=[[-width,.14],[-width,top-.91],[-width+.25,top-.39],[-width+.94,top],[width-.94,top],[width-.25,top-.39],[width,top-.91],[width,.14]];
      for(let i=1;i<outline.length;i++)bar(loc(...outline[i-1],.83),loc(...outline[i],.83),rad,color);
    }
    for(let i=-2;i<=2;i++)bar(loc(i*.19,8.36,.89),loc(i*.34,9.42-Math.abs(i)*.23,.89),.095,gold);
  }
  function finish(){
    for(const [group,parts] of groups){
      const mat=group==='lamps'?new THREE.MeshBasicMaterial({vertexColors:true}):new THREE.MeshStandardMaterial({vertexColors:true,metalness:.48,roughness:.35});
      const mesh=new THREE.Mesh(mergeGeometries(parts),mat);mesh.name='atrium-deco-'+group;mesh.receiveShadow=true;scene.add(mesh);
      parts.forEach(g=>g.dispose());
    }
  }
  return {portal,finish,box,bar};
}

export function plantAtriumBeds(scene,trim){
  const pos=[],rgb=[];
  const leaf=(x,y,z,a,len,w,rise,droop,color)=>{
    const c=new THREE.Color(color),dx=Math.cos(a),dz=Math.sin(a);
    function at(t,side) {
      const breadth=w*Math.sin(Math.PI*t)**.72;
      return [x+dx*len*t-dz*breadth*side,y+rise*t-droop*t*t+(1-Math.abs(side))*breadth*.32,z+dz*len*t+dx*breadth*side];
    }
    function tri(a,b,c0,v){pos.push(...a,...b,...c0);for(let i=0;i<3;i++)rgb.push(c.r*v,c.g*v,c.b*v);}
    for(let j=0;j<5;j++)for(const side of [-1,1]){
      const t=j/5,n=(j+1)/5, shade=side<0?.80:1.08;
      tri(at(t,0),at(n,0),at(n,side),shade);tri(at(t,0),at(n,side),at(t,side),shade);
    }
  };
  for(const x of [-8.5,8.5])for(const z of [-28,23]){
    for(const side of [-1,1]){
      trim.box(x+side*2.32,.84,z,.08,.16,6.06,gold);
      trim.box(x,.84,z+side*3.02,4.65,.16,.08,gold);
    }
    for(let j=0;j<9;j++){
      const ox=x+Math.sin(j*2.4)*1.45, oz=z+Math.cos(j*2.4)*2.28;
      for(let k=0;k<7;k++){
        const a=j*1.86+k*2.4;
        leaf(ox,1.07,oz,a,1.30+.36*Math.sin(a*3),.22+.06*Math.cos(a),2.6+.74*Math.cos(a),1.62,[0x276751,0x4c904e,0x498059,0x7a9b50][k%4]);
      }
      if(j%2===0){
        const top=2.84+.31*Math.cos(j);trim.bar(V(ox,1.04,oz),V(ox+.13,top,oz),.04,0x547849);
        for(let k=0;k<3;k++)leaf(ox+.13,top,oz,j+k*1.75,.45,.105,.66+.12*k,.19,k===2?0xe8854a:0xf8b44b);
      }
    }
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('color',new THREE.Float32BufferAttribute(rgb,3));g.computeVertexNormals();
  const mesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({side:THREE.DoubleSide,vertexColors:true,roughness:.76}));mesh.receiveShadow=true;scene.add(mesh);
}

export function fluteFountain(root,brass){
  const flutes=[];
  for(let i=0;i<16;i++){
    const a=i*Math.PI/8;
    const profile=new THREE.Shape();
    profile.moveTo(.86,.94);profile.lineTo(1.03,1);profile.quadraticCurveTo(.73,1.78,.70,2.33);
    profile.lineTo(1.64,2.74);profile.lineTo(1.56,2.78);profile.lineTo(.56,2.38);profile.closePath();
    const fin=new THREE.ExtrudeGeometry(profile,{depth:.07,bevelEnabled:false,curveSegments:5});
    fin.translate(0,0,-.035);fin.rotateY(a);flutes.push(fin);
  }
  const mesh=new THREE.Mesh(mergeGeometries(flutes),brass);flutes.forEach(g=>g.dispose());
  mesh.name='atrium-fountain-fluting';root.add(mesh);
}
