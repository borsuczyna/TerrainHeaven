import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import Renderer from './Renderer';
import Camera from './Camera';
import SceneManager from './SceneManager';
import type WorldElement from '../elements/WorldElement';
import HistoryManager from './HistoryManager';

@singleton()
export default class TextureDropManager {
    private readonly raycaster = new THREE.Raycaster();

    constructor(
        @inject(Renderer) private readonly renderer: Renderer,
        @inject(Camera) private readonly camera: Camera,
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(HistoryManager) private readonly history: HistoryManager,
    ) {}

    public init(): void {
        const canvas = this.renderer.domElement;

        canvas.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer!.dropEffect = 'copy';
        });

        canvas.addEventListener('drop', (e) => {
            e.preventDefault();
            const url = e.dataTransfer?.getData('application/x-texture-url');
            if (!url) return;

            const mouse = new THREE.Vector2(
                (e.clientX / window.innerWidth) * 2 - 1,
                -(e.clientY / window.innerHeight) * 2 + 1,
            );

            this.raycaster.setFromCamera(mouse, this.camera.instance);

            const targets: THREE.Object3D[] = [];
            for (const child of this.scene.instance.children) {
                if (child.type !== 'TransformControlsRoot' && child.type !== 'TransformControlsGizmo' && child.type !== 'TransformControlsPlane') {
                    targets.push(child);
                }
            }
            const intersects = this.raycaster.intersectObjects(targets, true);

            for (const hit of intersects) {
                const el = hit.object.userData.worldElement as WorldElement | undefined;
                if (el && hit.faceIndex != null) {
                    const groupName = el.getGroupNameAtFace(hit.faceIndex);
                    if (groupName) {
                        const loader = new THREE.TextureLoader();
                        loader.load(url, (tex) => {
                            tex.wrapS = THREE.RepeatWrapping;
                            tex.wrapT = THREE.RepeatWrapping;
                            tex.colorSpace = THREE.SRGBColorSpace;
                            el.setGroupTexture(groupName, tex);
                            this.history.record('Apply Texture');
                        });
                    }
                    break;
                }
            }
        });
    }
}
