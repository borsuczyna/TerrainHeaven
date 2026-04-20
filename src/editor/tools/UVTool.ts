import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import UVEditorPanel from '../panels/UVEditorPanel';
import type WorldElement from '../../elements/WorldElement';

@singleton()
export default class UVTool implements Tool {
    public readonly name = 'uv';
    public blocksCamera = false;

    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private uvEditor: UVEditorPanel;
    private raycaster = new THREE.Raycaster();
    private mouse = new THREE.Vector2();

    constructor(
        @inject(SceneManager) scene: SceneManager,
        @inject(Camera) camera: Camera,
        @inject(UVEditorPanel) uvEditor: UVEditorPanel,
    ) {
        this.scene = scene.instance;
        this.camera = camera.instance;
        this.uvEditor = uvEditor;
    }

    activate(): void {}

    deactivate(): void {
        this.uvEditor.hide();
    }

    onMouseDown(e: MouseEvent): boolean {
        if (e.button !== 0) return false;

        // Don't intercept clicks on the UV editor itself
        if ((e.target as HTMLElement).closest('#uv-editor')) return false;

        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        const targets: THREE.Object3D[] = [];
        for (const child of this.scene.children) {
            if (child.type !== 'TransformControlsRoot' && child.type !== 'TransformControlsGizmo' && child.type !== 'TransformControlsPlane') {
                targets.push(child);
            }
        }
        const intersects = this.raycaster.intersectObjects(targets, true);

        for (const hit of intersects) {
            const el = hit.object.userData.worldElement as WorldElement | undefined;
            if (el && el.getUVGroups().length > 0) {
                this.uvEditor.show(el);
                return true;
            }
        }

        // Clicked on nothing or non-UV element
        this.uvEditor.hide();
        return false;
    }
}
