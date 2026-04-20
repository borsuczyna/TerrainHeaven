import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type WorldNode from '../elements/WorldNode';
import Camera from './Camera';
import Renderer from './Renderer';
import SceneManager from './SceneManager';

@singleton()
export default class GizmoManager {
    private controls: TransformControls;
    private activeNodes: WorldNode[] = [];
    private helper: THREE.Object3D = new THREE.Object3D();

    constructor(
        @inject(Camera) camera: Camera,
        @inject(Renderer) renderer: Renderer,
        @inject(SceneManager) scene: SceneManager,
    ) {
        this.controls = new TransformControls(camera.instance, renderer.domElement);
        this.controls.setMode('translate');
        this.controls.setSize(0.8);
        scene.instance.add(this.helper);
        scene.instance.add(this.controls.getHelper());

        this.controls.addEventListener('change', this.onGizmoChange);
    }

    public attach(nodes: WorldNode[]): void {
        this.activeNodes = nodes;

        if (nodes.length === 0) {
            this.controls.detach();
            return;
        }

        // Position helper at center of all selected nodes
        const center = new THREE.Vector3();
        for (const node of nodes) {
            const worldPos = new THREE.Vector3();
            node.mesh.getWorldPosition(worldPos);
            center.add(worldPos);
        }
        center.divideScalar(nodes.length);

        this.helper.position.copy(center);
        this.controls.attach(this.helper);
    }

    public detach(): void {
        this.activeNodes = [];
        this.controls.detach();
    }

    private onGizmoChange = (): void => {
        if (this.activeNodes.length === 0) return;

        const newCenter = this.helper.position.clone();

        // Compute old center
        const oldCenter = new THREE.Vector3();
        for (const node of this.activeNodes) {
            const worldPos = new THREE.Vector3();
            node.mesh.getWorldPosition(worldPos);
            oldCenter.add(worldPos);
        }
        oldCenter.divideScalar(this.activeNodes.length);

        const delta = newCenter.clone().sub(oldCenter);

        for (const node of this.activeNodes) {
            node.mesh.position.add(delta);
            node.parent?.update();
        }
    };

    public get isDragging(): boolean {
        return this.controls.dragging;
    }

    public dispose(): void {
        this.controls.removeEventListener('change', this.onGizmoChange);
        this.controls.dispose();
    }
}
