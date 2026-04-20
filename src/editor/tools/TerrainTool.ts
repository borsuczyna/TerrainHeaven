import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { Tool } from '../ToolManager.ts';
import SceneManager from '../SceneManager.ts';
import Camera from '../Camera.ts';
import Terrain from '../../elements/Terrain.ts';

@singleton()
export default class TerrainTool implements Tool {
    public readonly name = 'terrain';
    public readonly blocksCamera = true;
    private scene: SceneManager;
    private camera: THREE.PerspectiveCamera;
    private raycaster = new THREE.Raycaster();
    private mouse = new THREE.Vector2();
    private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    constructor(
        @inject(SceneManager) scene: SceneManager,
        @inject(Camera) camera: Camera,
    ) {
        this.scene = scene;
        this.camera = camera.instance;
    }

    activate(): void {}
    deactivate(): void {}

    onMouseDown(e: MouseEvent): boolean {
        if (e.button !== 0) return false;
        if ((e.target as HTMLElement).closest('#toolbar')) return false;
        if ((e.target as HTMLElement).closest('#properties-panel')) return false;

        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);

        const target = new THREE.Vector3();
        if (!this.raycaster.ray.intersectPlane(this.groundPlane, target)) return false;

        const terrain = new Terrain(target, 30, 30);
        this.scene.add(terrain);
        return true;
    }
}
