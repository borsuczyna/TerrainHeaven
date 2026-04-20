import * as THREE from 'three';

class WireframeManager {
    private meshes: Set<THREE.Mesh> = new Set();
    private enabled: boolean = false;

    public register(mesh: THREE.Mesh): void {
        this.meshes.add(mesh);
        if (this.enabled) {
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const mat of materials) {
                if (mat instanceof THREE.MeshStandardMaterial) {
                    mat.wireframe = true;
                }
            }
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

    public isEnabled(): boolean {
        return this.enabled;
    }

    private apply(): void {
        for (const mesh of this.meshes) {
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const mat of materials) {
                if (mat instanceof THREE.MeshStandardMaterial) {
                    mat.wireframe = this.enabled;
                }
            }
        }
    }
}

export default new WireframeManager();
