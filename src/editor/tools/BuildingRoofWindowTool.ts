import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import Building from '../../elements/Building';
import HistoryManager from '../HistoryManager';

// Click a gable roof slope to drop a dormer there - see Building.addRoofWindow and the
// class-level note on RoofWindowEntry for how it's placed/built. Only 'roof#<segmentIndex>'
// faces belonging to a 'gable' segment are accepted; clicking any other roof (flat, hip,
// tented, gambrel) or a wall/etc. does nothing, since Building.ts only knows how to place a
// dormer on a single flat gable slope right now.
@singleton()
export default class BuildingRoofWindowTool implements Tool {
    public readonly name = 'building-roof-window';
    public readonly blocksCamera = true;
    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) private readonly camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
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

        const targets: THREE.Object3D[] = [];
        for (const child of this.scene.instance.children) {
            if (!child.userData.isGizmoWidget) {
                targets.push(child);
            }
        }

        for (const candidate of this.raycaster.intersectObjects(targets, true)) {
            if (!candidate.face) continue;
            const element = candidate.object.userData.worldElement as unknown;
            if (!(element instanceof Building)) continue;

            const groupName = element.getGroupNameAtFace(candidate.faceIndex ?? 0);
            const match = groupName?.match(/^roof#(\d+)$/);
            if (!match) continue;
            const segmentIndex = Number(match[1]);
            if (element.getSegment(segmentIndex)?.roofType !== 'gable') continue;

            element.addRoofWindow(candidate.point);
            this.history.record('Add Roof Window');
            return true;
        }
        return false;
    }
}
