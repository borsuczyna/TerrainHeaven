import * as THREE from 'three';
import { inject, singleton } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import HistoryManager from '../HistoryManager';
import HeightPaintPanel from '../panels/HeightPaintPanel';
import Terrain from '../../elements/Terrain';

interface TerrainHit {
    terrain: Terrain;
    hit: THREE.Intersection;
}

@singleton()
export default class HeightPaintTool implements Tool {
    public readonly name = 'terrain-height-paint';
    public readonly blocksCamera = true;

    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();
    private readonly brushRing: THREE.LineLoop;
    private painting = false;
    private activeTerrain: Terrain | null = null;
    private lastDab = new THREE.Vector3();

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) private readonly camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(HeightPaintPanel) private readonly panel: HeightPaintPanel,
    ) {
        const points: THREE.Vector3[] = [];
        for (let index = 0; index < 64; index++) {
            const angle = index / 64 * Math.PI * 2;
            points.push(new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
        }
        this.brushRing = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color: 0x67d986, depthTest: false, transparent: true, opacity: 0.95 }),
        );
        this.brushRing.renderOrder = 1000;
        this.brushRing.visible = false;
        this.scene.instance.add(this.brushRing);
        this.panel.onClear = () => this.clearActiveTerrain();
        window.addEventListener('height-paint-panel-closed', () => {
            this.brushRing.visible = false;
        });
    }

    public activate(): void {
        this.panel.show();
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
        window.addEventListener('keydown', this.onModifierChanged);
        window.addEventListener('keyup', this.onModifierChanged);
    }

    public deactivate(): void {
        if (this.painting) this.history.endAction();
        this.painting = false;
        this.brushRing.visible = false;
        this.panel.hide();
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
        window.removeEventListener('keydown', this.onModifierChanged);
        window.removeEventListener('keyup', this.onModifierChanged);
    }

    public onMouseDown(event: MouseEvent): boolean {
        if (event.button !== 0 || (event.target as HTMLElement).tagName !== 'CANVAS') return false;
        if (!this.panel.isVisible) return true;
        const result = this.getTerrainHit(event.clientX, event.clientY);
        if (!result) return true;
        this.painting = true;
        this.activeTerrain = result.terrain;
        this.lastDab.copy(result.hit.point);
        this.history.beginAction(this.getDirection(event.ctrlKey || event.metaKey) > 0 ? 'Raise Terrain' : 'Lower Terrain');
        this.applyDab(result.terrain, result.hit.point, event.ctrlKey || event.metaKey);
        event.preventDefault();
        return true;
    }

    private onMouseMove = (event: MouseEvent): void => {
        if ((event.target as HTMLElement).tagName !== 'CANVAS') {
            if (!this.painting) this.brushRing.visible = false;
            return;
        }
        const result = this.getTerrainHit(event.clientX, event.clientY);
        if (!result) {
            this.brushRing.visible = false;
            return;
        }
        if (this.painting && this.activeTerrain && result.terrain !== this.activeTerrain) return;
        this.activeTerrain = result.terrain;
        this.updateBrushRing(result.hit, event.ctrlKey || event.metaKey);
        if (!this.painting || (event.buttons & 1) === 0) return;

        const spacing = Math.max(0.1, this.panel.settings.radius * 0.15);
        const delta = result.hit.point.clone().sub(this.lastDab);
        delta.y = 0;
        let distance = delta.length();
        if (distance < spacing) return;
        const direction = delta.normalize();
        let changed = false;
        while (distance >= spacing) {
            this.lastDab.addScaledVector(direction, spacing);
            changed = result.terrain.paintHeight(
                this.lastDab,
                this.panel.settings.radius,
                this.panel.settings.strength * this.getDirection(event.ctrlKey || event.metaKey),
            ) || changed;
            distance -= spacing;
        }
        if (changed) result.terrain.update();
    };

    private onMouseUp = (event: MouseEvent): void => {
        if (event.button !== 0 || !this.painting) return;
        this.painting = false;
        this.history.endAction();
    };

    private onModifierChanged = (event: KeyboardEvent): void => {
        if (!this.brushRing.visible) return;
        this.updateRingColor(event.ctrlKey || event.metaKey);
    };

    private applyDab(terrain: Terrain, point: THREE.Vector3, invert: boolean): void {
        if (terrain.paintHeight(point, this.panel.settings.radius, this.panel.settings.strength * this.getDirection(invert))) {
            terrain.update();
        }
    }

    private getDirection(invert: boolean): number {
        const direction = this.panel.settings.mode === 'raise' ? 1 : -1;
        return invert ? -direction : direction;
    }

    private getTerrainHit(clientX: number, clientY: number): TerrainHit | null {
        this.mouse.set(clientX / window.innerWidth * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
        this.raycaster.setFromCamera(this.mouse, this.camera.instance);
        const terrains = this.scene.getElements().filter((element): element is Terrain => element instanceof Terrain);
        const hit = this.raycaster.intersectObjects(terrains.map((terrain) => terrain.mesh), false)
            .find((candidate) => candidate.face !== null);
        if (!hit) return null;
        const terrain = hit.object.userData.worldElement;
        return terrain instanceof Terrain ? { terrain, hit } : null;
    }

    private updateBrushRing(hit: THREE.Intersection, invert: boolean): void {
        const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? new THREE.Vector3(0, 1, 0);
        this.brushRing.visible = this.panel.isVisible;
        this.brushRing.position.copy(hit.point).addScaledVector(normal, 0.04);
        this.brushRing.scale.setScalar(this.panel.settings.radius);
        this.brushRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal.normalize());
        this.updateRingColor(invert);
    }

    private updateRingColor(invert: boolean): void {
        const raise = this.getDirection(invert) > 0;
        (this.brushRing.material as THREE.LineBasicMaterial).color.setHex(raise ? 0x67d986 : 0xff6d6d);
    }

    private clearActiveTerrain(): void {
        if (!this.activeTerrain) return;
        this.history.beginAction('Clear Painted Terrain Height');
        this.activeTerrain.clearPaintedHeight();
        this.history.endAction();
    }
}
