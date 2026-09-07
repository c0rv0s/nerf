// Blender library adapter. Geometry is created per owner so existing map disposal
// can release it without invalidating a cache shared with another live scene.
import * as THREE from 'three';
import library from '../assets/models/map-art.js';
import { triangleMeshSurfaceY, pointHitsWorld } from './engine.js';

export const mapArtNames = Object.freeze(Object.keys(library));
export function artGeometry(name) {
  const data = library[name];
  if (!data) throw new Error(`Unknown Blender asset: ${name}`);
  const geometry = new THREE.BufferGeometry();
  for (const [attribute, key] of [['position','p'],['normal','n'],['color','c']]) {
    geometry.setAttribute(attribute, new THREE.Float32BufferAttribute(data[key], 3));
  }
  geometry.setIndex(data.i);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
export function artMaterial(options = {}) {
  return new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true,
    roughness: .76, side: THREE.DoubleSide, ...options });
}
export function artMesh(name, options = {}) {
  const mesh = new THREE.Mesh(artGeometry(name), artMaterial(options));
  mesh.name = `blender:${name}`;
  mesh.receiveShadow = true;
  return mesh;
}
export function artInstances(scene, name, placements, options = {}) {
  if (!placements.length) return null;
  const mesh = new THREE.InstancedMesh(artGeometry(name), artMaterial(options), placements.length);
  mesh.name = `blender:${name}`;
  const dummy = new THREE.Object3D();
  placements.forEach(([x,y,z,s=1,yaw=0], i) => {
    dummy.position.set(x,y,z); dummy.rotation.set(0,yaw,0); dummy.scale.setScalar(s);
    dummy.updateMatrix(); mesh.setMatrixAt(i,dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// Local tail flex preserves one draw call per school and keeps the head steady.
// Normals use the inverse transpose of the same shear as the position warp.
export function fishSwimMaterial(time) {
  const material = artMaterial({roughness:.5});
  material.onBeforeCompile = shader => {
    shader.uniforms.artTime = time;
    shader.vertexShader = `uniform float artTime;\nfloat tailShift(float x) {
      float w = max(0., -x - .35);
      return sin(artTime * 7.5 + x * 2.2) * w * w * .24;
    }\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\nfloat slope = (tailShift(position.x + .002) - tailShift(position.x - .002)) / .004;\nobjectNormal.x -= slope * objectNormal.z;');
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\ntransformed.z += tailShift(position.x);');
  };
  material.customProgramCacheKey = () => 'blender-fish-tail-v1';
  return material;
}

// Use the existing collision surface to ground decorative assets. Reject steep
// slopes and occupied volumes instead of floating foliage above underground beds.
export function artGroundY(world, x, z, ceiling = 5) {
  let y = null;
  for (const c of world.colliders) {
    if (!c.min || x<c.min.x || x>c.max.x || z<c.min.z || z>c.max.z) continue;
    const h = c.type === 'triangleMesh' ? triangleMeshSurfaceY(c,x,z) : c.type === 'box' ? c.max.y : null;
    if (h != null && h <= ceiling && (y == null || h>y)) y=h;
  }
  return y;
}
function clearOfPlayFeatures(world,x,z,margin=1.8) {
  if (world.jumpPads.some(p=>Math.hypot(x-p.x,z-p.z)<p.r+margin)) return false;
  for (const p of [...(world.pickups||[]),...(world.spawnsAll||[])]) {
    const position=p.pos||p;
    if (Number.isFinite(position.x)&&Math.hypot(x-position.x,z-position.z)<margin) return false;
  }
  return true;
}
export function addUnderstoryArt(scene, world, biome) {
  const mushroom = biome === 'mycelium';
  const spots = mushroom
    ? [[-37,46],[-39,47],[-25,64],[25,65],[39,44],[40,46],[-62,-26],[63,-31],[-28,-57],[28,-57],[-66,56],[65,56]]
    : [[-45,-66],[-43,-67],[43,64],[45,66],[-59,17],[60,-18],[-30,68],[31,-67]];
  const buckets = new Map();
  const placed=[];
  for (let i=0;i<spots.length;i++) {
    const [x,z]=spots[i];
    if(!clearOfPlayFeatures(world,x,z)) continue;
    const y=artGroundY(world,x,z,7);
    if (y == null || pointHitsWorld(new THREE.Vector3(x,y+.65,z),.45,world,true)) continue;
    const heights = [[-.7,0],[.7,0],[0,-.7],[0,.7]].map(([dx,dz])=>artGroundY(world,x+dx,z+dz,7));
    if (heights.some(h=>h==null || Math.abs(h-y)>.28)) continue;
    const name = mushroom && i%3!==1 ? `mushrooms_${i%3}` : i%2 ? 'broadleaf' : 'fern';
    if (!buckets.has(name)) buckets.set(name,[]);
    buckets.get(name).push([x,y-.015,z,mushroom ? 1.25 : 1.1,i*2.4]);
    placed.push({x,y,z});
    if (mushroom && i%3===0) {
      if (!buckets.has('root_cluster')) buckets.set('root_cluster',[]);
      buckets.get('root_cluster').push([x+.6,y-.09,z+.5,.8,i]);
    }
  }
  for (const [name,placements] of buckets) artInstances(scene,name,placements);
  world.artUnderstory = placed;
  // A few creatures near foliage, grounded at every sampled point of a tiny loop.
  for (let i=0;i<Math.min(3,placed.length);i++) {
    const p=placed[i* Math.floor(placed.length/3)];
    const kind=i%2===0?'snail':'beetle';
    addAmbientCritter(scene,world,kind,p.x+1.3,p.z, (x,z)=>artGroundY(world,x,z,7),i);
  }
}
export function addAmbientCritter(scene,world,kind,x,z,surfaceY,seed=0) {
  if(!clearOfPlayFeatures(world,x,z,1.3)) return null;
  const radius=kind==='snail'?.16:.27;
  const samples=Array.from({length:33},(_,i)=>{
    const a=i/32*Math.PI*2;
    const px=x+Math.cos(a)*radius, pz=z+Math.sin(a)*radius, y=surfaceY(px,pz);
    return y!=null && !pointHitsWorld(new THREE.Vector3(px,y+.45,pz),.28,world,true) ? y : null;
  });
  if (samples.some(y=>y==null || !Number.isFinite(y)) || Math.max(...samples)-Math.min(...samples)>.18) return null;
  const mesh=artMesh(kind,kind==='snail'?{emissive:0x477968,emissiveIntensity:.18}:{});
  mesh.scale.setScalar(kind==='beetle'?1.25:1);
  scene.add(mesh);
  const update=(_dt,t)=>{
    const a=t*(kind==='snail'?.1:.3)+seed*2;
    const phase=((a/(Math.PI*2)%1)+1)%1*32, lo=Math.floor(phase), mix=phase-lo;
    const y=THREE.MathUtils.lerp(samples[lo],samples[lo+1],mix);
    mesh.position.set(x+Math.cos(a)*radius,y,z+Math.sin(a)*radius);
    mesh.rotation.y=-a-Math.PI/2+(kind==='crab'?Math.PI/2:0);
    mesh.rotation.z=kind==='snail'?0:Math.sin(t*8+seed)*.025;
  };
  update(0,0); world.anim.push(update);
  (world.ambientCritters ||= []).push({kind,mesh,center:{x,z},samples});
  return mesh;
}
