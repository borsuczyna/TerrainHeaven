import * as THREE from 'three';
import type WorldElement from '../../elements/WorldElement';
import type WorldNode from '../../elements/WorldNode';
import type Camera from '../Camera';
import type HistoryManager from '../HistoryManager';
import type SceneManager from '../SceneManager';
import type { Tool } from '../ToolManager';
import type PresetManager from '../PresetManager';

export interface CurvePlacementElement extends WorldElement {
    readonly nodeA: WorldNode;
    readonly nodeB: WorldNode;
    divisions: number;
    setCurvePointA(point: THREE.Vector3 | null): void;
    setCurvePointB(point: THREE.Vector3 | null): void;
}

type PlacementPhase = 'idle' | 'straight' | 'start-handle' | 'choose-end' | 'end-handle';

const DEFAULT_CURVE_DIVISIONS = 12;
const MIN_ELEMENT_LENGTH = 0.1;

export default abstract class SplinePlacementTool<T extends CurvePlacementElement> implements Tool {
    public abstract readonly name: string;
    public readonly blocksCamera = true;
    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();
    private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    private phase: PlacementPhase = 'idle';
    private preview: T | null = null;
    private startNode: WorldNode | null = null;
    private endNode: WorldNode | null = null;
    private endAnchor: THREE.Vector3 | null = null;

    protected constructor(
        protected readonly scene: SceneManager,
        protected readonly camera: Camera,
        protected readonly history: HistoryManager,
        protected readonly presets: PresetManager,
    ) {}

    protected abstract createElement(start: THREE.Vector3, end: THREE.Vector3): T;
    protected abstract get historyLabel(): string;

    public activate(): void {
        this.reset();
        window.addEventListener('mouseup', this.handleMouseUp);
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('keydown', this.onKeyDown);
    }

    public deactivate(): void {
        this.cancelPreview();
        window.removeEventListener('mouseup', this.handleMouseUp);
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('keydown', this.onKeyDown);
    }

    public onMouseDown(e: MouseEvent): boolean {
        if (e.button !== 0 || !this.isCanvasEvent(e)) return false;

        if (this.phase === 'choose-end' && this.preview) {
            const endpoint = this.getPlacementPoint(e);
            if (!endpoint) return true;
            this.endNode = endpoint.node;
            this.endAnchor = endpoint.position;
            this.preview.nodeB.update(endpoint.position);
            this.updateAutomaticEndHandle();
            this.phase = 'end-handle';
            return true;
        }

        if (this.phase !== 'idle') return true;
        const start = this.getPlacementPoint(e);
        if (!start) return false;

        this.startNode = start.node;
        this.preview = this.createElement(start.position.clone(), start.position.clone());
        this.presets.applyDefault(this.preview);
        this.scene.add(this.preview);
        this.connectStartIfPossible();

        if (e.ctrlKey || e.metaKey) {
            if (this.preview.divisions <= 0) this.preview.divisions = DEFAULT_CURVE_DIVISIONS;
            this.preview.setCurvePointA(start.position.clone());
            this.preview.setCurvePointB(start.position.clone());
            this.updatePreviewAndConnections();
            this.phase = 'start-handle';
        } else {
            this.phase = 'straight';
        }
        return true;
    }

    private onMouseMove = (e: MouseEvent): void => {
        if (!this.preview || this.phase === 'idle') return;
        const point = this.getPlacementPoint(e, this.phase === 'start-handle' || this.phase === 'end-handle');
        if (!point) return;

        if (this.phase === 'start-handle') {
            this.preview.setCurvePointA(point.position);
            this.updatePreviewAndConnections();
            return;
        }

        if (this.phase === 'straight' || this.phase === 'choose-end') {
            this.preview.nodeB.update(this.snapEndpoint(point.position, e.shiftKey));
            if (this.phase === 'choose-end') this.updateAutomaticEndHandle();
            else this.updateConnectedElements();
            return;
        }

        if (this.phase === 'end-handle' && this.endAnchor) {
            // Figma/Pen-style handle: dragging beyond the anchor controls the incoming
            // handle on the opposite side of that anchor.
            const incomingHandle = this.endAnchor.clone().multiplyScalar(2).sub(point.position);
            this.preview.setCurvePointB(incomingHandle);
            this.updatePreviewAndConnections();
        }
    };

    private handleMouseUp = (e: MouseEvent): void => {
        if (e.button !== 0 || !this.preview) return;

        if (this.phase === 'start-handle') {
            this.phase = 'choose-end';
            return;
        }

        if (this.phase === 'straight') {
            const endpoint = this.getPlacementPoint(e);
            if (!endpoint) {
                this.cancelPreview();
                return;
            }
            this.endNode = endpoint.node;
            this.preview.nodeB.update(this.snapEndpoint(endpoint.position, e.shiftKey));
            this.finalize();
            return;
        }

        if (this.phase === 'end-handle') this.finalize();
    };

    private onKeyDown = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape' || this.phase === 'idle') return;
        e.preventDefault();
        this.cancelPreview();
    };

    private updateAutomaticEndHandle(): void {
        if (!this.preview) return;
        const start = this.getStartPosition();
        const end = this.preview.nodeB.mesh.position;
        this.preview.setCurvePointB(end.clone().lerp(start, 1 / 3));
        this.updatePreviewAndConnections();
    }

    private finalize(): void {
        if (!this.preview) return;
        const start = this.getStartPosition();
        const end = this.preview.nodeB.mesh.position.clone();
        if (start.distanceTo(end) < MIN_ELEMENT_LENGTH) {
            this.cancelPreview();
            return;
        }

        if (this.endNode?.parent) {
            const parent = this.endNode.parent;
            const nodeIndex = parent.getNodeIndex(this.endNode);
            if (nodeIndex >= 0 && !parent.isConnected(nodeIndex)) this.preview.connect(1, parent, nodeIndex);
        }

        this.updatePreviewAndConnections();
        this.history.record(this.historyLabel);
        this.reset();
    }

    private connectStartIfPossible(): void {
        if (!this.preview || !this.startNode?.parent) return;
        const parent = this.startNode.parent;
        const nodeIndex = parent.getNodeIndex(this.startNode);
        if (nodeIndex >= 0 && !parent.isConnected(nodeIndex) && this.preview.connect(0, parent, nodeIndex)) {
            this.updatePreviewAndConnections();
        }
    }

    private updatePreviewAndConnections(): void {
        if (!this.preview) return;
        this.preview.update();
        this.updateConnectedElements();
    }

    private updateConnectedElements(): void {
        if (!this.preview) return;
        const connected = new Set<WorldElement>();
        for (const connection of this.preview.connections.values()) connected.add(connection.element);
        for (const element of connected) element.update();
    }

    private getStartPosition(): THREE.Vector3 {
        if (this.startNode) {
            const position = new THREE.Vector3();
            this.startNode.mesh.getWorldPosition(position);
            return position;
        }
        return this.preview?.nodeA.mesh.position.clone() ?? new THREE.Vector3();
    }

    private snapEndpoint(position: THREE.Vector3, enabled: boolean): THREE.Vector3 {
        if (!enabled) return position;
        const start = this.getStartPosition();
        const delta = position.clone().sub(start);
        const horizontalLength = Math.hypot(delta.x, delta.z);
        if (horizontalLength < 1e-8) return position;
        const step = Math.PI / 4;
        const angle = Math.round(Math.atan2(delta.z, delta.x) / step) * step;
        return new THREE.Vector3(
            start.x + Math.cos(angle) * horizontalLength,
            position.y,
            start.z + Math.sin(angle) * horizontalLength,
        );
    }

    private getPlacementPoint(e: MouseEvent, ignoreNodes = false): { position: THREE.Vector3; node: WorldNode | null } | null {
        this.updateMouse(e);
        if (!ignoreNodes) {
            const node = this.findHitNode();
            if (node) {
                const position = new THREE.Vector3();
                node.mesh.getWorldPosition(position);
                return { position, node };
            }
        }
        const position = new THREE.Vector3();
        return this.raycaster.ray.intersectPlane(this.groundPlane, position) ? { position, node: null } : null;
    }

    private updateMouse(e: MouseEvent): void {
        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera.instance);
    }

    private findHitNode(): WorldNode | null {
        const targets: THREE.Object3D[] = [];
        for (const child of this.scene.instance.children) {
            if (this.preview && child === this.preview.mesh) continue;
            if (!child.userData.isGizmoWidget) {
                targets.push(child);
            }
        }
        for (const hit of this.raycaster.intersectObjects(targets, true)) {
            const node = hit.object.userData.worldNode as WorldNode | undefined;
            if (node) return node;
        }
        return null;
    }

    private isCanvasEvent(e: MouseEvent): boolean {
        return (e.target as HTMLElement).tagName === 'CANVAS';
    }

    private cancelPreview(): void {
        if (this.preview) this.scene.remove(this.preview);
        this.reset();
    }

    private reset(): void {
        this.phase = 'idle';
        this.preview = null;
        this.startNode = null;
        this.endNode = null;
        this.endAnchor = null;
    }
}
