import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import Terrain from '../../elements/Terrain.ts';
import HistoryManager from '../HistoryManager.ts';
import TerrainCutPointManager from '../TerrainCutPointManager.ts';

@singleton()
export default class TerrainCutPointTool implements Tool {
    public readonly name = 'terrain-cut-point';
    public readonly blocksCamera = true;
    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(TerrainCutPointManager) private readonly cutPointManager: TerrainCutPointManager,
    ) {
        this.camera = camera;
    }

    private readonly camera: Camera;

    activate(): void {}
    deactivate(): void {}

    onMouseDown(e: MouseEvent): boolean {
        if (e.button !== 0) return false;
        if ((e.target as HTMLElement).closest('#toolbar')) return false;
        if ((e.target as HTMLElement).closest('#properties-panel')) return false;

        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera.instance);

        const targets: THREE.Object3D[] = [];
        for (const child of this.scene.instance.children) {
            if (!child.userData.isGizmoWidget) {
                targets.push(child);
            }
        }

        const intersects = this.raycaster.intersectObjects(targets, true);
        for (const hit of intersects) {
            if (hit.object.userData.worldNode) continue;
            const terrain = this.getTerrainFromHit(hit.object);
            if (!terrain) continue;

            this.cutPointManager.addPoint(hit.point.clone());
            this.history.record('Add Terrain Cut Point');
            return true;
        }

        return false;
    }

    private getTerrainFromHit(object: THREE.Object3D): Terrain | null {
        let current: THREE.Object3D | null = object;
        while (current) {
            const element = current.userData.worldElement;
            if (element instanceof Terrain) {
                return element;
            }
            current = current.parent;
        }

        return null;
    }
}
