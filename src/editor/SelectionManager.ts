import * as THREE from 'three';
import type WorldNode from '../elements/WorldNode';
import type WorldElement from '../elements/WorldElement';
import type GizmoManager from './GizmoManager';
import type ToolManager from './ToolManager';

export default class SelectionManager {
    private selected: Set<WorldNode> = new Set();
    private selectedElement: WorldElement | null = null;
    private raycaster = new THREE.Raycaster();
    private mouse = new THREE.Vector2();
    private camera: THREE.PerspectiveCamera;
    private scene: THREE.Scene;
    public gizmo: GizmoManager | null = null;
    public toolManager: ToolManager | null = null;
    private _nodeWasHit = false;

    public get nodeWasHit(): boolean {
        const v = this._nodeWasHit;
        this._nodeWasHit = false;
        return v;
    }

    public onSelectionChanged: ((nodes: WorldNode[]) => void) | null = null;
    public onElementSelected: ((element: WorldElement | null) => void) | null = null;

    constructor(camera: THREE.PerspectiveCamera, scene: THREE.Scene) {
        this.camera = camera;
        this.scene = scene;

        window.addEventListener('mousedown', this.onMouseDown, { capture: true });
    }

    private onMouseDown = (e: MouseEvent): void => {
        if (e.button !== 0) return;

        // Ignore clicks on UI
        if ((e.target as HTMLElement).closest('#toolbar')) return;
        if ((e.target as HTMLElement).closest('#properties-panel')) return;

        // Delegate to active tool first
        const activeTool = this.toolManager?.getActive();
        if (activeTool?.name !== 'select' && activeTool?.onMouseDown?.(e)) return;

        // Ignore when gizmo is being used
        if (this.gizmo?.isDragging) return;

        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        // Collect non-gizmo objects for raycasting
        const targets: THREE.Object3D[] = [];
        for (const child of this.scene.children) {
            if (child.type !== 'TransformControlsRoot' && child.type !== 'TransformControlsGizmo' && child.type !== 'TransformControlsPlane') {
                targets.push(child);
            }
        }
        const intersects = this.raycaster.intersectObjects(targets, true);

        let hitNode: WorldNode | null = null;
        let hitElement: WorldElement | null = null;
        for (const hit of intersects) {
            const node = hit.object.userData.worldNode as WorldNode | undefined;
            if (node) {
                hitNode = node;
                break;
            }
            // Only match the directly hit mesh if it is a WorldElement
            const el = hit.object.userData.worldElement as WorldElement | undefined;
            if (el) {
                hitElement = el;
                break;
            }
        }

        const ctrlHeld = e.ctrlKey || e.metaKey;

        if (hitNode) {
            this._nodeWasHit = true;
            // Also select the parent element for properties
            if (hitNode.parent && hitNode.parent !== this.selectedElement) {
                this.deselectElement();
                this.selectedElement = hitNode.parent;
                this.selectedElement.setSelected(true);
                this.onElementSelected?.(this.selectedElement);
            }
            if (ctrlHeld) {
                if (this.selected.has(hitNode)) {
                    this.deselect(hitNode);
                } else {
                    this.selectAdd(hitNode);
                }
            } else {
                this.clearSelection();
                this.selectAdd(hitNode);
            }
        } else if (hitElement) {
            this._nodeWasHit = true;
            this.clearSelection();
            this.deselectElement();
            this.selectedElement = hitElement;
            this.selectedElement.setSelected(true);
            this.onElementSelected?.(this.selectedElement);
        } else if (!ctrlHeld) {
            this.clearSelection();
            this.deselectElement();
            this.onElementSelected?.(null);
        }

        this.onSelectionChanged?.(this.getSelected());
    };

    private selectAdd(node: WorldNode): void {
        this.selected.add(node);
        node.setSelected(true);
    }

    private deselect(node: WorldNode): void {
        this.selected.delete(node);
        node.setSelected(false);
    }

    public clearSelection(): void {
        for (const node of this.selected) {
            node.setSelected(false);
        }
        this.selected.clear();
    }

    private deselectElement(): void {
        if (this.selectedElement) {
            this.selectedElement.setSelected(false);
            this.selectedElement = null;
        }
    }

    public getSelected(): WorldNode[] {
        return [...this.selected];
    }

    public dispose(): void {
        window.removeEventListener('mousedown', this.onMouseDown, { capture: true });
    }
}
