import * as THREE from 'three';
import { inject, singleton } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import HistoryManager from '../HistoryManager';
import FoliageManager from '../FoliageManager';
import FoliagePanel from '../panels/FoliagePanel';

@singleton()
export default class FoliageTool implements Tool {
    public readonly name = 'foliage';
    public readonly blocksCamera = true;

    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();
    private readonly brushRing: THREE.LineLoop;
    private painting = false;
    private erase = false;

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) private readonly camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(FoliageManager) private readonly foliage: FoliageManager,
        @inject(FoliagePanel) private readonly panel: FoliagePanel,
    ) {
        const points: THREE.Vector3[] = [];
        for (let index = 0; index < 64; index++) {
            const angle = index / 64 * Math.PI * 2;
            points.push(new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
        }
        this.brushRing = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color: 0x55ee77, depthTest: false, transparent: true, opacity: 0.95 }),
        );
        this.brushRing.renderOrder = 1000;
        this.brushRing.visible = false;
        this.scene.instance.add(this.brushRing);
        window.addEventListener('foliage-panel-closed', () => {
            if (this.panel.isVisible) return;
            this.brushRing.visible = false;
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
        if (this.painting) this.history.endAction();
        this.painting = false;
        this.brushRing.visible = false;
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
        this.painting = true;
        this.erase = event.ctrlKey || event.metaKey;
        this.history.beginAction(this.erase ? 'Erase Foliage' : 'Paint Foliage');
        this.applyBrush(hit.point, this.erase);
        event.preventDefault();
        return true;
    }

    private onMouseMove = (event: MouseEvent): void => {
        if ((event.target as HTMLElement).tagName !== 'CANVAS') {
            if (!this.painting) this.brushRing.visible = false;
            return;
        }
        const hit = this.getSurfaceHit(event.clientX, event.clientY);
        if (!hit) {
            this.brushRing.visible = false;
            return;
        }
        this.updateBrushRing(hit.point, hit.face?.normal ?? new THREE.Vector3(0, 1, 0), event.ctrlKey || event.metaKey);
        if (this.painting && (event.buttons & 1) !== 0) this.applyBrush(hit.point, this.erase || event.ctrlKey || event.metaKey);
    };

    private handleMouseUp = (event: MouseEvent): void => {
        if (event.button !== 0 || !this.painting) return;
        this.painting = false;
        this.history.endAction();
    };

    private onModifierChanged = (event: KeyboardEvent): void => {
        if (!this.brushRing.visible) return;
        const erase = event.ctrlKey || event.metaKey;
        (this.brushRing.material as THREE.LineBasicMaterial).color.setHex(erase ? 0xff5555 : 0x55ee77);
    };

    private getSurfaceHit(clientX: number, clientY: number): THREE.Intersection | null {
        this.mouse.set(clientX / window.innerWidth * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
        this.raycaster.setFromCamera(this.mouse, this.camera.instance);
        return this.getFirstSurfaceHit(this.raycaster);
    }

    private getFirstSurfaceHit(raycaster: THREE.Raycaster): THREE.Intersection | null {
        const targets = this.scene.getElements().map((element) => element.mesh);
        const hits = raycaster.intersectObjects(targets, true);
        return hits.find((hit) => !hit.object.userData.worldNode) ?? null;
    }

    private applyBrush(center: THREE.Vector3, erase: boolean): void {
        const settings = this.panel.settings;
        if (erase) {
            if (this.foliage.removeInstancesNear(center, settings.radius) > 0) this.foliage.commitChanges();
            return;
        }
        const selectedTypes = this.panel.selectedTypeIndices;
        if (selectedTypes.length === 0) return;
        let added = false;
        for (let attempt = 0; attempt < settings.density; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.sqrt(Math.random()) * settings.radius;
            const x = center.x + Math.cos(angle) * radius;
            const z = center.z + Math.sin(angle) * radius;
            const downRay = new THREE.Raycaster(
                new THREE.Vector3(x, center.y + 50, z),
                new THREE.Vector3(0, -1, 0),
                0,
                100,
            );
            const surfaceHit = this.getFirstSurfaceHit(downRay);
            if (!surfaceHit || Math.abs(surfaceHit.point.y - center.y) > settings.maxHeightDifference) continue;
            const typeIndex = selectedTypes[Math.floor(Math.random() * selectedTypes.length)];
            const position = { x: surfaceHit.point.x, y: surfaceHit.point.y, z: surfaceHit.point.z };
            if (this.foliage.isTooClose(typeIndex, position, settings.minimumSpacing)) continue;
            this.foliage.addInstance(typeIndex, {
                Position: position,
                RotationY: Math.random() * 360,
                ScaleT: Math.random(),
                ColorT: Math.random(),
                TypeIndex: typeIndex,
            });
            added = true;
        }
        if (added) this.foliage.commitChanges();
    }

    private updateBrushRing(point: THREE.Vector3, normal: THREE.Vector3, erase: boolean): void {
        this.brushRing.visible = this.panel.isVisible && this.panel.settings.enabled;
        this.brushRing.position.copy(point).addScaledVector(normal, 0.03);
        this.brushRing.scale.setScalar(this.panel.settings.radius);
        this.brushRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal.clone().normalize());
        (this.brushRing.material as THREE.LineBasicMaterial).color.setHex(erase ? 0xff5555 : 0x55ee77);
    }
}
