import * as THREE from 'three';
import { inject, singleton } from 'tsyringe';
import type { Tool } from '../ToolManager';
import SceneManager from '../SceneManager';
import Camera from '../Camera';
import HistoryManager from '../HistoryManager';
import TextureLibrary from '../TextureLibrary';
import TexturePaintPanel from '../panels/TexturePaintPanel';
import Terrain from '../../elements/Terrain';

@singleton()
export default class TexturePaintTool implements Tool {
    public readonly name = 'terrain-texture-paint';
    public readonly blocksCamera = true;
    private readonly raycaster = new THREE.Raycaster();
    private readonly mouse = new THREE.Vector2();
    private readonly preview: THREE.Mesh;
    private painting = false;
    private activeTerrain: Terrain | null = null;
    private readonly lastDab = new THREE.Vector3();
    private strokeSeed = 0;
    private previewShape: 'circle' | 'square' = 'circle';

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) private readonly camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(TextureLibrary) private readonly library: TextureLibrary,
        @inject(TexturePaintPanel) private readonly panel: TexturePaintPanel,
    ) {
        const material = new THREE.MeshBasicMaterial({ color: 0x55b8ff, transparent: true, opacity: 0.28, depthTest: false, side: THREE.DoubleSide });
        material.onBeforeCompile = (shader) => {
            shader.uniforms.brushHardness = { value: 0.45 };
            material.userData.shader = shader;
            shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float brushHardness;')
                .replace('#include <dithering_fragment>', `
                    float d = length(vUv - vec2(0.5)) * 2.0;
                    float alpha = 1.0 - smoothstep(brushHardness, 1.0, d);
                    gl_FragColor.a *= alpha * 0.65;
                    #include <dithering_fragment>`);
        };
        this.preview = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        this.preview.renderOrder = 999;
        this.preview.visible = false;
        this.scene.instance.add(this.preview);
        this.panel.onClear = () => this.clear();
        this.panel.onLayerTextureChanged = (index, path) => void this.setLayer(index, path);
        this.panel.onLayerTilingChanged = (index, tiling) => { this.activeTerrain?.setTextureLayerTiling(index, tiling); };
        window.addEventListener('texture-paint-panel-closed', () => { this.preview.visible = false; });
    }

    public activate(): void { this.panel.show(); window.addEventListener('mousemove', this.onMouseMove); window.addEventListener('mouseup', this.onMouseUp); }
    public deactivate(): void {
        if (this.painting) this.history.endAction();
        this.painting = false; this.preview.visible = false; this.panel.hide();
        window.removeEventListener('mousemove', this.onMouseMove); window.removeEventListener('mouseup', this.onMouseUp);
    }
    public onMouseDown(event: MouseEvent): boolean {
        if (event.button !== 0 || (event.target as HTMLElement).tagName !== 'CANVAS') return false;
        const result = this.getHit(event.clientX, event.clientY);
        if (!result) return true;
        this.painting = true; this.activeTerrain = result.terrain; this.lastDab.copy(result.hit.point); this.strokeSeed++;
        this.panel.syncTerrain(result.terrain.textureLayers);
        this.history.beginAction(`Paint Terrain Texture ${this.panel.settings.layer + 1}`);
        this.paint(result.terrain, result.hit.point);
        event.preventDefault(); return true;
    }
    public onMouseUp = (event: MouseEvent): void => { if (event.button === 0 && this.painting) { this.painting = false; this.history.endAction(); } };
    private onMouseMove = (event: MouseEvent): void => {
        if ((event.target as HTMLElement).tagName !== 'CANVAS') { if (!this.painting) this.preview.visible = false; return; }
        const result = this.getHit(event.clientX, event.clientY);
        if (!result) { this.preview.visible = false; return; }
        if (this.activeTerrain !== result.terrain) this.panel.syncTerrain(result.terrain.textureLayers);
        this.activeTerrain = result.terrain;
        this.updatePreview(result.hit);
        if (!this.painting || !(event.buttons & 1)) return;
        const spacing = Math.max(0.05, this.panel.settings.radius * this.panel.settings.spacing);
        const delta = result.hit.point.clone().sub(this.lastDab); delta.y = 0;
        let distance = delta.length(); if (distance < spacing) return;
        const direction = delta.normalize();
        while (distance >= spacing) { this.lastDab.addScaledVector(direction, spacing); this.paint(result.terrain, this.lastDab); distance -= spacing; }
    };
    private paint(terrain: Terrain, point: THREE.Vector3): void {
        const s = this.panel.settings;
        const affected = this.scene.getElements()
            .filter((element): element is Terrain => element instanceof Terrain)
            .filter((candidate) => candidate.intersectsPaintBrush(point, s.radius));
        for (const candidate of affected) {
            // A stroke crossing a tile seam must resolve the same channel to the same
            // texture on both sides. Copy only the active slot, keeping other tile-local
            // layer choices intact.
            if (candidate !== terrain) {
                const sourceLayer = terrain.textureLayers[s.layer];
                candidate.setTexturePaintLayer(s.layer, sourceLayer.texturePath, sourceLayer.texture);
                candidate.setTextureLayerTiling(s.layer, sourceLayer.tiling);
            }
            candidate.paintTexture(point, s.radius, s.layer, s.opacity, s.hardness, s.shape, THREE.MathUtils.degToRad(s.rotation), this.strokeSeed);
        }
    }
    private getHit(x: number, y: number): { terrain: Terrain; hit: THREE.Intersection } | null {
        this.mouse.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); this.raycaster.setFromCamera(this.mouse, this.camera.instance);
        const terrains = this.scene.getElements().filter((element): element is Terrain => element instanceof Terrain);
        const hit = this.raycaster.intersectObjects(terrains.map((terrain) => terrain.mesh), false)[0];
        const terrain = hit?.object.userData.worldElement;
        return hit && terrain instanceof Terrain ? { terrain, hit } : null;
    }
    private updatePreview(hit: THREE.Intersection): void {
        const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? new THREE.Vector3(0, 1, 0);
        const s = this.panel.settings; this.preview.visible = true;
        this.preview.position.copy(hit.point).addScaledVector(normal, 0.045); this.preview.scale.setScalar(s.radius);
        this.preview.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.normalize()); this.preview.rotateZ(THREE.MathUtils.degToRad(s.rotation));
        const shader = (this.preview.material as THREE.Material).userData.shader; if (shader) shader.uniforms.brushHardness.value = s.shape === 'hard-round' ? 0.98 : s.hardness;
        const shape = s.shape === 'square' ? 'square' : 'circle';
        if (shape !== this.previewShape) {
            this.preview.geometry.dispose();
            this.preview.geometry = shape === 'square' ? new THREE.PlaneGeometry(2, 2) : new THREE.CircleGeometry(1, 64);
            this.previewShape = shape;
        }
    }
    private async setLayer(index: number, path: string): Promise<void> {
        if (!this.activeTerrain) return;
        const texture = path ? await this.library.loadTexture(path) : null;
        this.activeTerrain.setTexturePaintLayer(index, path, texture);
    }
    private clear(): void { if (!this.activeTerrain) return; this.history.beginAction('Clear Terrain Texture Paint'); this.activeTerrain.clearTexturePaint(); this.history.endAction(); }
}
