import * as THREE from 'three';
import { inject, singleton } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import HistoryManager from '../HistoryManager';
import PresetManager from '../PresetManager';
import Stairs from '../../elements/Stairs';
import type WorldNode from '../../elements/WorldNode';

const DEFAULT_RUN = 5;
const DEFAULT_RISE = 3;
const MIN_RUN = 0.1;

@singleton()
export default class StairsTool implements Tool {
    public readonly name = 'stairs';
    public readonly blocksCamera = true;
    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();
    private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    private preview: Stairs | null = null;
    private startNode: WorldNode | null = null;
    private defaultRise = DEFAULT_RISE;

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) private readonly camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(PresetManager) private readonly presets: PresetManager,
    ) {}

    public activate(): void {
        this.cancel();
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.handleMouseUp);
        window.addEventListener('keydown', this.onKeyDown);
    }

    public deactivate(): void {
        this.cancel();
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.handleMouseUp);
        window.removeEventListener('keydown', this.onKeyDown);
    }

    public onMouseDown(event: MouseEvent): boolean {
        if (event.button !== 0 || (event.target as HTMLElement).tagName !== 'CANVAS') return false;
        if (this.preview) return true;
        const start = this.resolvePoint(event);
        if (!start) return false;

        const end = start.position.clone().add(new THREE.Vector3(DEFAULT_RUN, DEFAULT_RISE, 0));
        this.preview = new Stairs(start.position, end);
        this.presets.applyDefault(this.preview);
        this.defaultRise = Math.max(0.1, this.preview.nodeB.mesh.position.y - this.preview.nodeA.mesh.position.y);
        this.startNode = start.node;
        this.scene.add(this.preview);
        this.connectStartIfPossible();
        event.preventDefault();
        return true;
    }

    private onMouseMove = (event: MouseEvent): void => {
        if (!this.preview) return;
        const target = this.resolvePoint(event);
        if (target) this.updateEndpoint(target, event.shiftKey);
    };

    private handleMouseUp = (event: MouseEvent): void => {
        if (event.button !== 0 || !this.preview) return;
        const target = this.resolvePoint(event);
        if (target) this.updateEndpoint(target, event.shiftKey);

        const a = this.preview.nodeA.mesh.position;
        const b = this.preview.nodeB.mesh.position;
        if (Math.hypot(b.x - a.x, b.z - a.z) < MIN_RUN) {
            this.cancel();
            return;
        }

        if (target?.node?.parent && Math.abs(target.position.y - b.y) < 0.05) {
            const parent = target.node.parent;
            const nodeIndex = parent.getNodeIndex(target.node);
            if (nodeIndex >= 0 && !parent.isConnected(nodeIndex)) this.preview.connect(1, parent, nodeIndex);
        }
        this.preview.update();
        this.history.record('Add Stairs');
        this.preview = null;
        this.startNode = null;
    };

    private onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || !this.preview) return;
        event.preventDefault();
        this.cancel();
    };

    private updateEndpoint(target: PlacementPoint, snap: boolean): void {
        if (!this.preview) return;
        const start = this.preview.nodeA.mesh.position;
        const next = target.position.clone();
        if (snap) {
            const dx = next.x - start.x;
            const dz = next.z - start.z;
            const length = Math.hypot(dx, dz);
            if (length > 1e-8) {
                const step = Math.PI / 4;
                const angle = Math.round(Math.atan2(dz, dx) / step) * step;
                next.x = start.x + Math.cos(angle) * length;
                next.z = start.z + Math.sin(angle) * length;
            }
        }
        next.y = target.position.y >= start.y + 0.1 ? target.position.y : start.y + this.defaultRise;
        this.preview.nodeB.update(next);
        this.preview.update();
        for (const connection of this.preview.connections.values()) connection.element.update();
    }

    private connectStartIfPossible(): void {
        if (!this.preview || !this.startNode?.parent) return;
        const parent = this.startNode.parent;
        const nodeIndex = parent.getNodeIndex(this.startNode);
        if (nodeIndex >= 0 && !parent.isConnected(nodeIndex)) this.preview.connect(0, parent, nodeIndex);
    }

    private resolvePoint(event: MouseEvent): PlacementPoint | null {
        this.mouse.set(
            event.clientX / window.innerWidth * 2 - 1,
            -(event.clientY / window.innerHeight) * 2 + 1,
        );
        this.raycaster.setFromCamera(this.mouse, this.camera.instance);
        const targets = this.scene.instance.children.filter((child) => (
            child !== this.preview?.mesh && !child.userData.isGizmoWidget
        ));
        const hits = this.raycaster.intersectObjects(targets, true);
        const nodeHit = hits.find((hit) => hit.object.userData.worldNode !== undefined);
        if (nodeHit) {
            const node = nodeHit.object.userData.worldNode as WorldNode;
            const position = new THREE.Vector3();
            node.mesh.getWorldPosition(position);
            return { position, node };
        }
        const surfaceHit = hits.find((hit) => hit.face && hit.object.userData.worldElement !== undefined);
        if (surfaceHit) return { position: surfaceHit.point.clone(), node: null };
        const fallback = new THREE.Vector3();
        return this.raycaster.ray.intersectPlane(this.groundPlane, fallback)
            ? { position: fallback, node: null }
            : null;
    }

    private cancel(): void {
        if (this.preview) this.scene.remove(this.preview);
        this.preview = null;
        this.startNode = null;
    }
}

interface PlacementPoint {
    position: THREE.Vector3;
    node: WorldNode | null;
}
