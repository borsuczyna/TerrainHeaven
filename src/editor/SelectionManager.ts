import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type WorldNode from '../elements/WorldNode';
import type WorldElement from '../elements/WorldElement';
import Camera from './Camera';
import SceneManager from './SceneManager';
import type { PropertyDefinition } from './Properties';
import GizmoManager from './GizmoManager';
import ToolManager from './ToolManager';
import PropertiesPanel from './PropertiesPanel';
import CopyManager from './CopyManager';
import HistoryManager from './HistoryManager';
import TerrainCutPointManager from './TerrainCutPointManager';

@singleton()
export default class SelectionManager {
    private selected: Set<WorldNode> = new Set();
    private selectedElements: Set<WorldElement> = new Set();
    private raycaster = new THREE.Raycaster();
    private mouse = new THREE.Vector2();
    private cameraController: Camera;
    private sceneManager: SceneManager;
    private camera: THREE.PerspectiveCamera;
    private scene: THREE.Scene;
    private gizmo: GizmoManager;
    private toolManager: ToolManager;
    private properties: PropertiesPanel;
    private copyManager: CopyManager;
    private history: HistoryManager;
    private _nodeWasHit = false;

    public get nodeWasHit(): boolean {
        const v = this._nodeWasHit;
        this._nodeWasHit = false;
        return v;
    }

    public onSelectionChanged: ((nodes: WorldNode[]) => void) | null = null;

    constructor(
        @inject(Camera) camera: Camera,
        @inject(SceneManager) scene: SceneManager,
        @inject(GizmoManager) gizmo: GizmoManager,
        @inject(ToolManager) toolManager: ToolManager,
        @inject(PropertiesPanel) properties: PropertiesPanel,
        @inject(CopyManager) copyManager: CopyManager,
        @inject(HistoryManager) history: HistoryManager,
        @inject(TerrainCutPointManager) private readonly terrainCutPoints: TerrainCutPointManager,
    ) {
        this.cameraController = camera;
        this.sceneManager = scene;
        this.camera = camera.instance;
        this.scene = scene.instance;
        this.gizmo = gizmo;
        this.toolManager = toolManager;
        this.properties = properties;
        this.copyManager = copyManager;
        this.history = history;

        window.addEventListener('mousedown', this.onMouseDown, { capture: true });
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('history-restored', this.onHistoryRestored);
    }

    private onMouseDown = (e: MouseEvent): void => {
        if (e.button !== 0) return;

        // Ignore clicks on any UI element (only respond to canvas)
        if ((e.target as HTMLElement).tagName !== 'CANVAS') return;

        // Delegate to active tool first
        const activeTool = this.toolManager.getActive();
        if (activeTool?.name !== 'select' && activeTool?.onMouseDown?.(e)) return;

        // Ignore when gizmo is being used
        if (this.gizmo.isDragging) return;

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
                this.clearNodeSelection();
                this.selectAdd(hitNode);
            }
        } else if (hitElement) {
            this._nodeWasHit = true;
            this.clearNodeSelection();
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
            this.clearNodeSelection();
            this.clearElementSelection();
        }

        this.emitSelectionChanged();
    };

    private onKeyDown = (e: KeyboardEvent): void => {
        const target = e.target as HTMLElement | null;
        const tagName = target?.tagName;
        if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') return;
        if (e.repeat) return;
        if (!e.ctrlKey && !e.metaKey) return;

        if (e.key === 'c' || e.key === 'C') {
            const element = this.getSelectedElement();
            if (!element) return;
            e.preventDefault();
            this.copyManager.copyElement(element);
            return;
        }

        if (e.key === 'v' || e.key === 'V') {
            e.preventDefault();
            const selectedElement = this.getSelectedElement();
            if (selectedElement && this.copyManager.canPastePropertiesOnto(selectedElement)) {
                this.copyManager.pastePropertiesOnto(selectedElement);
                this.history.record('Paste Properties');
                return;
            }

            if (this.copyManager.canPasteElement()) {
                const newElement = this.copyManager.pasteElement(this.cameraController.instance, this.sceneManager);
                if (newElement) {
                    this.selectElement(newElement);
                    this.history.record('Paste Element');
                }
            }

            return;
        }

        if (e.key === 'z' || e.key === 'Z') {
            e.preventDefault();
            if (e.shiftKey) {
                this.history.redo();
            } else {
                this.history.undo();
            }
            return;
        }

        if (e.key === 'y' || e.key === 'Y') {
            e.preventDefault();
            this.history.redo();
        }
    };

    private onHistoryRestored = (): void => {
        this.clearSelection();
        this.emitSelectionChanged();
    };

    private selectAdd(node: WorldNode): void {
        this.selected.add(node);
        node.setSelected(true);
    }

    private deselect(node: WorldNode): void {
        this.selected.delete(node);
        node.setSelected(false);
    }

    private clearNodeSelection(): void {
        for (const node of this.selected) {
            node.setSelected(false);
        }
        this.selected.clear();
    }

    public clearSelection(): void {
        this.clearNodeSelection();
        this.clearElementSelection();
        this.emitSelectionChanged();
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

    private emitSelectionChanged(): void {
        const nodes = this.getSelected();
        const selectedElements = this.getSelectedElements();

        if (nodes.length > 0) {
            this.gizmo.attach(nodes);
        } else {
            this.gizmo.attachElements(selectedElements);
        }

        this.syncPropertiesPanel(nodes, selectedElements);
        this.onSelectionChanged?.(nodes);
    }

    private syncPropertiesPanel(nodes: WorldNode[], selectedElements: WorldElement[]): void {
        const content = this.getSelectionPresentation(nodes, selectedElements);
        if (!content) {
            this.properties.hide();
            return;
        }

        if ('sections' in content) {
            this.properties.showCustom(content);
            return;
        }

        this.properties.show(content);
    }

    private getSelectionPresentation(nodes: WorldNode[], selectedElements: WorldElement[]): WorldElement | PropertyDefinition | null {
        const isMultiSelection = nodes.length >= 2 || selectedElements.length >= 2;
        if (isMultiSelection) {
            return this.getSelectionActions(nodes, selectedElements);
        }

        if (selectedElements.length === 1) {
            return selectedElements[0];
        }

        if (nodes.length === 1 && nodes[0].parent) {
            return nodes[0].parent;
        }

        if (nodes.length === 1) {
            return this.terrainCutPoints.getProperties(nodes[0]);
        }

        return null;
    }

    private getSelectionActions(nodes: WorldNode[], selectedElements: WorldElement[]): PropertyDefinition | null {
        const actions: { type: 'button'; label: string; onClick: () => void }[] = [];

        if (nodes.length === 2) {
            actions.push({
                type: 'button',
                label: 'Merge Nodes',
                onClick: () => {
                    const [a, b] = nodes;
                    if (!a.parent || !b.parent) return;
                    if (a.parent === b.parent) return;
                    const idxA = a.parent.getNodeIndex(a);
                    const idxB = b.parent.getNodeIndex(b);
                    if (idxA < 0 || idxB < 0) return;
                    if (a.parent.isConnected(idxA) || b.parent.isConnected(idxB)) return;

                    const parentA = a.parent;
                    const parentB = b.parent;
                    parentA.connect(idxA, parentB, idxB);
                    parentA.update();
                    parentB.update();
                    this.clearSelection();
                },
            });
        }

        if (nodes.length >= 2 || selectedElements.length >= 2) {
            actions.push({
                type: 'button',
                label: 'Clear Selection',
                onClick: () => {
                    this.clearSelection();
                },
            });
        }

        if (actions.length === 0) return null;

        return {
            title: 'Selection',
            icon: '&#9654;',
            sections: [{
                label: 'Actions',
                properties: actions,
            }],
        };
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
        this.clearNodeSelection();
        this.clearElementSelection();
        this.selectElementAdd(element);
        this.emitSelectionChanged();
    }

    public dispose(): void {
        window.removeEventListener('mousedown', this.onMouseDown, { capture: true });
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('history-restored', this.onHistoryRestored);
    }
}
