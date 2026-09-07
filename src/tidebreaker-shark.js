import * as THREE from 'three';
import { artMesh } from './map-art.js';

export const buildTidebreakerShark = () => {
  const group = new THREE.Group();
  group.add(artMesh('shark_body'));
  const pivot = (name,asset,position) => {
    const part = new THREE.Group(); part.name=name;
    part.position.set(...position); part.add(artMesh(asset)); group.add(part);
    return part;
  };
  const tail=pivot('shark-tail-pivot','shark_tail',[-2.62,0,0]);
  const leftPec=pivot('shark-left-pectoral-pivot','shark_left_pec',[1.05,-.22,.62]);
  const rightPec=pivot('shark-right-pectoral-pivot','shark_right_pec',[1.05,-.22,-.62]);
  group.userData.animParts={tail,leftPec,rightPec};
  group.scale.setScalar(.92);
  return group;
};
