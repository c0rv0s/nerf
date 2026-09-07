import * as THREE from 'three';
import { artMesh } from './map-art.js';

// Identical asset and pivot contract on Tidebreaker and Sunken Reef.
export const buildBlueWhale = () => {
  const group = new THREE.Group();
  const body = artMesh('whale_body');
  const pivot = (name, asset, position) => {
    const part = new THREE.Group(); part.name = name;
    part.position.set(...position); part.add(artMesh(asset)); group.add(part);
    return part;
  };
  group.add(body);
  const fluke = pivot('whale-fluke-pivot','whale_fluke',[-12.35,0,0]);
  const leftPec = pivot('whale-left-pectoral-pivot','whale_left_pec',[3.6,-.35,2.55]);
  const rightPec = pivot('whale-right-pectoral-pivot','whale_right_pec',[3.6,-.35,-2.55]);
  group.scale.setScalar(2.35);
  return {group,body,fluke,leftPec,rightPec};
};
