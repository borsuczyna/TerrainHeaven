import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import Camera from './Camera';
import SceneManager from './SceneManager';
import HistoryManager from './HistoryManager';

// A draggable resize handle placed directly in the viewport (see Building's addHandle) -
// grabbing and dragging it changes a single scalar building property (segment width, wall
// height, roof ridge height, ...) without going through the Properties panel or a
// TransformControls arrow widget. `axis` is the world-space direction the handle's own
// position moves in as the value increases; `sensitivity` is how many world units the
// handle moves per 1 unit of value change (1 for a handle that tracks the value directly,
// e.g. wall height; 0.5 for an edge handle resizing a symmetric width/depth about a fixed
// center, since only half the size change shows up at that one edge).
export interface BuildingHandleDescriptor {
    getValue: () => number;
    setValue: (value: number) => void;
    getPosition: () => THREE.Vector3;
    axis: THREE.Vector3;
    sensitivity: number;
    label: string;
    min?: number;
    max?: number;
}

@singleton()
export default class BuildingHandleManager {
    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();
    private dragging = false;

    constructor(
        @inject(Camera) private readonly camera: Camera,
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(HistoryManager) private readonly history: HistoryManager,
    ) {}

    public get isDragging(): boolean {
        return this.dragging;
    }

    // Called from SelectionManager before its own node/element pick logic runs, so grabbing
    // a handle never also selects the node underneath it or starts a box-select. Returns
    // true (and takes over the whole drag) whenever a handle was actually hit.
    public tryStartDrag(e: MouseEvent): boolean {
        if (this.dragging) return true;

        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera.instance);

        const targets: THREE.Object3D[] = [];
        this.scene.instance.traverse((obj) => {
            if (obj.visible && obj.userData.buildingHandle) targets.push(obj);
        });
        if (targets.length === 0) return false;

        const hit = this.raycaster.intersectObjects(targets, false)[0];
        if (!hit) return false;

        this.startDrag(e, hit.object.userData.buildingHandle as BuildingHandleDescriptor);
        return true;
    }

    private worldToScreen(worldPos: THREE.Vector3): THREE.Vector2 {
        const projected = worldPos.clone().project(this.camera.instance);
        return new THREE.Vector2(
            (projected.x + 1) * 0.5 * window.innerWidth,
            (1 - projected.y) * 0.5 * window.innerHeight,
        );
    }

    private startDrag(e: MouseEvent, handle: BuildingHandleDescriptor): void {
        const startMouseX = e.clientX;
        const startMouseY = e.clientY;
        const startValue = handle.getValue();
        const startPos = handle.getPosition();

        // Calibrated once, from how far the handle would move on screen for exactly 1 unit
        // of value change (not a generic unit-axis vector) - this bakes sensitivity in, so
        // screenDelta * valuePerPixel below is already in value units, no further scaling
        // needed in the per-frame move handler. Computed once at drag start (not every
        // frame) so the drag's feel stays consistent even as the handle itself moves.
        const screenP0 = this.worldToScreen(startPos);
        const screenP1 = this.worldToScreen(startPos.clone().addScaledVector(handle.axis, handle.sensitivity || 1));
        const screenAxis = screenP1.clone().sub(screenP0);
        const screenAxisLengthSq = screenAxis.lengthSq();
        if (screenAxisLengthSq < 1e-6) return;
        const screenAxisDir = screenAxis.clone().normalize();
        const valuePerPixel = 1 / Math.sqrt(screenAxisLengthSq);

        this.dragging = true;
        const historyLabel = `Edit ${handle.label}`;
        this.history.beginAction(historyLabel);

        const onMouseMove = (moveEvent: MouseEvent): void => {
            const dx = moveEvent.clientX - startMouseX;
            const dy = moveEvent.clientY - startMouseY;
            const screenDelta = dx * screenAxisDir.x + dy * screenAxisDir.y;
            let next = startValue + screenDelta * valuePerPixel;
            if (handle.min !== undefined) next = Math.max(handle.min, next);
            if (handle.max !== undefined) next = Math.min(handle.max, next);
            handle.setValue(next);
        };
        const onMouseUp = (): void => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            this.dragging = false;
            this.history.endAction(historyLabel);
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    }
}
