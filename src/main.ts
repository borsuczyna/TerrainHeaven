import './style.css';
import * as THREE from 'three';
import { createIcons, icons } from 'lucide';
import App from './editor/App';
import Road from './elements/Road';
import WireframeManager from './editor/WireframeManager';
import ToolManager from './editor/ToolManager';
import RoadTool from './editor/RoadTool';
import type { Tool } from './editor/ToolManager';

const app = new App();

// --- Tool setup ---
const toolManager = new ToolManager();
app.selection.toolManager = toolManager;
app.camera.toolManager = toolManager;

const selectTool: Tool = {
    name: 'select',
    activate() {},
    deactivate() {},
};

const roadTool = new RoadTool(app.scene, app.camera.instance);

toolManager.register(selectTool, document.getElementById('btn-select') as HTMLButtonElement);
toolManager.register(roadTool, document.getElementById('btn-road') as HTMLButtonElement);
toolManager.setActive('select');

// --- Demo roads ---
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

roadB.connectWith(0, roadA, 1);

app.scene.add(roadA);
app.scene.add(roadB);

// --- Wireframe toggle ---
const btnWireframe = document.getElementById('btn-wireframe')!;
btnWireframe.addEventListener('click', () => {
    const active = WireframeManager.toggle();
    btnWireframe.classList.toggle('active', active);
});

// --- Init Lucide icons ---
createIcons({ icons });