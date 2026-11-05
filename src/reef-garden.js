import * as THREE from 'three';

// The skirt turns under the lip; the last narrow band catches the light.
function tableGeometry() {
  const pos=[], colors=[], indices=[];
  const steps=24, rings=[[.01,-.46,.62],[.93,-.06,.8],[1,.045,1.5],[.89,.08,1.04],[.008,.16,.78]];
  for(const [radius,y,shade] of rings) for(let j=0;j<steps;j++){
    const a=j*2*Math.PI/steps, wave=Math.sin(a*7+.7)+.55*Math.sin(a*11);
    const r=radius*(1+.045*wave+.08*Math.sin(a*3));
    pos.push(r*Math.cos(a),y+.045*radius*wave,r*Math.sin(a));
    const stria=shade*(.81+.19*Math.cos(9*a+radius*1.3));
    colors.push(stria,stria*(shade>1.3?1.20:1),stria*(shade>1.3?1.15:1));
  }
  for(let i=0;i<rings.length-1;i++) for(let j=0;j<steps;j++){
    const a=i*steps+j,b=i*steps+(j+1)%steps;
    indices.push(a,a+steps,b,b,a+steps,b+steps);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  g.setIndex(indices);g.computeVertexNormals();return g;
}

export function reefGarden(scene,rnd){
  const shelves=[],twigs=[];
  const palette=[0xed764d,0xdd626e,0xe59852,0xc55783,0xe98967];
  const plate=(x,y,z,r)=>shelves.push([x,y,z,r,r*(.74+rnd()*.27),rnd()*6.28,palette[Math.floor(rnd()*palette.length)]]);
  function fan(x,y,z,size){
    const yaw=rnd()*6.28, color=rnd()<.54?0xf7ad42:0xad659f;
    function stem(start,angle,length,depth){
      const side=Math.sin(angle)*length,end=start.clone().add(new THREE.Vector3(Math.cos(yaw)*side,Math.cos(angle)*length,Math.sin(yaw)*side));
      twigs.push([start,end,length*(depth>=3?.12:.10),color]);
      if(depth) for(const sign of [-1,1])stem(end,angle*.8+sign*(.28+rnd()*.49),length*(.60+rnd()*.16),depth-1);
    }
    stem(new THREE.Vector3(x,y,z),(rnd()-.5)*.4,size*.45,4);
  }
  return {plate,fan,finish(){
    const obj=new THREE.Object3D(),up=new THREE.Vector3(0,1,0);
    const batch=(name,g,items,vertexColors,place)=>{
      const mesh=new THREE.InstancedMesh(g,new THREE.MeshStandardMaterial({vertexColors,roughness:.87}),items.length);
      items.forEach((v,i)=>{obj.rotation.set(0,0,0);const tint=place(v);obj.updateMatrix();mesh.setMatrixAt(i,obj.matrix);mesh.setColorAt(i,new THREE.Color(tint));});
      mesh.name=name;mesh.receiveShadow=true;scene.add(mesh);
    };
    batch('reef-table-colonies',tableGeometry(),shelves,true,([x,y,z,r,d,a,c])=>{obj.position.set(x,y,z);obj.rotation.set(.08*Math.cos(a),a,.09*Math.sin(a));obj.scale.set(r,r*.52,d);return c;});
    batch('reef-gorgonian-fans',new THREE.CylinderGeometry(.66,1,1,4,1,true),twigs,false,([a,b,r,c])=>{const d=b.clone().sub(a);obj.position.copy(a).lerp(b,.5);obj.scale.set(r,d.length(),r);obj.quaternion.setFromUnitVectors(up,d.normalize());return c;});
  }};
}

// Both materials use world coordinates so the light continues around arch joints.
export function reefMaterial(stone,clock){
  const mat=new THREE.MeshStandardMaterial({color:stone?0x81957d:0xffffff,vertexColors:!stone,roughness:.96});
  mat.customProgramCacheKey=()=>stone?'reef-limestone-v1':'reef-sand-v1';
  mat.onBeforeCompile=s=>{
    s.uniforms.reefTime=clock;
    s.vertexShader='varying vec3 vReef;\n'+s.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\nvReef=(modelMatrix*vec4(transformed,1.)).xyz;');
    s.fragmentShader='uniform float reefTime; varying vec3 vReef;\n'+s.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      vec2 p=vReef.xz*1.12+vec2(.22,-.16)*vReef.y;
      vec2 q=p+vec2(.63*sin(.74*p.y+.10*reefTime)+.12*reefTime,.66*sin(.89*p.x-.14*reefTime));
      q+=.24*vec2(sin(q.y*2.2+q.x),sin(q.x*1.7-q.y));
      float light=abs(sin(q.x+sin(q.y))+.85*cos(q.y-.58*q.x));
      float net=1.-smoothstep(.045,.19+fwidth(light),light);
      float grain=sin(vReef.x*3.3+vReef.z*2.1)*sin(vReef.y*3.9-vReef.z*2.7);
      float beds=sin(vReef.y*4.7+.68*vReef.x+1.4*sin(vReef.z*1.12)+.9*sin(vReef.x*1.5)+grain*.7);
      ${stone?'diffuseColor.rgb*=.80+.15*smoothstep(-.65,.21,beds)+.09*grain;':'diffuseColor.rgb*=.93+.055*sin(p.y*4.6+sin(p.x*1.6)+.4*sin(p.y))+.028*grain;'}
      diffuseColor.rgb+=net*vec3(.126,.113,.058);`);
  };
  return mat;
}

export function reefHeadGeometry(w,h,d){
  const g=new THREE.BoxGeometry(w,h,d,3,3,3), pos=g.attributes.position, normal=g.attributes.normal;
  const edge=Math.min(w,h,d)*.21, point=new THREE.Vector3(), core=new THREE.Vector3();
  const bounds=new THREE.Vector3(w*.5-edge,h*.5-edge,d*.5-edge), low=bounds.clone().negate();
  for(let i=0;i<pos.count;i++){
    point.fromBufferAttribute(pos,i);core.copy(point).clamp(low,bounds);point.sub(core).normalize();
    normal.setXYZ(i,point.x,point.y,point.z);
    point.multiplyScalar(edge).add(core);pos.setXYZ(i,point.x,point.y,point.z);
  }
  return g;
}

export function reefCeiling(clock){
  const m=new THREE.MeshBasicMaterial({color:0x629bac,transparent:true,opacity:.76,side:THREE.BackSide,depthWrite:false});
  m.onBeforeCompile=s=>{
    s.uniforms.tide=clock;
    s.vertexShader='varying vec2 surfaceXZ;\n'+s.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\nsurfaceXZ=(modelMatrix*vec4(transformed,1.)).xz;');
    s.fragmentShader='varying vec2 surfaceXZ; uniform float tide;\n'+s.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      vec2 p=surfaceXZ*vec2(.49,.79);
      p+=vec2(.76*sin(.57*p.y+.24*tide),.52*sin(.53*p.x+.16*tide));
      float wave=sin(p.y+.53*sin(p.x))+ .76*sin(.72*p.x+.17*tide);
      float shimmer=1.-smoothstep(.03,.18+fwidth(wave),abs(wave));
      diffuseColor.rgb*=.81+.15*sin(p.y*.42+.4*sin(p.x));
      diffuseColor.rgb+=vec3(.22,.31,.26)*shimmer;`);
  };
  return m;
}
