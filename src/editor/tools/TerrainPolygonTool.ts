import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import HistoryManager from '../HistoryManager';
import PresetManager from '../PresetManager';
import PolygonTerrain from '../../elements/PolygonTerrain';
import TerrainPolygonPanel from '../panels/TerrainPolygonPanel';
import { snapToAxisAlignment, AxisGuideRenderer, type AxisGuide } from '../SnapGuides';

const CLOSE_PIXEL_THRESHOLD = 18;

// Click-to-place polygon tool: every click after the first appends a vertex, and clicking
// back near the first vertex (or pressing Enter once at least 3 are down) closes the loop
// and finishes the shape - the "must end where it started" behaviour the polygon terrain
// needs to read as a closed circle/square/etc rather than an open path.
@singleton()
export default class TerrainPolygonTool implements Tool {
    public readonly name = 'terrain-polygon';
    public readonly blocksCamera = true;

    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();
    private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    private preview: PolygonTerrain | null = null;
    private outlineLine: THREE.LineLoop | null = null;
    private closing = false;
    private guideRenderer!: AxisGuideRenderer;

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) private readonly camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(PresetManager) private readonly presets: PresetManager,
        @inject(TerrainPolygonPanel) private readonly panel: TerrainPolygonPanel,
    ) {
        this.panel.onCancel = () => this.cancel();
        this.guideRenderer = new AxisGuideRenderer(this.scene.instance);
    }

    public activate(): void {
        this.panel.show();
        this.panel.setPointCount(0);
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('keydown', this.onKeyDown);
    }

    public deactivate(): void {
        this.cancel();
        this.guideRenderer.clear();
        this.panel.hide();
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('keydown', this.onKeyDown);
    }

    public onMouseDown(e: MouseEvent): boolean {
        if (e.button !== 0 || !this.isCanvasEvent(e)) return false;

        if (this.preview && this.preview.pointCount >= 3 && this.isNearFirstPoint(e)) {
            this.finalize();
            return true;
        }

        const raw = this.getPlacementPoint(e);
        if (!raw) return true;
        const { point } = this.applyPlacementConstraints(raw, e.shiftKey);

        if (!this.preview) {
            this.preview = new PolygonTerrain([point]);
            this.presets.applyDefault(this.preview);
            this.scene.add(this.preview);
            this.panel.setPointCount(1);
            return true;
        }

        this.preview.addPoint(point);
        this.panel.setPointCount(this.preview.pointCount);
        return true;
    }

    private onMouseMove = (e: MouseEvent): void => {
        if (!this.preview) return;
        const raw = this.getPlacementPoint(e);
        if (!raw) return;
        const { point, guides } = this.applyPlacementConstraints(raw, e.shiftKey);

        const points: THREE.Vector3[] = [];
        for (let i = 0; i < this.preview.pointCount; i++) points.push(this.preview.getPoint(i));
        points.push(point);

        this.closing = this.preview.pointCount >= 3 && this.isNearFirstPoint(e);
        this.updateOutline(points);
        if (guides.length > 0) this.guideRenderer.update(point, guides);
        else this.guideRenderer.clear();
        this.preview.getNode(0).setSelected(this.closing);
    };

    private onKeyDown = (e: KeyboardEvent): void => {
        const tagName = (e.target as HTMLElement | null)?.tagName;
        if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') return;
        if (!this.preview) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            this.cancel();
            return;
        }
        if (e.key === 'Enter' && this.preview.pointCount >= 3) {
            e.preventDefault();
            this.finalize();
            return;
        }
        if (e.key === 'Backspace') {
            e.preventDefault();
            if (this.preview.pointCount > 1) {
                this.preview.removeLastPoint();
                this.panel.setPointCount(this.preview.pointCount);
            } else {
                this.cancel();
            }
        }
    };

    private finalize(): void {
        if (!this.preview) return;
        this.preview.getNode(0).setSelected(false);
        this.disposeOutline();
        this.guideRenderer.clear();
        this.history.record('Add Polygon Terrain');
        this.preview = null;
        this.closing = false;
        this.panel.setPointCount(0);
    }

    private cancel(): void {
        if (this.preview) this.scene.remove(this.preview);
        this.disposeOutline();
        this.guideRenderer.clear();
        this.preview = null;
        this.closing = false;
        this.panel.setPointCount(0);
    }

    private updateOutline(points: THREE.Vector3[]): void {
        if (!this.outlineLine) {
            this.outlineLine = new THREE.LineLoop(
                new THREE.BufferGeometry(),
                new THREE.LineBasicMaterial({ color: 0x78baff, depthTest: false, transparent: true, opacity: 0.9 }),
            );
            this.outlineLine.renderOrder = 1000;
            this.scene.instance.add(this.outlineLine);
        }
        this.outlineLine.geometry.dispose();
        this.outlineLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
        (this.outlineLine.material as THREE.LineBasicMaterial).color.setHex(this.closing ? 0x67d986 : 0x78baff);
    }

    private disposeOutline(): void {
        if (!this.outlineLine) return;
        this.scene.instance.remove(this.outlineLine);
        this.outlineLine.geometry.dispose();
        (this.outlineLine.material as THREE.Material).dispose();
        this.outlineLine = null;
    }

    // Shift snaps the new segment's direction to 45° steps (same convention as roads and
    // fences). The axis-alignment guide through any of the shape's own already-placed
    // vertices applies on top of that regardless of Shift, so a 45°-snapped point can still
    // pull onto an aligned vertex when it's close enough. Flat mode locks every new point
    // to the first point's height so the shape you finish with actually starts flat.
    private applyPlacementConstraints(rawPoint: THREE.Vector3, shiftHeld: boolean): { point: THREE.Vector3; guides: AxisGuide[] } {
        const point = rawPoint.clone();
        if (!this.preview || this.preview.pointCount === 0) return { point, guides: [] };

        const last = this.preview.getPoint(this.preview.pointCount - 1);
        const angled = this.snapAngle(last, point, shiftHeld);

        const references: THREE.Vector3[] = [];
        for (let i = 0; i < this.preview.pointCount; i++) references.push(this.preview.getPoint(i));
        const aligned = snapToAxisAlignment(angled, references);
        const snapped = aligned.point;

        if (this.panel.settings.flat) snapped.y = this.preview.getPoint(0).y;
        return { point: snapped, guides: aligned.guides };
    }

    private snapAngle(from: THREE.Vector3, point: THREE.Vector3, enabled: boolean): THREE.Vector3 {
        if (!enabled) return point;
        const delta = point.clone().sub(from);
        const horizontalLength = Math.hypot(delta.x, delta.z);
        if (horizontalLength < 1e-8) return point;
        const step = Math.PI / 4;
        const angle = Math.round(Math.atan2(delta.z, delta.x) / step) * step;
        return new THREE.Vector3(
            from.x + Math.cos(angle) * horizontalLength,
            point.y,
            from.z + Math.sin(angle) * horizontalLength,
        );
    }

    private isNearFirstPoint(e: MouseEvent): boolean {
        if (!this.preview) return false;
        const projected = this.preview.getPoint(0).clone().project(this.camera.instance);
        const screenX = (projected.x * 0.5 + 0.5) * window.innerWidth;
        const screenY = (-projected.y * 0.5 + 0.5) * window.innerHeight;
        return Math.hypot(e.clientX - screenX, e.clientY - screenY) <= CLOSE_PIXEL_THRESHOLD;
    }

    private getPlacementPoint(e: MouseEvent): THREE.Vector3 | null {
        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera.instance);

        const targets: THREE.Object3D[] = [];
        for (const child of this.scene.instance.children) {
            if (this.preview && child === this.preview.mesh) continue;
            if (this.outlineLine && child === this.outlineLine) continue;
            targets.push(child);
        }
        // Only land on an actual placed WorldElement's surface (terrain, road, ...), not on
        // decorative scene dressing (sky dome, gizmo helpers) that also has real faces -
        // TransformControls' own drag-plane in particular is invisible but still raycastable
        // (three.js does not skip invisible objects), and sits nested a level below its
        // helper root, so a type check on just the top-level scene child would miss it.
        const hit = this.raycaster.intersectObjects(targets, true).find((candidate) => (
            candidate.face !== null && candidate.object.userData.worldElement !== undefined
        ));
        if (hit) return hit.point.clone();

        const fallback = new THREE.Vector3();
        return this.raycaster.ray.intersectPlane(this.groundPlane, fallback) ? fallback : null;
    }

    private isCanvasEvent(e: MouseEvent): boolean {
        return (e.target as HTMLElement).tagName === 'CANVAS';
    }
}
