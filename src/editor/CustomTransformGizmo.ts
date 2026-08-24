import * as THREE from 'three';

// A from-scratch replacement for three.js's TransformControls, used everywhere in this
// project a draggable move/rotate widget is needed (GizmoManager, MeshInstanceSelector,
// MeshCalibrationPanel). Mirrors just the slice of TransformControls' API those three
// call sites actually use - attach/detach, setMode, showX/showY/showZ, getHelper(), the
// dragging getter, and the change/mouseDown/mouseUp/dragging-changed/objectChange events -
// so it's a drop-in swap rather than a rewrite of each call site's own logic.
//
// Translate: dragging an axis arrow projects that world-space axis into screen space
// (calibrated once at drag start, the same technique BuildingHandleManager uses for
// building resize handles) and converts 2D mouse movement into a 1D move along that axis.
// Rotate: dragging an axis ring intersects the mouse ray with the plane through the
// target's position perpendicular to that axis, and uses the swept angle of that
// intersection point (relative to the drag start) as the rotation delta.

export type GizmoEventType = 'change' | 'mouseDown' | 'mouseUp' | 'dragging-changed' | 'objectChange';
export interface GizmoEvent { type: GizmoEventType; value?: boolean }
export type GizmoListener = (event: GizmoEvent) => void;

type Mode = 'translate' | 'rotate';
type Axis = 'x' | 'y' | 'z';

// The gizmo's own 'y'/'z' letters (labels, keyboard shortcuts, colors) are swapped relative
// to three.js's actual Y-up world axes - 'z' is wired to the real vertical (Three.js Y) and
// 'y' to the real horizontal (Three.js Z), matching Blender's Z-up convention that users
// expect from G+Z / the blue handle. This is purely a gizmo-side relabeling: the rest of the
// engine is untouched and still genuinely Y-up.
const AXIS_VECTORS: Record<Axis, THREE.Vector3> = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 0, 1),
    z: new THREE.Vector3(0, 1, 0),
};
const AXIS_COLORS: Record<Axis, number> = { x: 0xe0483f, y: 0x4caf50, z: 0x3d7fd6 };

// A plane handle is colored as a blend of the two axis colors it combines (e.g. the XZ
// handle reads as red+blue), the same convention most 3D editors use so it's visually
// obvious which two arrows a given square corresponds to.
function blendColors(a: number, b: number): number {
    const ca = new THREE.Color(a);
    const cb = new THREE.Color(b);
    return ca.lerp(cb, 0.5).getHex();
}

type PlaneKey = 'xz' | 'xy' | 'yz';
// Each plane's normal is the excluded axis's own vector, sourced from AXIS_VECTORS so the
// y/z relabeling above stays consistent here automatically instead of needing a second
// hardcoded copy of the swap.
const PLANE_DEFS: Record<PlaneKey, { axes: [Axis, Axis]; normal: THREE.Vector3 }> = {
    xz: { axes: ['x', 'z'], normal: AXIS_VECTORS.y },
    xy: { axes: ['x', 'y'], normal: AXIS_VECTORS.z },
    yz: { axes: ['y', 'z'], normal: AXIS_VECTORS.x },
};

// Blender's "G then Shift+<axis>" excludes that axis, constraining the drag to the plane
// spanned by the other two - which is exactly the plane whose normal equals the excluded
// axis, so this just reuses PLANE_DEFS' own naming.
const EXCLUDE_TO_PLANE: Record<Axis, PlaneKey> = { x: 'yz', y: 'xz', z: 'xy' };

type ModalConstraint = { kind: 'axis'; axis: Axis } | { kind: 'plane'; exclude: Axis } | null;

interface ModalState {
    startPos: THREE.Vector3;
    startMouseX: number;
    startMouseY: number;
    constraint: ModalConstraint;
    axisDir?: THREE.Vector3;
    screenAxisDir?: THREE.Vector2;
    worldUnitsPerPixel?: number;
    plane?: THREE.Plane;
    startHit?: THREE.Vector3;
    guide: THREE.Group | null;
}

export default class CustomTransformGizmo {
    private _camera: THREE.Camera;
    public enabled = true;

    // A plain field wouldn't notice when a host reassigns it (every host does
    // `gizmo.camera = camera.instance` on Camera.onChanged, i.e. on every camera move) - the
    // setter re-runs updateScale(), which is what keeps the plane handles facing the camera
    // continuously as the user orbits, not just when the gizmo is next attached/dragged.
    public get camera(): THREE.Camera { return this._camera; }
    public set camera(value: THREE.Camera) { this._camera = value; this.updateScale(); }

    private readonly group = new THREE.Group();
    private mode: Mode = 'translate';
    private target: THREE.Object3D | null = null;
    private size = 1;
    private readonly translateHandles: Record<Axis, THREE.Object3D>;
    private readonly rotateHandles: Record<Axis, THREE.Object3D>;
    private readonly planeHandles: Record<PlaneKey, THREE.Object3D>;
    private readonly raycaster = new THREE.Raycaster();
    private _dragging = false;
    private readonly listeners = new Map<GizmoEventType, Set<GizmoListener>>();
    private _showX = true;
    private _showY = true;
    private _showZ = true;
    private lastMouseX = 0;
    private lastMouseY = 0;
    private hoveredHandle: THREE.Object3D | null = null;
    private modal: ModalState | null = null;

    public get showX(): boolean { return this._showX; }
    public set showX(value: boolean) { this._showX = value; this.updateVisibility(); }
    public get showY(): boolean { return this._showY; }
    public set showY(value: boolean) { this._showY = value; this.updateVisibility(); }
    public get showZ(): boolean { return this._showZ; }
    public set showZ(value: boolean) { this._showZ = value; this.updateVisibility(); }

    // domElement kept in the constructor signature to match TransformControls' own
    // signature at every call site (a drop-in swap) - no longer used internally now that
    // drag-start is an explicit tryStartDrag(e) call from the host instead of this widget's
    // own DOM listener (see tryStartDrag's note on why).
    constructor(camera: THREE.Camera, _domElement: HTMLElement) {
        // Assigns the backing field directly, not through the public setter - the setter
        // calls updateScale(), which touches translateHandles/planeHandles, and those aren't
        // built yet this early in the constructor.
        this._camera = camera;
        this.group.visible = false;
        this.raycaster.params.Line = { threshold: 0.12 };

        this.translateHandles = {
            x: this.buildArrow('x'),
            y: this.buildArrow('y'),
            z: this.buildArrow('z'),
        };
        this.rotateHandles = {
            x: this.buildRing('x'),
            y: this.buildRing('y'),
            z: this.buildRing('z'),
        };
        this.planeHandles = {
            xz: this.buildPlaneHandle('xz'),
            xy: this.buildPlaneHandle('xy'),
            yz: this.buildPlaneHandle('yz'),
        };
        for (const axis of ['x', 'y', 'z'] as Axis[]) {
            this.group.add(this.translateHandles[axis]);
            this.group.add(this.rotateHandles[axis]);
        }
        for (const key of ['xz', 'xy', 'yz'] as PlaneKey[]) {
            this.group.add(this.planeHandles[key]);
        }
        // Tagged so other tools' own raycasts can exclude this widget's meshes the same way
        // they used to filter out TransformControls' own "TransformControlsRoot" etc. object
        // types - otherwise a click on the gizmo while a different tool is active would hit
        // whatever's behind it instead of being safely ignored.
        this.group.traverse((obj) => { obj.userData.isGizmoWidget = true; });
        this.updateVisibility();

        // Window-level, matching every drag handler below (they already read
        // window.innerWidth/innerHeight and use window mousemove/mouseup rather than
        // anything scoped to _domElement) - hover highlighting and the G-grab modal follow
        // the same already-established convention rather than introducing a new one.
        window.addEventListener('mousemove', this.onGlobalMouseMove);
        window.addEventListener('keydown', this.onKeyDown);
    }

    // --- public API (matches the slice of TransformControls used elsewhere) --------

    public getHelper(): THREE.Object3D {
        return this.group;
    }

    public get dragging(): boolean {
        return this._dragging;
    }

    public setMode(mode: Mode): void {
        this.mode = mode;
        this.updateVisibility();
    }

    public setSize(size: number): void {
        this.size = size;
        this.updateScale();
    }

    public setSpace(_space: 'world' | 'local'): void {
        // World space only - every call site in this project already only ever used
        // TransformControls in world space.
    }

    public attach(object: THREE.Object3D): void {
        this.target = object;
        this.group.visible = true;
        this.syncToTarget();
    }

    public detach(): void {
        this.target = null;
        this.group.visible = false;
    }

    public addEventListener(type: GizmoEventType, listener: GizmoListener): void {
        let set = this.listeners.get(type);
        if (!set) { set = new Set(); this.listeners.set(type, set); }
        set.add(listener);
    }

    public removeEventListener(type: GizmoEventType, listener: GizmoListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    public dispose(): void {
        window.removeEventListener('mousemove', this.onGlobalMouseMove);
        window.removeEventListener('keydown', this.onKeyDown);
    }

    // Called explicitly by the host (SelectionManager, or wherever else this gizmo is used)
    // BEFORE its own click/selection logic, exactly like BuildingHandleManager.tryStartDrag -
    // deliberately not a DOM event listener of its own. An earlier version attached its own
    // 'pointerdown' listener directly to the canvas hoping to win the race against
    // SelectionManager's window-level capture-phase 'mousedown' listener (pointerdown fires
    // first, and calling preventDefault() on it should suppress the synthesized mousedown).
    // In practice that produced a worse bug: dragging silently did nothing while held, and
    // released objects kept following the mouse afterward - some part of that event-timing
    // trick left the mousemove/mouseup listeners never cleaned up. Explicit, synchronous
    // delegation avoids relying on any browser-specific event-ordering behavior at all.
    public tryStartDrag(e: MouseEvent): boolean {
        if (!this.enabled || !this.target) return false;

        // A left-click while a G-grab modal move is active confirms it (Blender's own
        // behavior) rather than being treated as a normal selection/handle click.
        if (this.modal) {
            if (e.button === 0) {
                e.preventDefault();
                this.confirmModal();
            }
            return true;
        }

        if (e.button !== 0) return false;
        const hit = this.raycastHandles(e.clientX, e.clientY);
        if (!hit) return false;
        e.preventDefault();

        if (hit.kind === 'translate') this.startTranslateDrag(e, hit.axis);
        else if (hit.kind === 'rotate') this.startRotateDrag(e, hit.axis);
        else this.startPlaneDrag(e, hit.plane);
        return true;
    }

    // Called whenever the attached target's transform is changed by something other than
    // this widget's own drag (e.g. GizmoManager repositioning its helper on selection
    // change) - keeps the visual gizmo following along.
    public update(): void {
        this.syncToTarget();
    }

    // --- internal ------------------------------------------------------------------

    private dispatch(type: GizmoEventType, extra?: Partial<GizmoEvent>): void {
        const set = this.listeners.get(type);
        if (!set) return;
        const event: GizmoEvent = { type, ...extra };
        for (const listener of set) listener(event);
    }

    private updateVisibility(): void {
        const shownOf = (axis: Axis): boolean => (axis === 'x' ? this.showX : axis === 'y' ? this.showY : this.showZ);
        for (const axis of ['x', 'y', 'z'] as Axis[]) {
            this.translateHandles[axis].visible = this.mode === 'translate' && shownOf(axis);
            this.rotateHandles[axis].visible = this.mode === 'rotate' && shownOf(axis);
        }
        for (const key of ['xz', 'xy', 'yz'] as PlaneKey[]) {
            const [a, b] = PLANE_DEFS[key].axes;
            this.planeHandles[key].visible = this.mode === 'translate' && shownOf(a) && shownOf(b);
        }
    }

    private syncToTarget(): void {
        if (!this.target) return;
        const pos = new THREE.Vector3();
        this.target.getWorldPosition(pos);
        this.group.position.copy(pos);
        this.updateScale();
    }

    // Keeps the gizmo a roughly constant size on screen regardless of distance from the
    // camera - a perspective camera's own foreshortening otherwise makes it shrink to
    // nothing far away and swamp the view up close.
    private updateScale(): void {
        const distance = this.camera.position.distanceTo(this.group.position);
        const scale = Math.max(0.2, distance * 0.15) * this.size;
        this.group.scale.setScalar(scale);
        this.updatePlaneFacing();
        this.updateArrowFacing();
    }

    // Same reasoning as updatePlaneFacing() below, applied to the translate arrows: an
    // arrow fixed to always point toward +axis ends up pointing away from the camera (and
    // into/behind the target) for roughly half of all orbit angles, making it awkward to
    // grab. Flipping each arrow to point toward whichever side of the target the camera is
    // actually on is purely cosmetic - the underlying AXIS_VECTORS direction used for the
    // drag math itself never changes, only which way the arrow mesh is drawn.
    private updateArrowFacing(): void {
        const camLocal = this.group.worldToLocal(this.camera.position.clone());
        const up = new THREE.Vector3(0, 1, 0);
        for (const axis of ['x', 'y', 'z'] as Axis[]) {
            // Dot against the actual AXIS_VECTORS direction, not a raw camLocal.x/y/z
            // lookup keyed by the letter - the gizmo's 'y'/'z' letters are swapped relative
            // to their real Three.js axes (see AXIS_VECTORS' own comment), so indexing by
            // letter would silently read the wrong world component.
            const sign = camLocal.dot(AXIS_VECTORS[axis]) >= 0 ? 1 : -1;
            const dir = AXIS_VECTORS[axis].clone().multiplyScalar(sign);
            this.translateHandles[axis].quaternion.setFromUnitVectors(up, dir);
        }
    }

    // A plane handle offset toward a fixed corner (always +axisA,+axisB) would end up
    // pointing away from the camera - and therefore hidden behind the gizmo's own other
    // handles, or behind the target itself - for roughly half of all viewing angles. Instead
    // each handle is offset toward whichever side of the target the camera is actually on,
    // for both of its axes independently, so it stays reachable regardless of orbit angle.
    // Runs on every camera reassignment (see the camera setter) as well as on attach/drag, so
    // it tracks the camera continuously rather than only updating on the next interaction.
    private updatePlaneFacing(): void {
        const camLocal = this.group.worldToLocal(this.camera.position.clone());
        for (const key of ['xz', 'xy', 'yz'] as PlaneKey[]) {
            const [a, b] = PLANE_DEFS[key].axes;
            // Dot against AXIS_VECTORS rather than indexing camLocal.x/y/z by letter - see
            // the matching note in updateArrowFacing() on why the raw property lookup is
            // wrong once 'y'/'z' are relabeled relative to their real Three.js axes.
            const signA = camLocal.dot(AXIS_VECTORS[a]) >= 0 ? 0.32 : -0.32;
            const signB = camLocal.dot(AXIS_VECTORS[b]) >= 0 ? 0.32 : -0.32;
            const offset = new THREE.Vector3()
                .addScaledVector(AXIS_VECTORS[a], signA)
                .addScaledVector(AXIS_VECTORS[b], signB);
            this.planeHandles[key].position.copy(offset);
        }
    }

    private buildArrow(axis: Axis): THREE.Object3D {
        const group = new THREE.Group();
        const color = AXIS_COLORS[axis];
        const material = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.8, 8), material);
        shaft.position.y = 0.4;
        const head = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.18, 10), material);
        head.position.y = 0.89;
        group.add(shaft, head);
        // Cylinders/cones default to +Y - rotate onto the requested axis.
        group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), AXIS_VECTORS[axis]);
        group.renderOrder = 999;
        group.userData.gizmoAxis = axis;
        group.userData.gizmoKind = 'translate';
        group.traverse((obj) => { obj.userData.gizmoAxis = axis; obj.userData.gizmoKind = 'translate'; });
        return group;
    }

    private buildRing(axis: Axis): THREE.Object3D {
        const color = AXIS_COLORS[axis];
        const material = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.02, 8, 48), material);
        // A torus is built in the XY plane by default (ring normal = +Z) - align its
        // normal to the rotation axis so the ring sweeps the plane perpendicular to it.
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), AXIS_VECTORS[axis]);
        mesh.renderOrder = 999;
        mesh.userData.gizmoAxis = axis;
        mesh.userData.gizmoKind = 'rotate';
        return mesh;
    }

    private buildPlaneHandle(key: PlaneKey): THREE.Object3D {
        const { axes, normal } = PLANE_DEFS[key];
        const [a, b] = axes;
        const color = blendColors(AXIS_COLORS[a], AXIS_COLORS[b]);
        const material = new THREE.MeshBasicMaterial({
            color, depthTest: false, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.28), material);
        // A plane's own axes are its local X/Y before any rotation - align those to the two
        // world axes this handle spans. Its actual offset (toward whichever side of the
        // target the camera is on) is set continuously by updatePlaneFacing() instead of a
        // fixed corner here.
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        // Higher than the arrows'/rings' own 999, so a plane handle draws on top of them
        // where they overlap instead of being hidden underneath.
        mesh.renderOrder = 1000;
        mesh.userData.gizmoPlane = key;
        return mesh;
    }

    private pickHandle(clientX: number, clientY: number): THREE.Object3D | null {
        const mouse = new THREE.Vector2(
            (clientX / window.innerWidth) * 2 - 1,
            -(clientY / window.innerHeight) * 2 + 1,
        );
        this.raycaster.setFromCamera(mouse, this.camera);
        const activeHandles = this.mode === 'translate'
            ? [...Object.values(this.translateHandles), ...Object.values(this.planeHandles)]
            : Object.values(this.rotateHandles);
        const hits = this.raycaster.intersectObjects(activeHandles.filter((obj) => obj.visible), true);
        if (hits.length === 0) return null;
        let obj: THREE.Object3D | null = hits[0].object;
        while (obj && !obj.userData.gizmoAxis && !obj.userData.gizmoPlane) obj = obj.parent;
        return obj;
    }

    private raycastHandles(clientX: number, clientY: number):
        | { kind: 'translate'; axis: Axis }
        | { kind: 'rotate'; axis: Axis }
        | { kind: 'plane'; plane: PlaneKey }
        | null {
        const obj = this.pickHandle(clientX, clientY);
        if (!obj) return null;
        if (obj.userData.gizmoPlane) return { kind: 'plane', plane: obj.userData.gizmoPlane as PlaneKey };
        return { axis: obj.userData.gizmoAxis as Axis, kind: obj.userData.gizmoKind as 'translate' | 'rotate' };
    }

    // Every handle (arrow group, ring, plane square) uses one shared MeshBasicMaterial
    // across its own mesh children, so brightening it is a single color swap rather than
    // needing per-vertex/per-mesh tinting.
    private getHandleMaterials(obj: THREE.Object3D): THREE.MeshBasicMaterial[] {
        const materials = new Set<THREE.MeshBasicMaterial>();
        obj.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if ((mesh as THREE.Mesh).isMesh && mesh.material) materials.add(mesh.material as THREE.MeshBasicMaterial);
        });
        return [...materials];
    }

    private setHover(obj: THREE.Object3D | null): void {
        if (this.hoveredHandle === obj) return;
        if (this.hoveredHandle) {
            for (const material of this.getHandleMaterials(this.hoveredHandle)) {
                const base = material.userData.baseColor as number | undefined;
                if (base !== undefined) material.color.setHex(base);
            }
        }
        this.hoveredHandle = obj;
        if (obj) {
            for (const material of this.getHandleMaterials(obj)) {
                if (material.userData.baseColor === undefined) material.userData.baseColor = material.color.getHex();
                material.color.copy(new THREE.Color(material.userData.baseColor as number).lerp(new THREE.Color(0xffffff), 0.6));
            }
        }
    }

    private onGlobalMouseMove = (e: MouseEvent): void => {
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        if (this.modal) {
            this.updateModalPosition(e.clientX, e.clientY);
            return;
        }
        if (this._dragging || !this.enabled || !this.target || !this.group.visible) {
            this.setHover(null);
            return;
        }
        this.setHover(this.pickHandle(e.clientX, e.clientY));
    };

    private worldToScreen(worldPos: THREE.Vector3): THREE.Vector2 {
        const projected = worldPos.clone().project(this.camera);
        return new THREE.Vector2(
            (projected.x + 1) * 0.5 * window.innerWidth,
            (1 - projected.y) * 0.5 * window.innerHeight,
        );
    }

    private beginDrag(): void {
        this._dragging = true;
        this.dispatch('mouseDown');
        this.dispatch('dragging-changed', { value: true });
    }

    private endDrag(): void {
        this._dragging = false;
        this.dispatch('mouseUp');
        this.dispatch('dragging-changed', { value: false });
    }

    private startTranslateDrag(e: MouseEvent, axis: Axis): void {
        if (!this.target) return;
        const startMouseX = e.clientX;
        const startMouseY = e.clientY;
        const startPos = new THREE.Vector3();
        this.target.getWorldPosition(startPos);
        const axisDir = AXIS_VECTORS[axis];

        const screenP0 = this.worldToScreen(startPos);
        const screenP1 = this.worldToScreen(startPos.clone().add(axisDir));
        const screenAxis = screenP1.clone().sub(screenP0);
        const screenAxisLenSq = screenAxis.lengthSq();
        if (screenAxisLenSq < 1e-6) return;
        const screenAxisDir = screenAxis.clone().normalize();
        const worldUnitsPerPixel = 1 / Math.sqrt(screenAxisLenSq);

        this.beginDrag();

        const onMove = (moveEvent: MouseEvent): void => {
            if (!this.target) return;
            const dx = moveEvent.clientX - startMouseX;
            const dy = moveEvent.clientY - startMouseY;
            const screenDelta = dx * screenAxisDir.x + dy * screenAxisDir.y;
            const worldDelta = screenDelta * worldUnitsPerPixel;
            const nextWorld = startPos.clone().addScaledVector(axisDir, worldDelta);
            if (this.target.parent) {
                this.target.position.copy(this.target.parent.worldToLocal(nextWorld));
            } else {
                this.target.position.copy(nextWorld);
            }
            this.syncToTarget();
            this.dispatch('change');
            this.dispatch('objectChange');
        };
        const onUp = (): void => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            this.endDrag();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    // Plane dragging (both axes at once, e.g. XZ for ground-plane movement) doesn't need
    // the screen-space axis projection translate/rotate use - the mouse ray can intersect
    // the actual 3D plane directly, and the delta between the current and drag-start
    // intersection points is already confined to that plane.
    private intersectPlaneAt(plane: THREE.Plane, clientX: number, clientY: number): THREE.Vector3 | null {
        const mouse = new THREE.Vector2(
            (clientX / window.innerWidth) * 2 - 1,
            -(clientY / window.innerHeight) * 2 + 1,
        );
        this.raycaster.setFromCamera(mouse, this.camera);
        const hit = new THREE.Vector3();
        return this.raycaster.ray.intersectPlane(plane, hit) ? hit : null;
    }

    private startPlaneDrag(e: MouseEvent, planeKey: PlaneKey): void {
        if (!this.target) return;
        const startPos = new THREE.Vector3();
        this.target.getWorldPosition(startPos);
        const normal = PLANE_DEFS[planeKey].normal;
        const plane = new THREE.Plane(normal.clone(), -normal.dot(startPos));
        const intersectAt = (clientX: number, clientY: number): THREE.Vector3 | null => this.intersectPlaneAt(plane, clientX, clientY);

        const startHit = intersectAt(e.clientX, e.clientY);
        if (!startHit) return;

        this.beginDrag();

        const onMove = (moveEvent: MouseEvent): void => {
            if (!this.target) return;
            const hit = intersectAt(moveEvent.clientX, moveEvent.clientY);
            if (!hit) return;
            const nextWorld = startPos.clone().add(hit.clone().sub(startHit));
            if (this.target.parent) {
                this.target.position.copy(this.target.parent.worldToLocal(nextWorld));
            } else {
                this.target.position.copy(nextWorld);
            }
            this.syncToTarget();
            this.dispatch('change');
            this.dispatch('objectChange');
        };
        const onUp = (): void => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            this.endDrag();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    private startRotateDrag(e: MouseEvent, axis: Axis): void {
        if (!this.target) return;
        const axisDir = AXIS_VECTORS[axis];
        const center = new THREE.Vector3();
        this.target.getWorldPosition(center);
        const plane = new THREE.Plane(axisDir.clone(), -axisDir.dot(center));

        // An orthonormal (u, v) basis spanning the rotation plane, so a point on it can be
        // reduced to a single angle via atan2(v, u).
        const u = new THREE.Vector3(0, 1, 0).cross(axisDir);
        if (u.lengthSq() < 1e-6) u.set(1, 0, 0).cross(axisDir);
        u.normalize();
        const v = axisDir.clone().cross(u).normalize();

        const angleAt = (clientX: number, clientY: number): number | null => {
            const mouse = new THREE.Vector2(
                (clientX / window.innerWidth) * 2 - 1,
                -(clientY / window.innerHeight) * 2 + 1,
            );
            this.raycaster.setFromCamera(mouse, this.camera);
            const hit = new THREE.Vector3();
            if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
            const rel = hit.sub(center);
            return Math.atan2(rel.dot(v), rel.dot(u));
        };

        const startAngle = angleAt(e.clientX, e.clientY);
        if (startAngle === null) return;
        const startQuaternion = this.target.quaternion.clone();
        // World-space rotation on a possibly-parented target - captured once so each move
        // event applies the *total* rotation since drag start, not an accumulated one.
        const startParentQuaternion = this.target.parent
            ? this.target.parent.getWorldQuaternion(new THREE.Quaternion())
            : new THREE.Quaternion();

        this.beginDrag();

        const onMove = (moveEvent: MouseEvent): void => {
            if (!this.target) return;
            const angle = angleAt(moveEvent.clientX, moveEvent.clientY);
            if (angle === null) return;
            const delta = angle - startAngle;
            const deltaQuat = new THREE.Quaternion().setFromAxisAngle(axisDir, delta);
            // world quaternion = deltaQuat * startWorldQuaternion; convert back to local by
            // removing the parent's world rotation.
            const startWorldQuaternion = startParentQuaternion.clone().multiply(startQuaternion);
            const nextWorldQuaternion = deltaQuat.clone().multiply(startWorldQuaternion);
            const nextLocalQuaternion = startParentQuaternion.clone().invert().multiply(nextWorldQuaternion);
            this.target.quaternion.copy(nextLocalQuaternion);
            this.syncToTarget();
            this.dispatch('change');
            this.dispatch('objectChange');
        };
        const onUp = (): void => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            this.endDrag();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    // --- Blender-style "G" grab: press G to start a free move that follows the mouse with
    // no button held, X/Y/Z to constrain it to that axis, Shift+X/Y/Z to constrain it to the
    // plane excluding that axis, left-click or Enter to confirm, Escape to cancel and revert.
    // -----------------------------------------------------------------------------------

    private onKeyDown = (e: KeyboardEvent): void => {
        const tagName = (e.target as HTMLElement | null)?.tagName;
        if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') return;
        if (e.repeat) return;

        if (this.modal) {
            const key = e.key.toLowerCase();
            if (key === 'escape') { e.preventDefault(); this.cancelModal(); return; }
            if (key === 'enter') { e.preventDefault(); this.confirmModal(); return; }
            if (key === 'x' || key === 'y' || key === 'z') {
                e.preventDefault();
                const axis = key as Axis;
                this.setModalConstraint(e.shiftKey ? { kind: 'plane', exclude: axis } : { kind: 'axis', axis });
            }
            return;
        }

        if (e.key.toLowerCase() === 'g' && this.enabled && this.target && this.group.visible && !this._dragging) {
            e.preventDefault();
            this.startModalMove();
        }
    };

    private startModalMove(): void {
        if (!this.target) return;
        const startPos = new THREE.Vector3();
        this.target.getWorldPosition(startPos);
        this.modal = {
            startPos,
            startMouseX: this.lastMouseX,
            startMouseY: this.lastMouseY,
            constraint: null,
            guide: null,
        };
        this.beginDrag();
        this.setModalConstraint(null);
    }

    private setModalConstraint(constraint: ModalConstraint): void {
        if (!this.modal) return;
        this.modal.constraint = constraint;
        this.clearModalGuide();

        const { startPos, startMouseX, startMouseY } = this.modal;

        if (constraint === null) {
            // Free move: drag across the plane facing the camera, through the target's
            // start position - the closest analogue to Blender's own view-plane grab
            // without needing the camera's exact forward vector.
            const normal = this.camera.position.clone().sub(startPos);
            if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1); else normal.normalize();
            const plane = new THREE.Plane(normal, -normal.dot(startPos));
            this.modal.plane = plane;
            this.modal.axisDir = undefined;
            this.modal.startHit = this.intersectPlaneAt(plane, startMouseX, startMouseY) ?? startPos.clone();
        } else if (constraint.kind === 'axis') {
            const axisDir = AXIS_VECTORS[constraint.axis];
            const screenP0 = this.worldToScreen(startPos);
            const screenP1 = this.worldToScreen(startPos.clone().add(axisDir));
            const screenAxis = screenP1.clone().sub(screenP0);
            const lenSq = screenAxis.lengthSq();
            this.modal.axisDir = axisDir;
            this.modal.screenAxisDir = lenSq > 1e-6 ? screenAxis.clone().normalize() : new THREE.Vector2(1, 0);
            this.modal.worldUnitsPerPixel = lenSq > 1e-6 ? 1 / Math.sqrt(lenSq) : 0;
            this.modal.plane = undefined;
            this.buildAxisGuide(constraint.axis, startPos);
        } else {
            const planeKey = EXCLUDE_TO_PLANE[constraint.exclude];
            const normal = PLANE_DEFS[planeKey].normal;
            const plane = new THREE.Plane(normal.clone(), -normal.dot(startPos));
            this.modal.plane = plane;
            this.modal.axisDir = undefined;
            this.modal.startHit = this.intersectPlaneAt(plane, startMouseX, startMouseY) ?? startPos.clone();
            this.buildPlaneGuide(planeKey, startPos);
        }

        this.updateModalPosition(this.lastMouseX, this.lastMouseY);
    }

    private updateModalPosition(clientX: number, clientY: number): void {
        if (!this.modal || !this.target) return;
        const { startPos, constraint } = this.modal;
        let nextWorld: THREE.Vector3 | null = null;

        if (constraint && constraint.kind === 'axis') {
            const dx = clientX - this.modal.startMouseX;
            const dy = clientY - this.modal.startMouseY;
            const screenDelta = dx * this.modal.screenAxisDir!.x + dy * this.modal.screenAxisDir!.y;
            const worldDelta = screenDelta * (this.modal.worldUnitsPerPixel ?? 0);
            nextWorld = startPos.clone().addScaledVector(this.modal.axisDir!, worldDelta);
        } else if (this.modal.plane) {
            const hit = this.intersectPlaneAt(this.modal.plane, clientX, clientY);
            if (hit) nextWorld = startPos.clone().add(hit.clone().sub(this.modal.startHit!));
        }
        if (!nextWorld) return;

        if (this.target.parent) {
            this.target.position.copy(this.target.parent.worldToLocal(nextWorld));
        } else {
            this.target.position.copy(nextWorld);
        }
        this.syncToTarget();
        this.dispatch('change');
        this.dispatch('objectChange');
    }

    private confirmModal(): void {
        if (!this.modal) return;
        this.clearModalGuide();
        this.modal = null;
        this.endDrag();
    }

    private cancelModal(): void {
        if (!this.modal || !this.target) return;
        const { startPos } = this.modal;
        if (this.target.parent) {
            this.target.position.copy(this.target.parent.worldToLocal(startPos));
        } else {
            this.target.position.copy(startPos);
        }
        this.syncToTarget();
        this.dispatch('change');
        this.dispatch('objectChange');
        this.clearModalGuide();
        this.modal = null;
        this.endDrag();
    }

    private buildAxisGuide(axis: Axis, center: THREE.Vector3): void {
        if (!this.modal) return;
        const guide = new THREE.Group();
        guide.userData.isGizmoWidget = true;
        guide.add(this.buildDashedLine(center, AXIS_VECTORS[axis], AXIS_COLORS[axis]));
        this.modal.guide = guide;
        this.group.parent?.add(guide);
    }

    private buildPlaneGuide(planeKey: PlaneKey, center: THREE.Vector3): void {
        if (!this.modal) return;
        const guide = new THREE.Group();
        guide.userData.isGizmoWidget = true;
        for (const axis of PLANE_DEFS[planeKey].axes) {
            guide.add(this.buildDashedLine(center, AXIS_VECTORS[axis], AXIS_COLORS[axis]));
        }
        this.modal.guide = guide;
        this.group.parent?.add(guide);
    }

    private buildDashedLine(center: THREE.Vector3, dir: THREE.Vector3, color: number): THREE.Line {
        const length = Math.max(20, this.group.scale.x * 30);
        const dashSize = Math.max(0.05, this.group.scale.x * 0.12);
        const geometry = new THREE.BufferGeometry().setFromPoints([
            center.clone().addScaledVector(dir, -length),
            center.clone().addScaledVector(dir, length),
        ]);
        const material = new THREE.LineDashedMaterial({
            color, dashSize, gapSize: dashSize * 0.7, transparent: true, opacity: 0.6, depthTest: false,
        });
        const line = new THREE.Line(geometry, material);
        line.computeLineDistances();
        line.renderOrder = 998;
        line.userData.isGizmoWidget = true;
        return line;
    }

    private clearModalGuide(): void {
        if (!this.modal?.guide) return;
        const guide = this.modal.guide;
        guide.parent?.remove(guide);
        guide.traverse((obj) => {
            const line = obj as THREE.Line;
            line.geometry?.dispose();
            (line.material as THREE.Material | undefined)?.dispose();
        });
        this.modal.guide = null;
    }
}
