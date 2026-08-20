import * as THREE from 'three';
import { singleton, inject, delay } from 'tsyringe';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type WorldNode from '../elements/WorldNode';
import type WorldElement from '../elements/WorldElement';
import Camera from './Camera';
import Renderer from './Renderer';
import SceneManager from './SceneManager';
import HistoryManager from './HistoryManager';

export interface GizmoModeState {
    desired: 'translate' | 'rotate';
    effective: 'translate' | 'rotate';
    canRotate: boolean;
}

@singleton()
export default class GizmoManager {
    private controls: TransformControls;
    private activeNodes: WorldNode[] = [];
    private activeElements: WorldElement[] = [];
    private helper: THREE.Object3D = new THREE.Object3D();
    private helperLastPosition: THREE.Vector3 = new THREE.Vector3();
    private helperLastQuaternion: THREE.Quaternion = new THREE.Quaternion();
    private desiredMode: 'translate' | 'rotate' = 'translate';
    private effectiveMode: 'translate' | 'rotate' = 'translate';
    private isApplyingInternalRotation = false;
    private readonly rotationSpeed = 0.3;
    private readonly sceneManager: SceneManager;
    public onModeStateChanged: ((state: GizmoModeState) => void) | null = null;

    constructor(
        @inject(delay(() => Camera)) camera: Camera,
        @inject(Renderer) renderer: Renderer,
        @inject(SceneManager) scene: SceneManager,
        @inject(HistoryManager) private readonly history: HistoryManager,
    ) {
        this.sceneManager = scene;
        this.controls = new TransformControls(camera.instance, renderer.domElement);
        camera.onChanged(() => {
            this.controls.camera = camera.instance;
        });
        this.controls.setMode('translate');
        this.controls.setSize(0.8);
        scene.instance.add(this.helper);
        scene.instance.add(this.controls.getHelper());

        this.controls.addEventListener('change', this.onGizmoChange);
        this.controls.addEventListener('mouseDown', this.onGizmoMouseDown);
        this.controls.addEventListener('mouseUp', this.onGizmoMouseUp);
    }

    public attach(nodes: WorldNode[]): void {
        this.activeNodes = nodes;
        this.activeElements = [];

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
        this.resetHelperRotation();
        this.syncHelperState();
        this.updateControlMode();
        this.controls.attach(this.helper);
    }

    public attachElement(element: WorldElement | null): void {
        this.attachElements(element ? [element] : []);
    }

    public attachElements(elements: WorldElement[]): void {
        this.activeNodes = [];
        this.activeElements = elements;

        if (elements.length === 0) {
            this.controls.detach();
            return;
        }

        const center = new THREE.Vector3();
        for (const element of elements) {
            center.add(this.getElementCenterWorld(element));
        }
        center.divideScalar(elements.length);

        this.helper.position.copy(center);
        this.resetHelperRotation();
        this.syncHelperState();
        this.updateControlMode();
        this.controls.attach(this.helper);
    }

    public detach(): void {
        this.activeNodes = [];
        this.activeElements = [];
        this.updateControlMode();
        this.controls.detach();
    }

    public handleShortcut(key: string): boolean {
        const normalized = key.toUpperCase();
        if (normalized === 'W') {
            this.setMode('translate');
            return true;
        }

        if (normalized === 'E') {
            this.setMode('rotate');
            return true;
        }

        return false;
    }

    public setMode(mode: 'translate' | 'rotate'): void {
        if (mode === 'rotate' && !this.canRotateSelection()) return;
        this.desiredMode = mode;
        this.updateControlMode();
        this.resetHelperRotation();
        this.syncHelperState();
    }

    public getModeState(): GizmoModeState {
        return {
            desired: this.desiredMode,
            effective: this.effectiveMode,
            canRotate: this.canRotateSelection(),
        };
    }

    private onGizmoChange = (): void => {
        if (this.isApplyingInternalRotation) return;
        if (this.activeNodes.length === 0 && this.activeElements.length === 0) return;

        if (this.effectiveMode === 'rotate') {
            this.rotateActiveElements();
            return;
        }

        const delta = this.helper.position.clone().sub(this.helperLastPosition);
        if (delta.lengthSq() < 1e-12) return;

        if (this.activeNodes.length > 0) {
            const moved = new Set<WorldNode>();
            const touched = new Set<WorldElement>();
            let movedGlobalNode = false;
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

                for (const element of node.parent?.getAffectedElementsForNode(node) ?? []) {
                    touched.add(element);
                }
                if (!node.parent) {
                    movedGlobalNode = true;
                }
            }
            for (const element of touched) {
                element.update();
            }
            if (movedGlobalNode) {
                this.sceneManager.markTerrainDirty();
            }
            this.helperLastPosition.copy(this.helper.position);
            return;
        }

        this.translateActiveElements(delta);
        this.helperLastPosition.copy(this.helper.position);
    };

    private onGizmoMouseDown = (): void => {
        if (this.activeNodes.length === 0 && this.activeElements.length === 0) return;
        this.history.beginAction(this.effectiveMode === 'rotate' ? 'Rotate Selection' : 'Move Selection');
    };

    private onGizmoMouseUp = (): void => {
        this.history.endAction(this.effectiveMode === 'rotate' ? 'Rotate Selection' : 'Move Selection');
    };

    private translateActiveElements(delta: THREE.Vector3): void {
        if (this.activeElements.length === 0) return;

        const movedNodes = new Set<WorldNode>();
        const touched = new Set<WorldElement>();
        for (const element of this.activeElements) {
            const childNodes = element.getTransformWorldNodes();
            if (childNodes.length === 0) {
                element.translate(delta);
                continue;
            }

            for (const node of childNodes) {
                if (movedNodes.has(node)) continue;
                movedNodes.add(node);

                const worldPos = new THREE.Vector3();
                node.mesh.getWorldPosition(worldPos);
                worldPos.add(delta);

                if (node.mesh.parent) {
                    node.mesh.position.copy(node.mesh.parent.worldToLocal(worldPos));
                } else {
                    node.mesh.position.copy(worldPos);
                }

                for (const affectedElement of element.getAffectedElementsForNode(node)) {
                    touched.add(affectedElement);
                }
            }
        }

        for (const element of touched) {
            element.update();
        }
    }

    private rotateActiveElements(): void {
        if (this.activeElements.length === 0) return;

        const rawDelta = this.helper.quaternion.clone().multiply(this.helperLastQuaternion.clone().invert()).normalize();
        const quaternionDot = Math.abs(rawDelta.dot(new THREE.Quaternion()));
        if (1 - quaternionDot < 1e-8) return;

        const clampedW = THREE.MathUtils.clamp(rawDelta.w, -1, 1);
        const halfAngle = Math.acos(clampedW);
        const axisLength = Math.sqrt(Math.max(1 - clampedW * clampedW, 0));
        const axis = axisLength > 1e-6
            ? new THREE.Vector3(rawDelta.x / axisLength, rawDelta.y / axisLength, rawDelta.z / axisLength)
            : new THREE.Vector3(0, 1, 0);
        const scaledAngle = halfAngle * 2 * this.rotationSpeed;
        if (Math.abs(scaledAngle) < 1e-8) return;

        const deltaRotation = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), scaledAngle);
        const appliedQuaternion = this.helperLastQuaternion.clone().multiply(deltaRotation);
        const pivot = this.helper.position.clone();
        const movedNodes = new Set<WorldNode>();
        const touched = new Set<WorldElement>();

        this.isApplyingInternalRotation = true;
        this.helper.quaternion.copy(appliedQuaternion);
        this.helper.updateMatrixWorld(true);
        this.isApplyingInternalRotation = false;

        for (const element of this.activeElements) {
            if (!element.canRotate()) continue;

            for (const node of element.getTransformWorldNodes()) {
                if (movedNodes.has(node)) continue;
                movedNodes.add(node);

                const worldPos = new THREE.Vector3();
                node.mesh.getWorldPosition(worldPos);
                worldPos.sub(pivot).applyQuaternion(deltaRotation).add(pivot);

                if (node.mesh.parent) {
                    node.mesh.position.copy(node.mesh.parent.worldToLocal(worldPos));
                } else {
                    node.mesh.position.copy(worldPos);
                }

                for (const affectedElement of element.getAffectedElementsForNode(node)) {
                    touched.add(affectedElement);
                }
            }
        }

        for (const element of touched) {
            element.update();
        }

        this.helperLastQuaternion.copy(appliedQuaternion);
    }

    private updateControlMode(): void {
        const canRotateSelection = this.canRotateSelection();

        this.effectiveMode = this.desiredMode === 'rotate' && canRotateSelection ? 'rotate' : 'translate';
        this.controls.setMode(this.effectiveMode);
        this.controls.setSpace('world');
        this.controls.showX = this.effectiveMode === 'translate';
        this.controls.showY = true;
        this.controls.showZ = this.effectiveMode === 'translate';
        this.onModeStateChanged?.(this.getModeState());
    }

    private canRotateSelection(): boolean {
        return this.activeNodes.length === 0 &&
            this.activeElements.length > 0 &&
            this.activeElements.every((element) => element.canRotate());
    }

    private resetHelperRotation(): void {
        this.helper.rotation.set(0, 0, 0);
        this.helper.quaternion.identity();
    }

    private syncHelperState(): void {
        this.helperLastPosition.copy(this.helper.position);
        this.helperLastQuaternion.copy(this.helper.quaternion);
    }

    private getElementCenterWorld(element: WorldElement): THREE.Vector3 {
        const nodes = element.getTransformWorldNodes();
        const center = new THREE.Vector3();

        if (nodes.length > 0) {
            for (const node of nodes) {
                const worldPos = new THREE.Vector3();
                node.mesh.getWorldPosition(worldPos);
                center.add(worldPos);
            }
            center.divideScalar(nodes.length);
            return center;
        }

        const area = element.getOccupiedArea();
        if (area.length > 0) {
            let count = 0;
            for (const tri of area) {
                center.x += tri.a.x + tri.b.x + tri.c.x;
                center.y += tri.a.y + tri.b.y + tri.c.y;
                center.z += tri.a.z + tri.b.z + tri.c.z;
                count += 3;
            }
            if (count > 0) {
                center.x /= count;
                center.y /= count;
                center.z /= count;
            }
            return center;
        }

        element.mesh.getWorldPosition(center);
        return center;
    }

    public get isDragging(): boolean {
        return this.controls.dragging;
    }

    public dispose(): void {
        this.controls.removeEventListener('change', this.onGizmoChange);
        this.controls.removeEventListener('mouseDown', this.onGizmoMouseDown);
        this.controls.removeEventListener('mouseUp', this.onGizmoMouseUp);
        this.controls.dispose();
    }
}
