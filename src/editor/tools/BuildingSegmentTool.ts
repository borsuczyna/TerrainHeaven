import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import Building from '../../elements/Building';
import HistoryManager from '../HistoryManager';

const NEW_SEGMENT_SIZE = 4;

interface BuildingWallHit {
    building: Building;
    point: THREE.Vector3;
    outward: THREE.Vector3;
}

@singleton()
export default class BuildingSegmentTool implements Tool {
    public readonly name = 'building-segment';
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

        const hit = this.getWallHit(e);
        if (!hit) return false;

        // A new square segment whose inner edge sits flush against the wall that was
        // clicked, extending straight out along that wall's outward normal - building
        // walls are always axis-aligned (segments are AABB rectangles, and a union of
        // AABBs only ever produces axis-aligned edges), so the normal is always a clean
        // cardinal direction and this never needs to account for an angled wall.
        const anchor = hit.building.getAnchorPosition();
        const center = hit.point.clone().addScaledVector(hit.outward, NEW_SEGMENT_SIZE / 2);
        hit.building.addSegment({
            offsetX: center.x - anchor.x,
            offsetZ: center.z - anchor.z,
            width: NEW_SEGMENT_SIZE,
            depth: NEW_SEGMENT_SIZE,
        });
        this.history.record('Add Building Segment');
        return true;
    }

    private getWallHit(e: MouseEvent): BuildingWallHit | null {
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
            const groupName = element.getGroupNameAtFace(candidate.faceIndex ?? 0);
            if (groupName !== 'walls') continue;

            const outward = candidate.face.normal.clone().transformDirection(candidate.object.matrixWorld);
            outward.y = 0;
            if (outward.lengthSq() < 1e-6) continue;
            outward.normalize();
            return { building: element, point: candidate.point.clone(), outward };
        }
        return null;
    }
}
