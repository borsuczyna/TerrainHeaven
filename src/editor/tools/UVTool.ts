import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import UVEditorPanel from '../panels/UVEditorPanel';
import type WorldElement from '../../elements/WorldElement';

interface UVHoverHit {
    element: WorldElement;
    groupName: string;
    material: THREE.MeshStandardMaterial;
}

@singleton()
export default class UVTool implements Tool {
    public readonly name = 'uv';
    public blocksCamera = false;

    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private uvEditor: UVEditorPanel;
    private raycaster = new THREE.Raycaster();
    private mouse = new THREE.Vector2();
    private hoveredMaterial: THREE.MeshStandardMaterial | null = null;
    private hoveredMaterialBaseColor: THREE.Color | null = null;
    private hoveredMaterialEmissive: THREE.Color | null = null;
    private hoveredMaterialEmissiveIntensity = 0;

    constructor(
        @inject(SceneManager) scene: SceneManager,
        @inject(Camera) camera: Camera,
        @inject(UVEditorPanel) uvEditor: UVEditorPanel,
    ) {
        this.scene = scene.instance;
        this.camera = camera.instance;
        this.uvEditor = uvEditor;
    }

    activate(): void {
        window.addEventListener('mousemove', this.onMouseMove);
    }

    deactivate(): void {
        window.removeEventListener('mousemove', this.onMouseMove);
        this.clearHoveredMaterial();
        this.uvEditor.hide();
    }

    onMouseDown(e: MouseEvent): boolean {
        if (e.button !== 0) return false;

        // Don't intercept clicks on the UV editor itself
        if ((e.target as HTMLElement).closest('#uv-editor')) return false;

        const hit = this.pickUVHit(e.clientX, e.clientY);
        if (hit) {
            this.uvEditor.show(hit.element, hit.groupName);
            return true;
        }

        // Clicked on nothing or non-UV element
        this.uvEditor.hide();
        return false;
    }

    private onMouseMove = (e: MouseEvent): void => {
        const target = e.target as HTMLElement;
        if (target.closest('#uv-editor') || target.closest('#toolbar') || target.closest('#properties-panel')) {
            this.clearHoveredMaterial();
            return;
        }

        const hit = this.pickUVHit(e.clientX, e.clientY);
        if (!hit) {
            this.clearHoveredMaterial();
            return;
        }

        this.setHoveredMaterial(hit.material);
    };

    private pickUVHit(clientX: number, clientY: number): UVHoverHit | null {
        this.mouse.x = (clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);

        const intersects = this.raycaster.intersectObjects(this.getSceneTargets(), true);
        for (const hit of intersects) {
            if (hit.faceIndex == null) continue;

            const element = hit.object.userData.worldElement as WorldElement | undefined;
            if (!element) continue;

            const groupName = element.getGroupNameAtFace(hit.faceIndex);
            if (!groupName) continue;
            if (!element.getUVGroups().includes(groupName)) continue;

            const material = this.resolveMaterialForGroup(element, groupName);
            if (!material) continue;

            return { element, groupName, material };
        }

        return null;
    }

    private getSceneTargets(): THREE.Object3D[] {
        const targets: THREE.Object3D[] = [];
        for (const child of this.scene.children) {
            if (child.type !== 'TransformControlsRoot' && child.type !== 'TransformControlsGizmo' && child.type !== 'TransformControlsPlane') {
                targets.push(child);
            }
        }
        return targets;
    }

    private resolveMaterialForGroup(element: WorldElement, groupName: string): THREE.MeshStandardMaterial | null {
        const materials = Array.isArray(element.mesh.material) ? element.mesh.material : [element.mesh.material];
        const groupIndex = element.getGroupNames().indexOf(groupName);
        if (groupIndex < 0 || groupIndex >= materials.length) return null;

        const material = materials[groupIndex];
        if (!(material instanceof THREE.MeshStandardMaterial)) return null;
        return material;
    }

    private setHoveredMaterial(material: THREE.MeshStandardMaterial): void {
        if (this.hoveredMaterial === material) return;

        this.clearHoveredMaterial();
        this.hoveredMaterial = material;
        this.hoveredMaterialBaseColor = material.color.clone();
        this.hoveredMaterialEmissive = material.emissive.clone();
        this.hoveredMaterialEmissiveIntensity = material.emissiveIntensity;

        material.color.copy(this.hoveredMaterialBaseColor).lerp(new THREE.Color(0x00ffff), 0.45);
        material.emissive.setHex(0x00ffff);
        material.emissiveIntensity = 0.45;
        material.needsUpdate = true;
    }

    private clearHoveredMaterial(): void {
        if (!this.hoveredMaterial) return;

        if (this.hoveredMaterialBaseColor) {
            this.hoveredMaterial.color.copy(this.hoveredMaterialBaseColor);
        }
        if (this.hoveredMaterialEmissive) {
            this.hoveredMaterial.emissive.copy(this.hoveredMaterialEmissive);
        }
        this.hoveredMaterial.emissiveIntensity = this.hoveredMaterialEmissiveIntensity;
        this.hoveredMaterial.needsUpdate = true;

        this.hoveredMaterial = null;
        this.hoveredMaterialBaseColor = null;
        this.hoveredMaterialEmissive = null;
        this.hoveredMaterialEmissiveIntensity = 0;
    }
}
