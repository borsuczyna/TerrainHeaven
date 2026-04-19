import * as THREE from 'three';
import type App from './editor/App';
import Road from './elements/Road';

export function loadDemoScene(app: App): void {
    const roadA = new Road(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(5, 0, 5)
    );
    roadA.divisions = 3;
    roadA.setCurvePointA(new THREE.Vector3(2.5, 0, 0));
    roadA.setCurvePointB(new THREE.Vector3(2.5, 0, 5));

    const roadB = new Road(
        new THREE.Vector3(5, 0, 5),
        new THREE.Vector3(10, 0, 3)
    );
    roadB.divisions = 3;
    roadB.setCurvePointA(new THREE.Vector3(7.5, 0, 5));
    roadB.setCurvePointB(new THREE.Vector3(7.5, 0, 3));

    roadB.connectWith(0, roadA, 1);

    app.scene.add(roadA);
    app.scene.add(roadB);
}
