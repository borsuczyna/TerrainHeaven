import * as THREE from 'three';
import { inject, singleton } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import HistoryManager from '../HistoryManager';
import MeshManager from '../MeshManager';
import MeshPanel from '../panels/MeshPanel';
import type { MeshVector3 } from '../../mesh/MeshData';

type DragMode = 'none' | 'scatter' | 'erase' | 'line';

@singleton()
export default class MeshTool implements Tool {
    public readonly name = 'meshes';
    public readonly blocksCamera = true;

    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();
    private readonly brushRing: THREE.LineLoop;
    private readonly linePreview: THREE.Line;
    private drag: DragMode = 'none';
    private lineStart: THREE.Vector3 | null = null;

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) private readonly camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(MeshManager) private readonly meshes: MeshManager,
        @inject(MeshPanel) private readonly panel: MeshPanel,
    ) {
        const points: THREE.Vector3[] = [];
        for (let index = 0; index < 64; index++) {
            const angle = (index / 64) * Math.PI * 2;
            points.push(new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
        }
        this.brushRing = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color: 0x55aaff, depthTest: false, transparent: true, opacity: 0.95 }),
        );
        this.brushRing.renderOrder = 1000;
        this.brushRing.visible = false;
        this.scene.instance.add(this.brushRing);

        this.linePreview = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
            new THREE.LineBasicMaterial({ color: 0x55aaff, depthTest: false, transparent: true, opacity: 0.95, linewidth: 2 }),
        );
        this.linePreview.renderOrder = 1000;
        this.linePreview.visible = false;
        this.scene.instance.add(this.linePreview);

        window.addEventListener('mesh-panel-closed', () => {
            if (this.panel.isVisible) return;
            this.brushRing.visible = false;
            this.linePreview.visible = false;
        });
    }

    public activate(): void {
        this.panel.show();
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.handleMouseUp);
        window.addEventListener('keydown', this.onModifierChanged);
        window.addEventListener('keyup', this.onModifierChanged);
    }

    public deactivate(): void {
        if (this.drag !== 'none') this.history.endAction();
        this.drag = 'none';
        this.lineStart = null;
        this.brushRing.visible = false;
        this.linePreview.visible = false;
        this.panel.hide();
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.handleMouseUp);
        window.removeEventListener('keydown', this.onModifierChanged);
        window.removeEventListener('keyup', this.onModifierChanged);
    }

    public onMouseDown(event: MouseEvent): boolean {
        if (event.button !== 0 || (event.target as HTMLElement).tagName !== 'CANVAS') return false;
        if (!this.panel.isVisible || !this.panel.settings.enabled) return true;
        const hit = this.getSurfaceHit(event.clientX, event.clientY);
        if (!hit) return true;

        const erase = event.ctrlKey || event.metaKey;
        if (erase) {
            this.drag = 'erase';
            this.history.beginAction('Erase Mesh Props');
            this.applyErase(hit.point);
        } else if (this.panel.settings.mode === 'line') {
            this.drag = 'line';
            this.lineStart = hit.point.clone();
            this.history.beginAction('Place Mesh Line');
            this.updateLinePreview(hit.point, hit.point);
        } else {
            this.drag = 'scatter';
            this.history.beginAction('Scatter Mesh Props');
            this.applyScatterBrush(hit.point);
        }
        event.preventDefault();
        return true;
    }

    private onMouseMove = (event: MouseEvent): void => {
        if ((event.target as HTMLElement).tagName !== 'CANVAS') {
            if (this.drag === 'none') {
                this.brushRing.visible = false;
                this.linePreview.visible = false;
            }
            return;
        }
        const hit = this.getSurfaceHit(event.clientX, event.clientY);
        const erase = event.ctrlKey || event.metaKey;

        if (this.drag === 'line' && this.lineStart) {
            if (hit) this.updateLinePreview(this.lineStart, hit.point);
            return;
        }

        if (!hit) {
            this.brushRing.visible = false;
            return;
        }
        this.updateBrushRing(hit.point, hit.face?.normal ?? new THREE.Vector3(0, 1, 0), erase);
        if (this.drag === 'scatter' && (event.buttons & 1) !== 0) this.applyScatterBrush(hit.point);
        if (this.drag === 'erase' && (event.buttons & 1) !== 0) this.applyErase(hit.point);
    };

    private handleMouseUp = (event: MouseEvent): void => {
        if (event.button !== 0 || this.drag === 'none') return;
        if (this.drag === 'line' && this.lineStart) {
            const hit = this.getSurfaceHit(event.clientX, event.clientY);
            if (hit) this.placeLine(this.lineStart, hit.point);
            this.linePreview.visible = false;
            this.lineStart = null;
        }
        this.drag = 'none';
        this.history.endAction();
    };

    private onModifierChanged = (event: KeyboardEvent): void => {
        if (!this.brushRing.visible) return;
        const erase = event.ctrlKey || event.metaKey;
        (this.brushRing.material as THREE.LineBasicMaterial).color.setHex(erase ? 0xff5555 : 0x55aaff);
    };

    private getSurfaceHit(clientX: number, clientY: number): THREE.Intersection | null {
        this.mouse.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
        this.raycaster.setFromCamera(this.mouse, this.camera.instance);
        return this.getFirstSurfaceHit(this.raycaster);
    }

    private getFirstSurfaceHit(raycaster: THREE.Raycaster): THREE.Intersection | null {
        const targets = this.scene.getElements().map((element) => element.mesh);
        const hits = raycaster.intersectObjects(targets, false);
        return hits.find((hit) => hit.face !== null) ?? null;
    }

    private raycastDown(x: number, fromY: number, z: number): THREE.Intersection | null {
        const downRay = new THREE.Raycaster(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0), 0, 200);
        return this.getFirstSurfaceHit(downRay);
    }

    private applyScatterBrush(center: THREE.Vector3): void {
        const settings = this.panel.settings;
        const selected = this.panel.selectedAssetIndices;
        if (selected.length === 0) return;
        let added = false;
        for (let attempt = 0; attempt < settings.density; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.sqrt(Math.random()) * settings.radius;
            const x = center.x + Math.cos(angle) * radius;
            const z = center.z + Math.sin(angle) * radius;
            const surfaceHit = this.raycastDown(x, center.y + 50, z);
            if (!surfaceHit || Math.abs(surfaceHit.point.y - center.y) > settings.maxHeightDifference) continue;
            const assetIndex = selected[Math.floor(Math.random() * selected.length)];
            const position: MeshVector3 = { x: surfaceHit.point.x, y: surfaceHit.point.y, z: surfaceHit.point.z };
            if (this.meshes.isTooClose(assetIndex, position, settings.minimumSpacing)) continue;
            this.placeInstance(assetIndex, position);
            added = true;
        }
        if (added) this.meshes.commitChanges();
    }

    private applyErase(center: THREE.Vector3): void {
        if (this.meshes.removeInstancesNear(center, this.panel.settings.radius) > 0) this.meshes.commitChanges();
    }

    private placeLine(start: THREE.Vector3, end: THREE.Vector3): void {
        const settings = this.panel.settings;
        const selected = this.panel.selectedAssetIndices;
        const totalLength = start.distanceTo(end);
        if (selected.length === 0 || totalLength < 0.01) return;

        const direction = end.clone().sub(start).normalize();
        const spacing = Math.max(0.05, settings.lineSpacing);
        let traveled = 0;
        // The line's own facing angle plus the user's Angle offset, in the same degrees
        // convention as RotationY (0deg faces +Z) - shared by every instance along this
        // line instead of each one picking an independent random heading, so a fence or
        // hedge drawn as a line actually reads as one continuous, consistently oriented row.
        const lineFacingDegrees = THREE.MathUtils.radToDeg(Math.atan2(direction.x, direction.z)) + settings.lineAngleOffset;

        let added = false;
        while (traveled <= totalLength) {
            const point = start.clone().addScaledVector(direction, traveled);
            const surfaceHit = this.raycastDown(point.x, point.y + 50, point.z);
            const surfacePoint = surfaceHit ? surfaceHit.point : point;
            const assetIndex = selected[Math.floor(Math.random() * selected.length)];
            this.placeInstance(assetIndex, { x: surfacePoint.x, y: surfacePoint.y, z: surfacePoint.z }, lineFacingDegrees);
            added = true;

            const jitter = 1 + (Math.random() * 2 - 1) * settings.lineSpacingRandomness;
            traveled += spacing * Math.max(0.1, jitter);
        }
        if (added) this.meshes.commitChanges();
    }

    private placeInstance(assetIndex: number, position: MeshVector3, rotationYOverride?: number): void {
        const settings = this.panel.settings;
        const rotationY = rotationYOverride !== undefined
            ? rotationYOverride
            : (settings.randomizeRotationY ? Math.random() * 360 : 0);
        const tilt = settings.randomTiltDegrees;
        const rotationX = tilt > 0 ? (Math.random() * 2 - 1) * tilt : 0;
        const rotationZ = tilt > 0 ? (Math.random() * 2 - 1) * tilt : 0;
        const lowScale = Math.min(settings.minScale, settings.maxScale);
        const highScale = Math.max(settings.minScale, settings.maxScale);
        const scale = lowScale + Math.random() * (highScale - lowScale);

        this.meshes.addInstance(assetIndex, {
            Position: position,
            RotationX: rotationX,
            RotationY: rotationY,
            RotationZ: rotationZ,
            Scale: scale,
            AssetIndex: assetIndex,
        });
    }

    private updateBrushRing(point: THREE.Vector3, normal: THREE.Vector3, erase: boolean): void {
        this.brushRing.visible = this.panel.isVisible && this.panel.settings.enabled && this.panel.settings.mode === 'scatter';
        this.linePreview.visible = false;
        this.brushRing.position.copy(point).addScaledVector(normal, 0.03);
        this.brushRing.scale.setScalar(this.panel.settings.radius);
        this.brushRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal.clone().normalize());
        (this.brushRing.material as THREE.LineBasicMaterial).color.setHex(erase ? 0xff5555 : 0x55aaff);
    }

    private updateLinePreview(start: THREE.Vector3, end: THREE.Vector3): void {
        this.brushRing.visible = false;
        this.linePreview.visible = true;
        this.linePreview.geometry.setFromPoints([
            start.clone().add(new THREE.Vector3(0, 0.05, 0)),
            end.clone().add(new THREE.Vector3(0, 0.05, 0)),
        ]);
    }
}
