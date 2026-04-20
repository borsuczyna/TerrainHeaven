import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type WorldNode from '../elements/WorldNode';
import type WorldElement from '../elements/WorldElement';
import Camera from './Camera';
import Renderer from './Renderer';
import SceneManager from './SceneManager';

@singleton()
export default class GizmoManager {
    private controls: TransformControls;
    private activeNodes: WorldNode[] = [];
    private activeElement: WorldElement | null = null;
    private helper: THREE.Object3D = new THREE.Object3D();
    private helperLastPosition: THREE.Vector3 = new THREE.Vector3();

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
        this.activeElement = null;

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
        this.helperLastPosition.copy(center);
        this.controls.attach(this.helper);
    }

    public attachElement(element: WorldElement | null): void {
        this.activeNodes = [];
        this.activeElement = element;

        if (!element) {
            this.controls.detach();
            return;
        }

        const nodes = element.getChildWorldNodes();
        let center = new THREE.Vector3();
        if (nodes.length > 0) {
            for (const node of nodes) {
                const worldPos = new THREE.Vector3();
                node.mesh.getWorldPosition(worldPos);
                center.add(worldPos);
            }
            center.divideScalar(nodes.length);
        } else {
            const area = element.getOccupiedArea();
            if (area.length > 0) {
                let count = 0;
                for (const tri of area) {
                    center.x += tri.a.x + tri.b.x + tri.c.x;
                    center.z += tri.a.y + tri.b.y + tri.c.y;
                    count += 3;
                }
                if (count > 0) {
                    center.x /= count;
                    center.z /= count;
                }
                const meshWorld = new THREE.Vector3();
                element.mesh.getWorldPosition(meshWorld);
                center.y = meshWorld.y;
            } else {
                element.mesh.getWorldPosition(center);
            }
        }

        this.helper.position.copy(center);
        this.helperLastPosition.copy(center);
        this.controls.attach(this.helper);
    }

    public detach(): void {
        this.activeNodes = [];
        this.activeElement = null;
        this.controls.detach();
    }

    private onGizmoChange = (): void => {
        if (this.activeNodes.length === 0 && !this.activeElement) return;

        const delta = this.helper.position.clone().sub(this.helperLastPosition);
        if (delta.lengthSq() < 1e-12) return;

        if (this.activeNodes.length > 0) {
            const moved = new Set<WorldNode>();
            const touched = new Set<WorldElement>();
            for (const node of this.activeNodes) {
                if (moved.has(node)) continue;
                moved.add(node);

                const worldPos = new THREE.Vector3();
                node.mesh.getWorldPosition(worldPos);
                worldPos.add(delta);

                if (node.mesh.parent) {
                    node.mesh.position.copy(node.mesh.parent.worldToLocal(worldPos));
                } else {
                    node.mesh.position.copy(worldPos);
                }

                if (node.parent) touched.add(node.parent);
            }
            for (const element of touched) {
                element.update();
            }
            this.helperLastPosition.copy(this.helper.position);
            return;
        }

        if (!this.activeElement) return;
        this.activeElement.translate(delta);
        this.helperLastPosition.copy(this.helper.position);
    };

    public get isDragging(): boolean {
        return this.controls.dragging;
    }

    public dispose(): void {
        this.controls.removeEventListener('change', this.onGizmoChange);
        this.controls.dispose();
    }
}
