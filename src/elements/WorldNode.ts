import * as THREE from 'three';
import { container } from 'tsyringe';
import type WorldElement from './WorldElement';
import XRayManager from '../editor/XRayManager';

const NODE_SIZE = 0.2;

export default class WorldNode {
    public readonly mesh: THREE.Mesh;
    public parent: WorldElement | null = null;
    private baseColor: number = 0x00ff00;

    constructor(position: THREE.Vector3, color?: number) {
        if (color !== undefined) {
            this.baseColor = color;
        }

        const geometry = new THREE.BoxGeometry(NODE_SIZE, NODE_SIZE, NODE_SIZE);
        const material = new THREE.MeshStandardMaterial({ color: this.baseColor });
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.position.copy(position);
        this.mesh.userData.worldNode = this;
        container.resolve(XRayManager).register(this.mesh);
    }

    public update(position: THREE.Vector3): void {
        this.mesh.position.copy(position);
        this.parent?.update();
    }

    public setColor(color: number): void {
        this.baseColor = color;
        (this.mesh.material as THREE.MeshStandardMaterial).color.setHex(this.baseColor);
    }

    public setSelected(selected: boolean): void {
        const mat = this.mesh.material as THREE.MeshStandardMaterial;
        if (selected) {
            mat.color.setHex(this.baseColor);
            mat.emissive.setHex(0x444444);
        } else {
            mat.color.setHex(this.baseColor);
            mat.emissive.setHex(0x000000);
        }
    }

    public dispose(): void {
        container.resolve(XRayManager).unregister(this.mesh);
        this.mesh.geometry.dispose();
        const materials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
        for (const material of materials) material.dispose();
        this.parent = null;
    }
}
