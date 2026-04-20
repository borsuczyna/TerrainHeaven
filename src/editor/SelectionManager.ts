import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type WorldNode from '../elements/WorldNode';
import type WorldElement from '../elements/WorldElement';
import Camera from './Camera';
import SceneManager from './SceneManager';
import type GizmoManager from './GizmoManager';
import type ToolManager from './ToolManager';

@singleton()
export default class SelectionManager {
    private selected: Set<WorldNode> = new Set();
    private selectedElements: Set<WorldElement> = new Set();
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

    constructor(
        @inject(Camera) camera: Camera,
        @inject(SceneManager) scene: SceneManager,
    ) {
        this.camera = camera.instance;
        this.scene = scene.instance;

        window.addEventListener('mousedown', this.onMouseDown, { capture: true });
    }

    private onMouseDown = (e: MouseEvent): void => {
        if (e.button !== 0) return;

        // Ignore clicks on any UI element (only respond to canvas)
        if ((e.target as HTMLElement).tagName !== 'CANVAS') return;

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
            // Also select the parent element for properties / gizmo
            if (hitNode.parent) {
                if (ctrlHeld) {
                    this.selectElementAdd(hitNode.parent);
                } else {
                    this.clearElementSelection();
                    this.selectElementAdd(hitNode.parent);
                }
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
            if (ctrlHeld) {
                if (this.selectedElements.has(hitElement)) {
                    this.deselectElement(hitElement);
                } else {
                    this.selectElementAdd(hitElement);
                }
            } else {
                this.clearElementSelection();
                this.selectElementAdd(hitElement);
            }
        } else if (!ctrlHeld) {
            this.clearSelection();
            this.clearElementSelection();
        }

        this.emitElementSelection();
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

    private selectElementAdd(element: WorldElement): void {
        this.selectedElements.add(element);
        element.setSelected(true);
    }

    private deselectElement(element: WorldElement): void {
        if (!this.selectedElements.has(element)) return;
        this.selectedElements.delete(element);
        element.setSelected(false);
    }

    private clearElementSelection(): void {
        for (const element of this.selectedElements) {
            element.setSelected(false);
        }
        this.selectedElements.clear();
    }

    private emitElementSelection(): void {
        if (this.selectedElements.size === 1) {
            this.onElementSelected?.([...this.selectedElements][0]);
        } else {
            this.onElementSelected?.(null);
        }
    }

    public getSelected(): WorldNode[] {
        return [...this.selected];
    }

    public getSelectedElement(): WorldElement | null {
        return this.selectedElements.size === 1 ? [...this.selectedElements][0] : null;
    }

    public getSelectedElements(): WorldElement[] {
        return [...this.selectedElements];
    }

    public selectElement(element: WorldElement): void {
        this.clearSelection();
        this.clearElementSelection();
        this.selectElementAdd(element);
        this.emitElementSelection();
        this.onSelectionChanged?.([]);
    }

    public dispose(): void {
        window.removeEventListener('mousedown', this.onMouseDown, { capture: true });
    }
}
