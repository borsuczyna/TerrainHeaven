import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import RiverSpline from '../../elements/RiverSpline';
import type WorldNode from '../../elements/WorldNode';
import HistoryManager from '../HistoryManager';

@singleton()
export default class RiverSplineTool implements Tool {
    public readonly name = 'river';
    public readonly blocksCamera = true;
    private scene: SceneManager;
    private camera: THREE.PerspectiveCamera;
    private raycaster = new THREE.Raycaster();
    private mouse = new THREE.Vector2();
    private startNode: WorldNode | null = null;
    private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    private dragging = false;
    private previewRiver: RiverSpline | null = null;

    constructor(
        @inject(SceneManager) scene: SceneManager,
        @inject(Camera) camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
    ) {
        this.scene = scene;
        this.camera = camera.instance;
    }

    activate(): void {
        this.reset();
        window.addEventListener('mouseup', this.handleMouseUp);
        window.addEventListener('mousemove', this.onMouseMove);
    }

    deactivate(): void {
        this.cancelPreview();
        window.removeEventListener('mouseup', this.handleMouseUp);
        window.removeEventListener('mousemove', this.onMouseMove);
    }

    private reset(): void {
        this.startNode = null;
        this.dragging = false;
        this.previewRiver = null;
    }

    private cancelPreview(): void {
        if (this.previewRiver) {
            this.scene.remove(this.previewRiver);
            this.previewRiver = null;
        }
        this.startNode = null;
        this.dragging = false;
    }

    private updateMouse(e: MouseEvent): void {
        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);
    }

    private findHitNode(): WorldNode | null {
        const targets: THREE.Object3D[] = [];
        for (const child of this.scene.instance.children) {
            if (this.previewRiver && child === this.previewRiver.mesh) continue;
            if (child.type !== 'TransformControlsRoot' && child.type !== 'TransformControlsGizmo' && child.type !== 'TransformControlsPlane') {
                targets.push(child);
            }
        }
        const intersects = this.raycaster.intersectObjects(targets, true);
        for (const hit of intersects) {
            const node = hit.object.userData.worldNode as WorldNode | undefined;
            if (node) return node;
        }
        return null;
    }

    private getGroundPoint(): THREE.Vector3 | null {
        const target = new THREE.Vector3();
        return this.raycaster.ray.intersectPlane(this.groundPlane, target) ? target : null;
    }

    private getEndPoint(e: MouseEvent): THREE.Vector3 | null {
        this.updateMouse(e);
        const hitNode = this.findHitNode();
        if (hitNode) {
            const wp = new THREE.Vector3();
            hitNode.mesh.getWorldPosition(wp);
            return wp;
        }
        return this.getGroundPoint();
    }

    private onMouseMove = (e: MouseEvent): void => {
        if (!this.dragging || !this.previewRiver) return;
        const endPoint = this.getEndPoint(e);
        if (endPoint) {
            this.previewRiver.nodeB.update(endPoint);
        }
    };

    onMouseDown(e: MouseEvent): boolean {
        if (e.button !== 0) return false;
        if ((e.target as HTMLElement).closest('#toolbar')) return false;
        if ((e.target as HTMLElement).closest('#properties-panel')) return false;

        this.updateMouse(e);
        const hitNode = this.findHitNode();

        let startPos: THREE.Vector3;
        if (hitNode) {
            this.startNode = hitNode;
            startPos = new THREE.Vector3();
            hitNode.mesh.getWorldPosition(startPos);
        } else {
            const gp = this.getGroundPoint();
            if (!gp) return false;
            startPos = gp;
        }

        this.previewRiver = new RiverSpline(startPos.clone(), startPos.clone());
        this.scene.add(this.previewRiver);

        if (this.startNode?.parent) {
            const parentElement = this.startNode.parent;
            const nodeIndex = parentElement.getNodeIndex(this.startNode);
            if (nodeIndex >= 0 && !parentElement.isConnected(nodeIndex)) {
                this.previewRiver.connect(0, parentElement, nodeIndex);
            }
        }

        this.dragging = true;
        return true;
    }

    private handleMouseUp = (e: MouseEvent): void => {
        if (e.button !== 0 || !this.dragging || !this.previewRiver) return;

        this.updateMouse(e);
        const hitNode = this.findHitNode();

        let startPos: THREE.Vector3;
        if (this.startNode) {
            startPos = new THREE.Vector3();
            this.startNode.mesh.getWorldPosition(startPos);
        } else {
            startPos = this.previewRiver.nodeA.mesh.position.clone();
        }

        let endPos: THREE.Vector3;
        if (hitNode) {
            endPos = new THREE.Vector3();
            hitNode.mesh.getWorldPosition(endPos);
        } else {
            const gp = this.getGroundPoint();
            if (!gp) { this.cancelPreview(); return; }
            endPos = gp;
        }

        if (startPos.distanceTo(endPos) < 0.1) {
            this.cancelPreview();
            return;
        }

        this.previewRiver.nodeB.update(endPos);

        if (hitNode?.parent) {
            const parentElement = hitNode.parent;
            const nodeIndex = parentElement.getNodeIndex(hitNode);
            if (nodeIndex >= 0 && !parentElement.isConnected(nodeIndex)) {
                this.previewRiver.connect(1, parentElement, nodeIndex);
            }
        }

        this.history.record('Add River Spline');
        this.reset();
    };
}
