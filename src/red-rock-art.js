import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const textures = new Map();
function rangeTexture(name) {
  if (!textures.has(name)) {
    const tex = new THREE.TextureLoader().load(new URL('../textures/'+name+'.webp',import.meta.url).href);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    textures.set(name,tex);
  }
  return textures.get(name);
}

export function rangeSky(scene) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite:false, fog:false,
    uniforms:{art:{value:rangeTexture('range-horizon')}},
    vertexShader:`varying vec3 dir;
      void main(){dir=position;vec4 p=projectionMatrix*vec4(mat3(viewMatrix)*position,1.);gl_Position=p.xyww;}`,
    fragmentShader:`uniform sampler2D art; varying vec3 dir;
      void main(){vec3 d=normalize(dir);float h=asin(clamp(d.y,-1.,1.));
        float u=fract(atan(d.z,d.x)/3.14159265+.28);
        float v=clamp(.082+h*1.20,0.,1.);
        vec2 du=.96*vec2(-d.z,d.x)/(3.14159265*max(dot(d.xz,d.xz),.0001));
        vec2 dx=vec2(dot(du,dFdx(d.xz)),dFdx(v)),dy=vec2(dot(du,dFdy(d.xz)),dFdy(v));
        vec3 col=mix(textureGrad(art,vec2(u*.96,v),dx,dy).rgb,textureGrad(art,vec2(.96+u*.96,v),dx,dy).rgb,1.-smoothstep(0.,.041,u));
        col=mix(col,vec3(.012,.218,.318),smoothstep(.66,.87,h));
        gl_FragColor=vec4(col,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  const sky=new THREE.Mesh(new THREE.SphereGeometry(2,48,24),material);
  sky.frustumCulled=false;sky.renderOrder=-1000;scene.add(sky);
}

export function rangeSurface(kind,color) {
  const mat=new THREE.MeshStandardMaterial({color,roughness:.98,vertexColors:kind==='cliff'});
  mat.customProgramCacheKey=()=> 'red-rock-'+kind;
  mat.onBeforeCompile=s=>{
    s.vertexShader='varying vec3 land;\n'+s.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\nland=(modelMatrix*vec4(transformed,1.)).xyz;');
    s.fragmentShader=`varying vec3 land;
      float rh(vec2 a){vec3 p=fract(a.xyx*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
      float rn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(rh(i),rh(i+vec2(1,0)),f.x),mix(rh(i+vec2(0,1)),rh(i+1.),f.x),f.y);}
    `+s.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      vec2 p=land.xz;float broad=rn(p*.105)+.46*rn(p*.39);
      float fine=rn(p*4.)-.5;
      ${kind==='planks' ? `float board=floor(p.x*2.15);float u=fract(p.x*2.15);
       float seam=mix(smoothstep(0.,.045,min(u,1.-u)),.95,smoothstep(.05,.41,fwidth(p.x*2.15)));
       diffuseColor.rgb*=(.73+.28*rh(vec2(board,0.))+.20*rn(vec2(p.x*13.,p.y*.88)))*mix(.47,1.,seam);` :kind==='sand' || kind==='ballast' ?
      `float grit=rn(p*${kind==='sand'?'10.':'6.'});
       float detail=1.-smoothstep(.035,.32,length(fwidth(p)));
       diffuseColor.rgb*=.70+.32*broad+.14*fine;
       diffuseColor.rgb+=detail*(smoothstep(.64,.91,grit)*.040-smoothstep(.73,.91,1.-grit)*.033);
       diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(1.12,.78,.66),smoothstep(.69,1.18,broad)*.60);` :
      `vec2 q=vec2(p.x+.7*p.y,land.y);
       float warp=rn(p*.065)*1.6+rn(q*.41)*.43;
       float bedding=fract(land.y*.41+warp+.025*q.x);
       float ledge=smoothstep(.02,.13,bedding)*(1.-smoothstep(.21,.33,bedding));
       diffuseColor.rgb*=.86+.22*rn(q*3.)+.15*rn(q*.63);
       diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(1.32,1.47,1.58),ledge*.62);`}
    `);
  };
  return mat;
}

export function rangeStorefront(scene,{x,z,w,d,label,kind}) {
  const index={saloon:0,hotel:1,store:2}[kind], facadeZ=z-d/2;
  const paint=[0x914832,0x407374,0xac762e][index], trim=0xdbb27a, timber=0x80512e;
  const plane=new THREE.PlaneGeometry(w-.08,6.32), uv=plane.attributes.uv;
  for(let i=0;i<uv.count;i++)uv.setX(i,(index+.005+.99*uv.getX(i))/3);
  const front=new THREE.Mesh(plane,new THREE.MeshStandardMaterial({map:rangeTexture('range-storefronts'),roughness:.95}));
  front.position.set(x,3.2,facadeZ-.05);front.rotation.y=Math.PI;front.receiveShadow=true;scene.add(front);

  const parts=[];
  function board(bx,by,bz,bw,bh,bd,color,tilt=0,slope=0) {
    const g=new THREE.BoxGeometry(bw,bh,bd);
    g.rotateX(slope);g.rotateZ(tilt);g.translate(x+bx,by,facadeZ+bz);
    const c=new THREE.Color(color),t=new Float32Array(g.attributes.position.count*3);
    for(let i=0;i<t.length;i+=3)c.toArray(t,i);
    g.setAttribute('color',new THREE.BufferAttribute(t,3));parts.push(g);
  }
  board(0,6.9,-.57,w+.5,3.25,.6,paint);
  const tiers=index===0?[[.84,1.05],[.53,.8]]:[];
  let top=8.52;
  board(0,top,-.59,w+.65,.16,.71,trim);
  for(const [fraction,h] of tiers){
    board(0,top+h*.5,-.57,w*fraction,h,.6,paint);
    top+=h;board(0,top,-.59,w*fraction+.16,.15,.69,trim);
  }
  if(index===1){
    const arch=new THREE.Shape(),radius=w*.34,rise=1.86;
    arch.moveTo(-radius,0);
    arch.absellipse(0,0,radius,rise,Math.PI,0,true,0);
    arch.closePath();
    const g=new THREE.ExtrudeGeometry(arch,{depth:.39,bevelEnabled:false,curveSegments:14});
    const cap=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:paint,roughness:.95}));
    cap.position.set(x,top,facadeZ-.92);scene.add(cap);
    for(let i=0;i<14;i++){
      const a=i*Math.PI/14,b=(i+1)*Math.PI/14;
      const x0=radius*Math.cos(a),x1=radius*Math.cos(b),y0=rise*Math.sin(a),y1=rise*Math.sin(b);
      board((x0+x1)/2,top+(y0+y1)/2,-.75,Math.hypot(x1-x0,y1-y0)+.05,.14,.43,trim,Math.atan2(y1-y0,x1-x0));
    }
  }
  if(index!==2){
    const ornament=new THREE.Shape(),y=index===0?9.22:8.98;
    for(let i=0;i<10;i++){
      const a=Math.PI/2+i*Math.PI/5, r=i%2?.18:.42;
      ornament[i?'lineTo':'moveTo'](r*Math.cos(a),r*Math.sin(a));
    }
    ornament.closePath();
    const star=new THREE.Mesh(new THREE.ShapeGeometry(ornament),new THREE.MeshStandardMaterial({color:trim,side:THREE.DoubleSide}));
    star.position.set(x,y,facadeZ-.97);scene.add(star);
    for(const side of [-1,1])board(side*1.1,y,-.97,1,.07,.07,trim,side*.045);
  }
  board(0,5.08,-1.62,w+1,.24,3.65,timber,0,-.13);
  board(0,4.79,-3.36,w+1,.31,.24,0x65402c);
  const posts=[-w*.45,0,w*.45];
  for(const bx of posts){
    board(bx,2.78,-3.32,.24,4.12,.25,timber);
    for(const side of [-1,1]) if(Math.abs(bx+side*.7)<w*.5)
      board(bx+side*.43,4.28,-3.32,.14,1.35,.18,trim,-side*.68);
  }
  for(let i=0;i<Math.ceil(w/.68);i++)
    board(-w/2+i*.68,5.22,-1.62,.07,.045,3.6,0xa87748,0,-.13);
  const merged=mergeGeometries(parts);parts.forEach(g=>g.dispose());
  const carpentry=new THREE.Mesh(merged,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.93}));
  carpentry.castShadow=carpentry.receiveShadow=true;scene.add(carpentry);

  const c=document.createElement('canvas');c.width=1024;c.height=192;const g=c.getContext('2d');
  g.fillStyle=['#773629','#335a5e','#8a592b'][index];g.fillRect(0,0,1024,192);
  for(let i=0;i<148;i++){g.fillStyle=i%2?'#f6d6a11e':'#301d1425';g.fillRect(i*127%1024,i*101%192,12+i%35,2);}
  g.strokeStyle='#d2a26b';g.lineWidth=4;g.strokeRect(11,11,1002,170);
  g.textAlign='center';g.textBaseline='middle';g.font='bold 132px Georgia, serif';
  g.fillStyle='#452b23';g.fillText(label,515,103,920);g.fillStyle='#f4daad';g.fillText(label,512,98,920);
  const map=new THREE.CanvasTexture(c);map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=8;
  const sign=new THREE.Mesh(new THREE.PlaneGeometry(w*.94,2.15),new THREE.MeshStandardMaterial({map,roughness:.96}));
  sign.rotation.y=Math.PI;sign.position.set(x,7.24,facadeZ-.89);scene.add(sign);
}

// Cross sections run from the saddle toward the muzzle.
export function rangeHorse(coatTexture) {
  const horse=new THREE.Group();
  const rings=[[-.48,-.99,.32,.22],[-.72,-.81,.28,.22],[-1.01,-.66,.23,.20],[-1.28,-.54,.18,.18],[-1.51,-.51,.145,.15],[-1.64,-.58,.14,.13],[-1.83,-.68,.103,.101]];
  function loft(rows,material){
    const pos=[],uv=[],idx=[],sides=10;
    for(const [i,[z,y,rx,ry]] of rows.entries())for(let j=0;j<=sides;j++){
      const a=Math.PI/2+2*Math.PI*j/sides;
      pos.push(rx*Math.cos(a),y+ry*Math.sin(a),z);uv.push(j/sides,i/(rows.length-1));
    }
    for(let i=0;i<rows.length-1;i++)for(let j=0;j<sides;j++){
      const a=i*(sides+1)+j,b=a+sides+1;idx.push(a,b,a+1,a+1,b,b+1);
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();
    const mesh=new THREE.Mesh(g,material);horse.add(mesh);return mesh;
  }
  const coat=new THREE.MeshStandardMaterial({...coatTexture,color:0xf1c6a0,roughness:.94,flatShading:true});
  const leather=new THREE.MeshStandardMaterial({color:0x663927,roughness:.77});
  loft(rings,coat);
  const maneRows=rings.slice(0,6).map(([z,y,rx,ry],i)=>[z,y+ry*.91,rx*(.28+.055*Math.sin(i*1.6)),.032+.014*Math.cos(i)]);
  loft(maneRows,new THREE.MeshStandardMaterial({color:0x412a24,roughness:1,flatShading:true}));
  for(const [i,j,t] of [[1,2,.28],[4,5,.08]]){
    const a=rings[i],b=rings[j];
    loft([t,t+.13].map(k=>a.map((v,n)=>THREE.MathUtils.lerp(v,b[n],k)+(n>=2?.007:0))),leather);
  }
  for(const sign of [-1,1]){
    const ear=new THREE.Mesh(new THREE.SphereGeometry(1,6,4),coat);
    ear.position.set(sign*.117,-.292,-1.47);ear.scale.set(.052,.153,.051);ear.rotation.z=-sign*.20;horse.add(ear);
    const inside=new THREE.Mesh(new THREE.SphereGeometry(1,5,3),leather);
    inside.scale.set(.027,.086,.013);inside.position.copy(ear.position);inside.position.z+=.039;inside.rotation.z=ear.rotation.z;horse.add(inside);
  }
  return horse;
}

export function rangeScrub(scene,rnd) {
  const specs=[];
  const patch=(x,z,s)=>{
    for(let i=0;i<6;i++){
      const a=rnd()*Math.PI*2, r=rnd()*s;
      specs.push([x+Math.cos(a)*r,z+Math.sin(a)*r,s*(.25+rnd()*.35),a]);
    }
  };
  for(let i=0;i<300;i++){
    const x=rnd()*430-215,z=rnd()*320-160;
    if(Math.abs(z-35)<5 || (x>-76&&x<15&&z>40&&z<77))continue;
    patch(x,z,.55+rnd()*.95);
  }
  for(let i=0;i<72;i++)patch(-85+rnd()*125,(i%2?30:40)+(rnd()-.5)*1.5,.32+rnd()*.57);
  const blades=[];
  for(let i=0;i<11;i++){
    const a=i*2.4,dx=Math.cos(a),dz=Math.sin(a),h=.59+.49*(i%3),w=.14+.06*(i%2);
    blades.push(-dz*w,-.48,dx*w, dx*.27,.28,dz*.27,dx*.76,h,dz*.76,
      dx*.76,h,dz*.76,dx*.27,.28,dz*.27,dz*w,-.48,-dx*w);
  }
  const grass=new THREE.BufferGeometry();grass.setAttribute('position',new THREE.Float32BufferAttribute(blades,3));grass.computeVertexNormals();
  const bush=new THREE.InstancedMesh(grass,new THREE.MeshStandardMaterial({roughness:1,flatShading:true,side:THREE.DoubleSide}),specs.length);
  const stem=new THREE.Object3D(),palette=[0x66734b,0x889052,0x71825c,0x9a8a50,0x697759];
  specs.forEach(([x,z,h,a],i)=>{stem.position.set(x,h*.38,z);stem.scale.set(h*.57,h,h*.52);stem.rotation.set(.3,a,.51);stem.updateMatrix();bush.setMatrixAt(i,stem.matrix);bush.setColorAt(i,new THREE.Color(palette[i%5]));});
  bush.receiveShadow=true;scene.add(bush);
}

export function rangeMesa() {
  const pts=[],n=20;
  const layers=[[0,1],[.15,.85],[.27,.77],[.33,.65],[.48,.59],[.55,.53],[.61,.52],[.86,.47],[.91,.46],[1,.43],[1.015,.015]];
  const vertex=(i,[h,r])=>{
    const a=i*2*Math.PI/n, jag=1+.12*Math.sin(a*3+.2)+.08*Math.sin(a*7);
    return [r*jag*Math.cos(a),h*(1+.027*Math.cos(4*a)),r*jag*Math.sin(a)];
  };
  for(let j=1;j<layers.length;j++)for(let i=0;i<n;i++){
    const a=vertex(i,layers[j-1]),b=vertex(i+1,layers[j-1]),c=vertex(i,layers[j]),d=vertex(i+1,layers[j]);
    pts.push(...a,...c,...b,...b,...c,...d);
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));g.computeVertexNormals();return g;
}

export function rangePillar(w,h,d) {
  const g=new THREE.CylinderGeometry(1,1, h,9,4);
  const p=g.attributes.position;
  for(let i=0;i<p.count;i++){
    const y=p.getY(i),t=y/h+.5, a=Math.atan2(p.getZ(i),p.getX(i));
    const r=(1.03-.22*t+.06*Math.sin(5*t))*(1+.07*Math.sin(a*3+t));
    p.setXYZ(i,p.getX(i)*w*.51*r,y,p.getZ(i)*d*.51*r);
  }
  g.computeVertexNormals();return g;
}

export function rangeArch() {
  const g=new THREE.TorusGeometry(10,2.8,9,34,Math.PI),p=g.attributes.position;
  for(let i=0;i<p.count;i++){
    const x=p.getX(i),y=p.getY(i),z=p.getZ(i),a=Math.atan2(y,x);
    const cx=10*Math.cos(a),cy=10*Math.sin(a),r=1+.14*Math.cos(3*a)+.10*Math.sin(9*a+.4)+.04*Math.sin(z*1.6);
    p.setXYZ(i,cx+(x-cx)*r+.24*Math.sin(4*a),cy+(y-cy)*r+.48*Math.sin(5*a),z*r+.18*Math.sin(6*a));
  }
  g.computeVertexNormals();return g;
}
