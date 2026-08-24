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
            // renderOrder only sorts objects within whichever render bucket they're already
            // in - WebGLRenderer always draws every opaque-bucket object before any
            // transparent-bucket one, regardless of renderOrder across the two buckets. Any
            // textured element's material has transparent=true (see WorldElement's
            // configureTextureTransparency), so it's in the transparent bucket and was
            // drawing after (i.e. on top of) an x-rayed opaque-bucket mesh no matter how high
            // its renderOrder was set. Forcing transparent=true here too puts the x-rayed
            // mesh in the same bucket as any textured occluder, where its renderOrder=999
            // then genuinely wins; the material's real transparent value is restored once
            // x-ray is turned back off.
            if (enabled) {
                if (mat.userData.xrayOriginalTransparent === undefined) {
                    mat.userData.xrayOriginalTransparent = mat.transparent;
                }
                mat.transparent = true;
            } else if (mat.userData.xrayOriginalTransparent !== undefined) {
                mat.transparent = mat.userData.xrayOriginalTransparent;
                delete mat.userData.xrayOriginalTransparent;
            }
            mat.needsUpdate = true;
        }
    }
}

export default XRayManager;
