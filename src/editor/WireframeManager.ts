import * as THREE from 'three';

class WireframeManager {
    private meshes: Set<THREE.Mesh> = new Set();
    private enabled: boolean = false;

    public register(mesh: THREE.Mesh): void {
        this.meshes.add(mesh);
        if (this.enabled) {
            (mesh.material as THREE.MeshStandardMaterial).wireframe = true;
        }
    }

    public unregister(mesh: THREE.Mesh): void {
        this.meshes.delete(mesh);
    }

    public toggle(): boolean {
        this.enabled = !this.enabled;
        this.apply();
        return this.enabled;
    }

    public setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        this.apply();
    }

    private apply(): void {
        for (const mesh of this.meshes) {
            if (mesh.material instanceof THREE.Material) {
                (mesh.material as THREE.MeshStandardMaterial).wireframe = this.enabled;
            }
        }
    }
}

export default new WireframeManager();
