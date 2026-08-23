import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import Building from '../../elements/Building';
import HistoryManager from '../HistoryManager';
import BuildingOpeningPanel from '../panels/BuildingOpeningPanel';

@singleton()
export default class BuildingOpeningTool implements Tool {
    public readonly name = 'building-opening';
    public readonly blocksCamera = true;
    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) private readonly camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(BuildingOpeningPanel) private readonly panel: BuildingOpeningPanel,
    ) {}

    activate(): void {
        this.panel.show();
    }

    deactivate(): void {
        this.panel.hide();
    }

    onMouseDown(e: MouseEvent): boolean {
        if (e.button !== 0) return false;
        if ((e.target as HTMLElement).closest('#toolbar')) return false;
        if ((e.target as HTMLElement).closest('#properties-panel')) return false;
        if ((e.target as HTMLElement).closest('#building-opening-panel')) return false;

        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera.instance);

        const targets: THREE.Object3D[] = [];
        for (const child of this.scene.instance.children) {
            if (child.type !== 'TransformControlsRoot' && child.type !== 'TransformControlsGizmo' && child.type !== 'TransformControlsPlane') {
                targets.push(child);
            }
        }

        for (const candidate of this.raycaster.intersectObjects(targets, true)) {
            if (!candidate.face) continue;
            const element = candidate.object.userData.worldElement as unknown;
            if (!(element instanceof Building)) continue;
            if (element.getGroupNameAtFace(candidate.faceIndex ?? 0) !== 'walls') continue;

            element.addOpening(candidate.point, this.panel.settings.type);
            this.history.record(this.panel.settings.type === 'door' ? 'Add Door' : 'Add Window');
            return true;
        }
        return false;
    }
}
