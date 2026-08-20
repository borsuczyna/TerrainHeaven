import * as THREE from 'three';
import { singleton } from 'tsyringe';
import type GizmoManager from './GizmoManager';

export type ViewName = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';
export type ProjectionMode = 'perspective' | 'orthographic';

@singleton()
export default class Camera {
    private readonly perspective: THREE.PerspectiveCamera;
    private readonly orthographic: THREE.OrthographicCamera;
    private activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    private gizmo: GizmoManager | null = null;
    private readonly keys = new Set<string>();
    private readonly target = new THREE.Vector3();
    private readonly listeners = new Set<() => void>();
    private moveSpeed = 5;
    private lookSpeed = 0.002;
    private pitch = -0.2;
    private yaw = -Math.PI / 2;
    private distance = 10;
    private dragMode: 'look' | 'orbit' | 'pan' | null = null;

    constructor() {
        const aspect = window.innerWidth / window.innerHeight;
        this.perspective = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000);
        this.orthographic = new THREE.OrthographicCamera(-10 * aspect, 10 * aspect, 10, -10, 0.1, 1000);
        this.activeCamera = this.perspective;
        this.perspective.position.set(0, 5, 0);
        this.updateRotation();
        this.syncTargetFromView();
        this.syncInactiveCamera();
        this.bindEvents();
    }

    public get instance(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
        return this.activeCamera;
    }

    public get projectionMode(): ProjectionMode {
        return this.activeCamera === this.orthographic ? 'orthographic' : 'perspective';
    }

    public onChanged(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emitChanged(): void {
        for (const listener of this.listeners) listener();
    }

    private bindEvents(): void {
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mousedown', this.onMouseDown);
        window.addEventListener('mouseup', this.onMouseUp);
        window.addEventListener('wheel', this.onWheel, { passive: false });
        window.addEventListener('contextmenu', this.onContextMenu);
        window.addEventListener('resize', this.onResize);
    }

    private onKeyDown = (e: KeyboardEvent): void => {
        this.keys.add(e.code);
        if (e.code === 'Numpad5' && !e.repeat) {
            this.toggleProjection();
            e.preventDefault();
        }
    };

    private onKeyUp = (e: KeyboardEvent): void => {
        this.keys.delete(e.code);
    };

    private onMouseDown = (e: MouseEvent): void => {
        if ((e.target as HTMLElement).tagName !== 'CANVAS') return;
        if (this.gizmo?.isDragging) return;
        if (e.button === 1) this.dragMode = e.shiftKey ? 'pan' : 'orbit';
        else if (e.button === 2) this.dragMode = 'look';
        else return;
        e.preventDefault();
    };

    public setGizmoManager(gizmo: GizmoManager): void {
        this.gizmo = gizmo;
    }

    private onMouseUp = (e: MouseEvent): void => {
        if ((e.button === 1 && this.dragMode !== 'look') || (e.button === 2 && this.dragMode === 'look')) {
            this.dragMode = null;
        }
    };

    private onContextMenu = (e: MouseEvent): void => {
        if ((e.target as HTMLElement).tagName === 'CANVAS') e.preventDefault();
    };

    private onMouseMove = (e: MouseEvent): void => {
        if (!this.dragMode) return;

        if (this.dragMode === 'pan') {
            const height = Math.max(1, window.innerHeight);
            const visibleHeight = this.projectionMode === 'orthographic'
                ? (this.orthographic.top - this.orthographic.bottom) / this.orthographic.zoom
                : 2 * this.distance * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
            const scale = visibleHeight / height;
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.activeCamera.quaternion);
            const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.activeCamera.quaternion);
            const offset = right.multiplyScalar(-e.movementX * scale).add(up.multiplyScalar(e.movementY * scale));
            this.activeCamera.position.add(offset);
            this.target.add(offset);
            this.syncInactiveCamera();
            this.emitChanged();
            return;
        }

        this.yaw -= e.movementX * this.lookSpeed;
        this.pitch -= e.movementY * this.lookSpeed;
        const maxPitch = Math.PI / 2 - 0.01;
        this.pitch = THREE.MathUtils.clamp(this.pitch, -maxPitch, maxPitch);
        this.updateRotation();
        if (this.dragMode === 'orbit') this.updateOrbitPosition();
        else this.syncTargetFromView();
        this.syncInactiveCamera();
        this.emitChanged();
    };

    private onWheel = (e: WheelEvent): void => {
        if ((e.target as HTMLElement).tagName !== 'CANVAS') return;
        e.preventDefault();
        const factor = Math.exp(e.deltaY * 0.0012);
        if (this.projectionMode === 'orthographic') {
            this.orthographic.zoom = THREE.MathUtils.clamp(this.orthographic.zoom / factor, 0.05, 100);
            this.orthographic.updateProjectionMatrix();
        } else {
            this.distance = THREE.MathUtils.clamp(this.distance * factor, 0.25, 800);
            this.updateOrbitPosition();
        }
        this.syncInactiveCamera();
        this.emitChanged();
    };

    private onResize = (): void => this.resize();

    private updateRotation(): void {
        this.activeCamera.rotation.order = 'YXZ';
        this.activeCamera.rotation.y = this.yaw;
        this.activeCamera.rotation.x = this.pitch;
    }

    private syncTargetFromView(): void {
        const forward = new THREE.Vector3();
        this.activeCamera.getWorldDirection(forward);
        this.target.copy(this.activeCamera.position).addScaledVector(forward, this.distance);
    }

    private updateOrbitPosition(): void {
        const forward = new THREE.Vector3();
        this.activeCamera.getWorldDirection(forward);
        this.activeCamera.position.copy(this.target).addScaledVector(forward, -this.distance);
    }

    private syncInactiveCamera(): void {
        const inactive = this.activeCamera === this.perspective ? this.orthographic : this.perspective;
        inactive.position.copy(this.activeCamera.position);
        inactive.quaternion.copy(this.activeCamera.quaternion);
        inactive.updateMatrixWorld();
    }

    public setView(view: ViewName): void {
        const maxPitch = Math.PI / 2 - 0.001;
        switch (view) {
            case 'top': this.pitch = -maxPitch; this.yaw = 0; break;
            case 'bottom': this.pitch = maxPitch; this.yaw = 0; break;
            case 'front': this.yaw = 0; this.pitch = 0; break;
            case 'back': this.yaw = Math.PI; this.pitch = 0; break;
            case 'left': this.yaw = Math.PI / 2; this.pitch = 0; break;
            case 'right': this.yaw = -Math.PI / 2; this.pitch = 0; break;
        }
        this.updateRotation();
        this.updateOrbitPosition();
        this.setProjection('orthographic');
        this.emitChanged();
    }

    public toggleProjection(): void {
        this.setProjection(this.projectionMode === 'perspective' ? 'orthographic' : 'perspective');
    }

    public setProjection(mode: ProjectionMode): void {
        const next = mode === 'orthographic' ? this.orthographic : this.perspective;
        if (next === this.activeCamera) return;
        next.position.copy(this.activeCamera.position);
        next.quaternion.copy(this.activeCamera.quaternion);
        if (mode === 'orthographic') {
            const visibleHeight = 2 * this.distance * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
            const baseHeight = this.orthographic.top - this.orthographic.bottom;
            this.orthographic.zoom = THREE.MathUtils.clamp(baseHeight / visibleHeight, 0.05, 100);
            this.orthographic.updateProjectionMatrix();
        }
        this.activeCamera = next;
        this.updateRotation();
        this.activeCamera.updateMatrixWorld();
        this.emitChanged();
    }

    public update(delta: number): void {
        const forward = new THREE.Vector3();
        this.activeCamera.getWorldDirection(forward);
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
        const velocity = new THREE.Vector3();
        if (this.keys.has('KeyW')) velocity.add(forward);
        if (this.keys.has('KeyS')) velocity.sub(forward);
        if (this.keys.has('KeyA')) velocity.sub(right);
        if (this.keys.has('KeyD')) velocity.add(right);
        if (this.keys.has('Space')) velocity.y += 1;
        if (this.keys.has('KeyQ')) velocity.y -= 1;
        if (velocity.lengthSq() > 0) {
            velocity.normalize().multiplyScalar(this.moveSpeed * delta);
            this.activeCamera.position.add(velocity);
            this.target.add(velocity);
            this.syncInactiveCamera();
            this.emitChanged();
        }
    }

    public resize(): void {
        const aspect = window.innerWidth / window.innerHeight;
        this.perspective.aspect = aspect;
        this.perspective.updateProjectionMatrix();
        const halfHeight = 10;
        this.orthographic.left = -halfHeight * aspect;
        this.orthographic.right = halfHeight * aspect;
        this.orthographic.top = halfHeight;
        this.orthographic.bottom = -halfHeight;
        this.orthographic.updateProjectionMatrix();
        this.emitChanged();
    }

    public dispose(): void {
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mousedown', this.onMouseDown);
        window.removeEventListener('mouseup', this.onMouseUp);
        window.removeEventListener('wheel', this.onWheel);
        window.removeEventListener('contextmenu', this.onContextMenu);
        window.removeEventListener('resize', this.onResize);
        this.listeners.clear();
    }
}
