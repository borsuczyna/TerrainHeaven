import * as THREE from 'three';
import { singleton } from 'tsyringe';
import type SelectionManager from './SelectionManager';
import type ToolManager from './ToolManager';

@singleton()
export default class Camera {
    public readonly instance: THREE.PerspectiveCamera;
    public selectionManager: SelectionManager | null = null;
    public toolManager: ToolManager | null = null;

    private keys = new Set<string>();
    private moveSpeed: number = 5;
    private lookSpeed: number = 0.002;
    private pitch = -0.2;
    private yaw = -Math.PI / 2;
    private isDragging = false;

    constructor() {
        this.instance = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            1000,
        );

        this.instance.position.set(0, 5, 0);

        this.bindEvents();
        this.updateRotation();
    }

    private bindEvents(): void {
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mousedown', this.onMouseDown);
        window.addEventListener('mouseup', this.onMouseUp);
        window.addEventListener('resize', this.onResize);
    }

    private onKeyDown = (e: KeyboardEvent): void => {
        this.keys.add(e.code);
    };

    private onKeyUp = (e: KeyboardEvent): void => {
        this.keys.delete(e.code);
    };

    private onMouseDown = (e: MouseEvent): void => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).tagName !== 'CANVAS') return;
        if (this.toolManager?.getActive()?.blocksCamera) return;
        if (this.selectionManager?.nodeWasHit) return;
        if (this.selectionManager?.gizmo?.isDragging) return;
        this.isDragging = true;
    };

    private onMouseUp = (e: MouseEvent): void => {
        if (e.button !== 0) return;
        this.isDragging = false;
    };

    private onMouseMove = (e: MouseEvent): void => {
        if (!this.isDragging) return;

        this.yaw -= e.movementX * this.lookSpeed;
        this.pitch -= e.movementY * this.lookSpeed;

        const maxPitch = Math.PI / 2 - 0.01;
        this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));

        this.updateRotation();
    };

    private onResize = (): void => {
        this.instance.aspect = window.innerWidth / window.innerHeight;
        this.instance.updateProjectionMatrix();
    };

    private updateRotation(): void {
        this.instance.rotation.order = 'YXZ';
        this.instance.rotation.y = this.yaw;
        this.instance.rotation.x = this.pitch;
    }

    public update(delta: number): void {
        const forward = new THREE.Vector3();
        this.instance.getWorldDirection(forward);

        const right = new THREE.Vector3();
        right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        const velocity = new THREE.Vector3();

        if (this.keys.has('KeyW')) velocity.add(forward);
        if (this.keys.has('KeyS')) velocity.sub(forward);
        if (this.keys.has('KeyA')) velocity.sub(right);
        if (this.keys.has('KeyD')) velocity.add(right);
        if (this.keys.has('Space')) velocity.y += 1;
        if (this.keys.has('ShiftLeft')) velocity.y -= 1;

        if (velocity.lengthSq() > 0) {
            velocity.normalize().multiplyScalar(this.moveSpeed * delta);
            this.instance.position.add(velocity);
        }
    }

    public resize(): void {
        this.instance.aspect = window.innerWidth / window.innerHeight;
        this.instance.updateProjectionMatrix();
    }

    public dispose(): void {
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mousedown', this.onMouseDown);
        window.removeEventListener('mouseup', this.onMouseUp);
        window.removeEventListener('resize', this.onResize);
    }
}