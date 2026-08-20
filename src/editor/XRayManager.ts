import * as THREE from 'three';
import { singleton } from 'tsyringe';

// Makes registered meshes (world node handles) render on top of everything else, so their
// color-coded type is visible through walls/terrain - toggled by the X-ray shortcut.
@singleton()
class XRayManager {
    private meshes: Set<THREE.Mesh> = new Set();
    private enabled: boolean = false;

    public register(mesh: THREE.Mesh): void {
        this.meshes.add(mesh);
        this.applyTo(mesh, this.enabled);
    }

    public unregister(mesh: THREE.Mesh): void {
        this.meshes.delete(mesh);
        this.applyTo(mesh, false);
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
        for (const mesh of this.meshes) this.applyTo(mesh, this.enabled);
    }

    private applyTo(mesh: THREE.Mesh, enabled: boolean): void {
        mesh.renderOrder = enabled ? 999 : 0;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of materials) {
            mat.depthTest = !enabled;
            mat.needsUpdate = true;
        }
    }
}

export default XRayManager;
