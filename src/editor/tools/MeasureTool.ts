import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import MeasurePanel from '../panels/MeasurePanel';
import { snapToAxisAlignment, AxisGuideRenderer } from '../SnapGuides';

const MARKER_SIZE = 0.22;
const MARKER_COLOR_A = 0x67d986;
const MARKER_COLOR_B = 0x67b3d9;
const LINE_COLOR = 0xf2c94c;

// Click two points to measure the distance between them, snapping onto any nearby node
// (road/fence/terrain vertices, ...) so a measurement lands on the actual geometry instead
// of wherever the ray happens to hit the ground. While picking the second point, it also
// aligns with the first one on the X or Z axis (the same alignment-guide mechanic the
// Polygon Terrain tool uses while drawing), so measuring a straight run is a single click.
@singleton()
export default class MeasureTool implements Tool {
    public readonly name = 'measure';
    public readonly blocksCamera = true;

    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();
    private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    private readonly guideRenderer: AxisGuideRenderer;

    private pointA: THREE.Vector3 | null = null;
    private pointB: THREE.Vector3 | null = null;
    private markerA: THREE.Mesh | null = null;
    private markerB: THREE.Mesh | null = null;
    private line: THREE.Line | null = null;

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) private readonly camera: Camera,
        @inject(MeasurePanel) private readonly panel: MeasurePanel,
    ) {
        this.panel.onClear = () => this.clear();
        // Uses AxisGuideRenderer's own default (red dashed) rather than LINE_COLOR, so the
        // alignment guide reads as distinct from the solid measurement line itself.
        this.guideRenderer = new AxisGuideRenderer(this.scene.instance);
    }

    public activate(): void {
        this.panel.show();
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('keydown', this.onKeyDown);
    }

    public deactivate(): void {
        this.clear();
        this.panel.hide();
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('keydown', this.onKeyDown);
    }

    public onMouseDown(e: MouseEvent): boolean {
        if (e.button !== 0 || !this.isCanvasEvent(e)) return false;

        const point = this.resolvePoint(e);
        if (!point) return true;

        if (this.pointA && this.pointB) {
            // A third click starts a fresh measurement rather than extending this one.
            this.clear();
        }

        if (!this.pointA) {
            this.pointA = point;
            this.markerA = this.createMarker(point, MARKER_COLOR_A);
            this.panel.setPointA(point);
            return true;
        }

        this.pointB = point;
        this.markerB = this.createMarker(point, MARKER_COLOR_B);
        this.updateLine(this.pointA, this.pointB);
        this.panel.setPointB(point);
        this.panel.setDistance(this.pointA, this.pointB);
        this.guideRenderer.clear();
        return true;
    }

    private onMouseMove = (e: MouseEvent): void => {
        if (!this.pointA || this.pointB) return;
        const point = this.resolvePoint(e);
        if (!point) return;

        this.updateLine(this.pointA, point);
        this.panel.setPointB(point);
        this.panel.setDistance(this.pointA, point);
    };

    private onKeyDown = (e: KeyboardEvent): void => {
        const tagName = (e.target as HTMLElement | null)?.tagName;
        if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') return;

        if (e.key === 'Escape') {
            e.preventDefault();
            this.clear();
            return;
        }
        if (e.key === 'Backspace') {
            e.preventDefault();
            if (this.pointB) {
                this.pointB = null;
                this.disposeMarker('b');
                this.disposeLine();
                this.panel.setPointB(null);
                this.panel.setDistance(null, null);
            } else if (this.pointA) {
                this.clear();
            }
        }
    };

    private clear(): void {
        this.pointA = null;
        this.pointB = null;
        this.disposeMarker('a');
        this.disposeMarker('b');
        this.disposeLine();
        this.guideRenderer.clear();
        this.panel.setPointA(null);
        this.panel.setPointB(null);
        this.panel.setDistance(null, null);
    }

    // Snaps directly onto any existing WorldNode under the cursor (exact vertex snap), and
    // while picking the second point, aligns it with the first on the X or Z axis when
    // close enough - drawing the same orange guide line the Polygon Terrain tool uses.
    private resolvePoint(e: MouseEvent): THREE.Vector3 | null {
        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera.instance);

        const targets: THREE.Object3D[] = [];
        for (const child of this.scene.instance.children) {
            if (this.markerA && child === this.markerA) continue;
            if (this.markerB && child === this.markerB) continue;
            if (this.line && child === this.line) continue;
            targets.push(child);
        }
        const intersects = this.raycaster.intersectObjects(targets, true);

        const nodeHit = intersects.find((candidate) => candidate.object.userData.worldNode !== undefined);
        let point: THREE.Vector3 | null = null;
        if (nodeHit) {
            point = new THREE.Vector3();
            nodeHit.object.getWorldPosition(point);
        } else {
            const surfaceHit = intersects.find((candidate) => (
                candidate.face !== null && candidate.object.userData.worldElement !== undefined
            ));
            if (surfaceHit) point = surfaceHit.point.clone();
        }

        if (!point) {
            const fallback = new THREE.Vector3();
            if (!this.raycaster.ray.intersectPlane(this.groundPlane, fallback)) return null;
            point = fallback;
        }

        if (this.pointA && !this.pointB && !nodeHit) {
            const aligned = snapToAxisAlignment(point, [this.pointA]);
            point = aligned.point;
            if (aligned.guides.length > 0) this.guideRenderer.update(point, aligned.guides);
            else this.guideRenderer.clear();
        } else {
            this.guideRenderer.clear();
        }

        return point;
    }

    private createMarker(point: THREE.Vector3, color: number): THREE.Mesh {
        const marker = new THREE.Mesh(
            new THREE.SphereGeometry(MARKER_SIZE, 16, 16),
            new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }),
        );
        marker.renderOrder = 1000;
        marker.position.copy(point);
        this.scene.instance.add(marker);
        return marker;
    }

    private disposeMarker(which: 'a' | 'b'): void {
        const marker = which === 'a' ? this.markerA : this.markerB;
        if (!marker) return;
        this.scene.instance.remove(marker);
        marker.geometry.dispose();
        (marker.material as THREE.Material).dispose();
        if (which === 'a') this.markerA = null;
        else this.markerB = null;
    }

    private updateLine(from: THREE.Vector3, to: THREE.Vector3): void {
        if (!this.line) {
            this.line = new THREE.Line(
                new THREE.BufferGeometry(),
                new THREE.LineBasicMaterial({ color: LINE_COLOR, depthTest: false, transparent: true, opacity: 0.95 }),
            );
            this.line.renderOrder = 999;
            this.scene.instance.add(this.line);
        }
        this.line.geometry.dispose();
        this.line.geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    }

    private disposeLine(): void {
        if (!this.line) return;
        this.scene.instance.remove(this.line);
        this.line.geometry.dispose();
        (this.line.material as THREE.Material).dispose();
        this.line = null;
    }

    private isCanvasEvent(e: MouseEvent): boolean {
        return (e.target as HTMLElement).tagName === 'CANVAS';
    }
}
