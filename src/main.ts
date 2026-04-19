import './style.css';
import * as THREE from 'three';
import App from './editor/App';
import Road from './elements/Road';

import WireframeManager from './editor/WireframeManager';

const app = new App();

const roadA = new Road(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(5, 0, 5)
);
roadA.setCurvePointA(new THREE.Vector3(2.5, 0, 0));
roadA.setCurvePointB(new THREE.Vector3(2.5, 0, 5));

const roadB = new Road(
    new THREE.Vector3(5, 0, 5),
    new THREE.Vector3(10, 0, 3)
);

roadB.setCurvePointA(new THREE.Vector3(7.5, 0, 5));
roadB.setCurvePointB(new THREE.Vector3(7.5, 0, 3));

// Connect roadB's nodeA (0) to roadA's nodeB (1) — they share the same node
roadB.connectWith(0, roadA, 1);

app.scene.add(roadA);
app.scene.add(roadB);

const btnWireframe = document.getElementById('btn-wireframe')!;
btnWireframe.addEventListener('click', () => {
    const active = WireframeManager.toggle();
    btnWireframe.classList.toggle('active', active);
});