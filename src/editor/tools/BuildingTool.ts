import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import Building from '../../elements/Building';
import HistoryManager from '../HistoryManager';
import PresetManager from '../PresetManager';

const DEFAULT_WIDTH = 8;
const DEFAULT_DEPTH = 6;

@singleton()
export default class BuildingTool implements Tool {
    public readonly name = 'building';
    public readonly blocksCamera = true;
    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();
    private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) private readonly camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(PresetManager) private readonly presets: PresetManager,
    ) {}

    activate(): void {}
    deactivate(): void {}

    onMouseDown(e: MouseEvent): boolean {
        if (e.button !== 0) return false;
        if ((e.target as HTMLElement).closest('#toolbar')) return false;
        if ((e.target as HTMLElement).closest('#properties-panel')) return false;

        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera.instance);

        const target = new THREE.Vector3();
        if (!this.raycaster.ray.intersectPlane(this.groundPlane, target)) return false;

        const building = new Building(target, { width: DEFAULT_WIDTH, depth: DEFAULT_DEPTH });
        this.presets.applyDefault(building);
        this.scene.add(building);
        this.history.record('Add Building');
        return true;
    }
}
