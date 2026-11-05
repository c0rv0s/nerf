import * as THREE from 'three';

// The sky stays dark even as the canopy floor picks up more reflected light.
export function addGroveStars(scene) {
  let seed = 7261;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const c = document.createElement('canvas');
  c.width = 2048; c.height = 1024;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, c.height);
  for (const [t, color] of [[0,'#101536'],[.29,'#11295a'],[.49,'#37477d'],[.65,'#48597c'],[1,'#23243f']]) sky.addColorStop(t, color);
  g.fillStyle = sky; g.fillRect(0, 0, c.width, c.height);
  for (let i=0; i<1250; i++) {
    const x=next()*c.width, y=next()*c.height*.49, radius=.38+next()**3*1.05;
    g.fillStyle='rgba(218,233,255,'+(.24+next()*.65)+')';
    g.beginPath(); g.arc(x,y,radius,0,Math.PI*2); g.fill();
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace=THREE.SRGBColorSpace;
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(440,48,24), new THREE.MeshBasicMaterial({map:texture,side:THREE.BackSide,fog:false,toneMapped:false,depthWrite:false}));
  skyMesh.renderOrder=-1000;
  skyMesh.name='mycelium-starlight';
  scene.add(skyMesh);
}

export function lightMushroomGills(material) {
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec3 vGroveCap;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvGroveCap = position;');
    shader.fragmentShader = 'varying vec3 vGroveCap;\n'+shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float angle = atan(vGroveCap.z, vGroveCap.x);
      float ribs = .5 + .5 * cos(angle * 39. + .8 * sin(angle * 7.) + length(vGroveCap.xz) * .47);
      float under = smoothstep(.23, .95, -vGroveCap.y);
      totalEmissiveRadiance = mix(totalEmissiveRadiance, mix(vec3(.19,.074,.034),vec3(.78,.37,.085),ribs*ribs), under);
      diffuseColor.rgb *= 1.0 - under * .76;
    `);
  };
  material.customProgramCacheKey=()=>'grove-gills-v1';
}

export function paintGroveStone(material) {
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec3 vStone; varying float vUp;\n'+shader.vertexShader
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\nvUp = normalize(transformDirectionByInverseViewMatrix(transformedNormal, viewMatrix)).y;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvStone = position;');
    shader.fragmentShader = 'varying vec3 vStone; varying float vUp;\n'+shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float grain = clamp(dot(diffuseColor.rgb, vec3(.25,.55,.2)) * 4., 0., 1.);
      float mossCover = smoothstep(.4,.78,vUp + .16*sin(vStone.x*9.+vStone.z*4.) + grain*.28);
      diffuseColor.rgb = mix(mix(vec3(.058,.066,.13),vec3(.23,.26,.35),grain),
        mix(vec3(.09,.19,.095),vec3(.34,.42,.14),grain),mossCover);
    `);
  };
  material.customProgramCacheKey=()=>'grove-moss-v1';
}

export function drawGroveVine(g) {
  for (let i=0;i<2;i++){
    const base=45+i*32;
    g.strokeStyle='#99895e';g.lineWidth=5;g.beginPath();
    for(let y=0;y<=128;y+=2){const x=base+Math.sin(y*Math.PI/64+i)*8;y?g.lineTo(x,y):g.moveTo(x,y);}
    g.stroke();
    for(let j=0;j<8;j++){
      const y=j*16+5, x=base+Math.sin(y*Math.PI/64+i)*8, sign=(i+j)%2?1:-1;
      g.fillStyle=['#9cbb64','#61a473','#afbd79'][(j+i)%3];
      g.beginPath();g.moveTo(x,y);g.quadraticCurveTo(x+18*sign,y-5,x+29*sign,y+6);
      g.quadraticCurveTo(x+16*sign,y+18,x,y);g.fill();
    }
  }
}

export function addGroveFlora(scene, decks, shore, shoreHeight) {
  let seed=9701;
  const rnd=()=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296;
  const material=new THREE.MeshStandardMaterial({vertexColors:true,side:THREE.DoubleSide,roughness:.92,emissive:0x28233d,emissiveIntensity:.28});
  function build(flower) {
    const positions=[], colors=[];
    const tri=(a,b,c,hex)=>{
      positions.push(...a,...b,...c);
      const color=new THREE.Color(hex);
      for(let i=0;i<3;i++) colors.push(color.r,color.g,color.b);
    };
    const leaf=(x,y,z,theta,length,width,rise,hex)=>{
      const dx=Math.cos(theta),dz=Math.sin(theta);
      const mid=[x+dx*length*.48,y+rise*.6+.04,z+dz*length*.48];
      const left=[mid[0]-dz*width,mid[1]-.05,mid[2]+dx*width];
      const right=[mid[0]+dz*width,mid[1]-.05,mid[2]-dx*width];
      const tip=[x+dx*length,y+rise,z+dz*length], root=[x,y,z];
      tri(root,left,mid,hex);tri(mid,left,tip,hex);tri(root,mid,right,hex);tri(mid,tip,right,hex);
    };
    const greens=[0x5d9955,0x9bbb68,0x4d9266];
    if(flower) {
      for(let i=0;i<9;i++) leaf(0,0,0,i*2.4,.32+rnd()*.28,.09,.15+rnd()*.13,greens[i%3]);
      for(let j=0;j<3;j++){
        const x=(j-1)*.22,z=Math.sin(j*2.4)*.15,h=.27+j*.075;
        tri([x-.019,0,z],[x+.019,0,z],[x,h,z],0x75924d);
        for(let i=0;i<5;i++) leaf(x,h,z,i*Math.PI*.4+j,.125,.055,.06,[0xffdfac,0xbba4ff,0xe4b8e6][j]);
        tri([x-.035,h+.024,z-.018],[x+.035,h+.024,z-.018],[x,h+.035,z+.036],0xffc064);
      }
    } else {
      for(let j=0;j<10;j++) {
        const y=-j*.16,x=Math.sin(j*.63)*.10;
        tri([x-.02,y,.01],[x+.02,y,.01],[Math.sin((j+1)*.63)*.10,y-.18,.01],0x647a45);
        leaf(x,y,0,j%2 ? .5 : 2.6,.19+.1*Math.sin(Math.PI*j/10),.09,-.18,greens[j%3]);
      }
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
    geo.computeVertexNormals();return geo;
  }
  const flowers=[], vines=[], o=new THREE.Object3D();
  const place=(items,x,y,z,scale,yaw)=>{
    o.position.set(x,y,z);o.rotation.y=yaw;o.scale.setScalar(scale);o.updateMatrix();items.push(o.matrix.clone());
  };
  for(const d of decks) {
    for(let i=0;i<Math.ceil(d.topRadius*2.7);i++){
      const a=i*2.4+rnd()*.2, r=d.topRadius*(.91+rnd()*.06);
      place(flowers,d.x+Math.cos(a)*r,d.y+.01,d.z+Math.sin(a)*r,.7+rnd()*.7,-a);
      if(i%3===0) place(vines,d.x+Math.cos(a)*d.topRadius*.999,d.y-.02,d.z+Math.sin(a)*d.topRadius*.999,.65+rnd()*.68,-a);
    }
  }
  for(let i=0;i<shore.length;i++) {
    const a=shore[i],b=shore[(i+1)%shore.length];
    for(let j=0;j<10;j++){
      const t=(j+rnd())/10, x=a[0]+(b[0]-a[0])*t,z=a[1]+(b[1]-a[1])*t;
      const dx=x-2,dz=z+35.4, dist=Math.hypot(dx,dz),step=1.1+rnd()*1.7;
      const px=x+dx/dist*step,pz=z+dz/dist*step;
      if(pz < -46 && Math.abs(px)<8) continue;
      place(flowers,px,shoreHeight(px,pz),pz,.85+rnd()*.85,rnd()*6.28);
    }
  }
  for(const [name,geo,matrices] of [['wildflowers',build(true),flowers],['trailing-leaves',build(false),vines]]) {
    const mesh=new THREE.InstancedMesh(geo,material,matrices.length);
    matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.name='mycelium-'+name;
    mesh.receiveShadow=true;mesh.raycast=()=>{};scene.add(mesh);
  }
}

export function addPondRipples(scene, world, contains) {
  const positions=[], dirs=[], colors=[];
  const water=world.waterZones.at(-1);
  const emit=(x,z,dx,dz,bright)=>{
    positions.push(x,water.surfaceY+.034,z);dirs.push(dx,dz);
    colors.push(.45*bright,.88*bright,.8*bright);
  };
  const ring=(cx,cz,rx,rz,phase)=>{
    for(let i=0;i<60;i++) {
      const a=i*Math.PI/30,b=(i+1)*Math.PI/30;
      const weight=.5+.5*Math.sin(a*3.0+phase+Math.sin(a*5.0));
      if(weight<.3) continue;
      const vertex=(angle,out)=>{
        const dx=Math.cos(angle),dz=Math.sin(angle);
        const r=.018*Math.sin(angle*7+phase)+out;
        return [cx+dx*(rx+r),cz+dz*(rz+r),dx,dz,weight];
      };
      const v=[vertex(a,0),vertex(a,.024+weight*.044),vertex(b,0),vertex(b,.024+weight*.044)];
      if(v.some(p=>!contains(p[0],p[1]))) continue;
      for(const k of [0,1,2,2,1,3])emit(...v[k]);
    }
  };
  for(const m of world.fungalPlatforms) {
    if(!contains(m.x,m.z))continue;
    const r=m.radius*.3+.2;
    ring(m.x,m.z,r,r,1);ring(m.x,m.z,r+.38,r+.38,3);
  }
  for(const c of world.colliders) {
    if(c.debugName!=='mycelium-boulder'||Math.abs(c.center.y-water.surfaceY)>c.radii.y*.8)continue;
    if(!contains(c.center.x,c.center.z))continue;
    ring(c.center.x,c.center.z,c.radii.x+.16,c.radii.z+.16,c.center.x);
  }
  if(!positions.length)return;
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('uv',new THREE.Float32BufferAttribute(dirs,2));
  geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  const material=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide,transparent:true,opacity:.58,depthWrite:false});
  const time={value:0};
  material.onBeforeCompile=shader=>{
    shader.uniforms.uPondT=time;
    shader.vertexShader='uniform float uPondT;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed.xz+=uv*.055*sin(uPondT*1.4+position.x*.21);');
  };
  world.anim.push((dt,t)=>{time.value=t;});
  const mesh=new THREE.Mesh(geo,material);mesh.name='mycelium-pond-ripples';mesh.renderOrder=1;mesh.raycast=()=>{};scene.add(mesh);
}
