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
    private lastClickedTerrain: Terrain | null = null;
    private copiedLayers: { texturePath: string; tiling: number }[] | null = null;
    private readonly lastDab = new THREE.Vector3();
    private strokeSeed = 0;

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) private readonly camera: Camera,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(TextureLibrary) private readonly library: TextureLibrary,
        @inject(TexturePaintPanel) private readonly panel: TexturePaintPanel,
    ) {
        // A self-contained shader avoids depending on MeshBasicMaterial's optional UV
        // defines. The previous onBeforeCompile patch referenced vUv while USE_UV was
        // disabled, which is what caused the fragment shader validation failure.
        const material = new THREE.ShaderMaterial({
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
            uniforms: {
                brushColor: { value: new THREE.Color(0x4ab7ff) },
                brushHardness: { value: 0.45 },
                brushShape: { value: 0 },
                brushSeed: { value: 0 },
            },
            vertexShader: `
                varying vec2 vBrushUv;
                void main() {
                    vBrushUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                varying vec2 vBrushUv;
                uniform vec3 brushColor;
                uniform float brushHardness;
                uniform float brushShape;
                uniform float brushSeed;
                float hash(vec2 p) {
                    return fract(sin(dot(p + brushSeed, vec2(127.1, 311.7))) * 43758.5453);
                }
                void main() {
                    vec2 centered = (vBrushUv - 0.5) * 2.0;
                    float distanceToEdge = brushShape > 2.5 && brushShape < 4.5
                        ? max(abs(centered.x), abs(centered.y))
                        : length(centered);
                    if (distanceToEdge > 1.0) discard;
                    float core = 1.0 - smoothstep(brushHardness, 1.0, distanceToEdge);
                    float noise = hash(floor(vBrushUv * 22.0));
                    if (brushShape > 4.5 && brushShape < 5.5) core *= 0.35 + noise * 0.65;
                    if (brushShape > 5.5 && brushShape < 6.5) core *= noise > 0.58 ? 1.0 : 0.08;
                    if (brushShape > 6.5) core *= 0.18 + abs(sin((centered.x + centered.y) * 12.0 + noise * 2.5)) * 0.82;
                    float outline = 1.0 - smoothstep(0.925, 1.0, distanceToEdge);
                    outline = max(0.0, 1.0 - outline);
                    float alpha = max(core * 0.24, outline * 0.9);
                    gl_FragColor = vec4(brushColor, alpha);
                }
            `,
        });
        this.preview = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        this.preview.renderOrder = 999;
        this.preview.visible = false;
        this.scene.instance.add(this.preview);
        this.panel.onClear = () => this.clear();
        this.panel.onLayerTextureChanged = (index, path) => void this.setLayer(index, path);
        this.panel.onLayerTilingChanged = (index, tiling) => this.setLayerTiling(index, tiling);
        this.panel.onCopyLayers = () => this.copyLayers();
        this.panel.onPasteLayers = () => void this.pasteLayers();
        window.addEventListener('texture-paint-panel-closed', () => { this.preview.visible = false; });
        window.addEventListener('history-restored', () => {
            this.lastClickedTerrain = null;
            this.painting = false;
            this.preview.visible = false;
            this.panel.setTerrainContext(false, this.copiedLayers !== null);
        });
    }

    public activate(): void {
        if (this.lastClickedTerrain && !this.getTerrains().includes(this.lastClickedTerrain)) this.lastClickedTerrain = null;
        if (this.lastClickedTerrain) this.panel.syncTerrain(this.lastClickedTerrain.textureLayers);
        this.panel.setTerrainContext(this.lastClickedTerrain !== null, this.copiedLayers !== null);
        this.panel.show();
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
    }
    public deactivate(): void {
        if (this.painting) this.history.endAction();
        this.painting = false; this.preview.visible = false; this.panel.hide();
        window.removeEventListener('mousemove', this.onMouseMove); window.removeEventListener('mouseup', this.onMouseUp);
    }
    public onMouseDown(event: MouseEvent): boolean {
        if (event.button !== 0 || (event.target as HTMLElement).tagName !== 'CANVAS') return false;
        const result = this.getHit(event.clientX, event.clientY);
        if (!result) return true;
        this.lastClickedTerrain = result.terrain;
        this.panel.syncTerrain(result.terrain.textureLayers);
        this.panel.setTerrainContext(true, this.copiedLayers !== null);
        if (!this.panel.canPaint) { event.preventDefault(); return true; }
        this.painting = true; this.lastDab.copy(result.hit.point); this.strokeSeed++;
        this.history.beginAction(`Paint Terrain Texture ${this.panel.settings.layer + 1}`);
        this.paint(result.terrain, result.hit.point);
        event.preventDefault(); return true;
    }
    public onMouseUp = (event: MouseEvent): void => { if (event.button === 0 && this.painting) { this.painting = false; this.history.endAction(); } };
    private onMouseMove = (event: MouseEvent): void => {
        if ((event.target as HTMLElement).tagName !== 'CANVAS') { if (!this.painting) this.preview.visible = false; return; }
        const result = this.getHit(event.clientX, event.clientY);
        if (!result) { this.preview.visible = false; return; }
        if (!this.panel.canPaint) { this.preview.visible = false; return; }
        this.updatePreview(result.hit);
        if (!this.painting || !(event.buttons & 1) || !this.lastClickedTerrain) return;
        const spacing = Math.max(0.05, this.panel.settings.radius * this.panel.settings.spacing);
        const delta = result.hit.point.clone().sub(this.lastDab); delta.y = 0;
        let distance = delta.length(); if (distance < spacing) return;
        const direction = delta.normalize();
        while (distance >= spacing) { this.lastDab.addScaledVector(direction, spacing); this.paint(this.lastClickedTerrain, this.lastDab); distance -= spacing; }
    };
    private paint(terrain: Terrain, point: THREE.Vector3): void {
        const s = this.panel.settings;
        // Empty secondary slots use the white shader fallback. Ignoring them avoids
        // accidentally painting a white layer before the requested texture is loaded.
        if (s.layer > 0 && !terrain.textureLayers[s.layer]?.texture) return;
        terrain.paintTexture(point, s.radius, s.layer, s.opacity, s.hardness, s.shape, THREE.MathUtils.degToRad(s.rotation), this.strokeSeed);
    }
    private getHit(x: number, y: number): { terrain: Terrain; hit: THREE.Intersection } | null {
        this.mouse.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); this.raycaster.setFromCamera(this.mouse, this.camera.instance);
        const terrains = this.getTerrains();
        const hit = this.raycaster.intersectObjects(terrains.map((terrain) => terrain.mesh), false)[0];
        const terrain = hit?.object.userData.worldElement;
        return hit && terrain instanceof Terrain ? { terrain, hit } : null;
    }
    private updatePreview(hit: THREE.Intersection): void {
        const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? new THREE.Vector3(0, 1, 0);
        const s = this.panel.settings; this.preview.visible = true;
        this.preview.position.copy(hit.point).addScaledVector(normal, 0.045); this.preview.scale.setScalar(s.radius);
        this.preview.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.normalize()); this.preview.rotateZ(THREE.MathUtils.degToRad(s.rotation));
        const material = this.preview.material as THREE.ShaderMaterial;
        material.uniforms.brushHardness.value = s.shape === 'hard-round' || s.shape === 'hard-square'
            ? 0.98 : s.shape === 'medium-round' ? Math.max(0.45, s.hardness) : s.hardness;
        material.uniforms.brushShape.value = {
            'soft-round': 0, 'medium-round': 1, 'hard-round': 2,
            'soft-square': 3, 'hard-square': 4, noise: 5, speckle: 6, ridge: 7,
        }[s.shape];
        material.uniforms.brushSeed.value = this.strokeSeed;
    }
    private async setLayer(index: number, path: string): Promise<void> {
        const target = this.lastClickedTerrain;
        if (!target) return;
        const texture = path ? await this.library.loadTexture(path) : null;
        if (!this.getTerrains().includes(target)) return;
        this.history.beginAction('Change Terrain Texture Layer');
        target.setTexturePaintLayer(index, path, texture);
        this.history.endAction();
    }
    private setLayerTiling(index: number, tiling: number): void {
        if (!this.lastClickedTerrain) return;
        this.history.beginAction('Change Terrain Texture Tiling');
        this.lastClickedTerrain.setTextureLayerTiling(index, tiling);
        this.history.endAction();
    }
    private copyLayers(): void {
        if (!this.lastClickedTerrain) return;
        this.copiedLayers = this.lastClickedTerrain.textureLayers.map(({ texturePath, tiling }) => ({ texturePath, tiling }));
        this.panel.setTerrainContext(true, true);
    }
    private async pasteLayers(): Promise<void> {
        const target = this.lastClickedTerrain;
        if (!target || !this.copiedLayers) return;
        const layers = this.copiedLayers.map((layer) => ({ ...layer }));
        const textures = await Promise.all(layers.map((layer) => layer.texturePath ? this.library.loadTexture(layer.texturePath) : null));
        if (!this.getTerrains().includes(target)) return;
        this.history.beginAction('Paste Terrain Layer Preset');
        layers.forEach((layer, index) => {
            target.setTexturePaintLayer(index, layer.texturePath, textures[index]);
            target.setTextureLayerTiling(index, layer.tiling);
        });
        this.history.endAction();
        if (this.lastClickedTerrain === target) this.panel.syncTerrain(target.textureLayers);
    }
    private clear(): void { if (!this.lastClickedTerrain) return; this.history.beginAction('Clear Terrain Texture Paint'); this.lastClickedTerrain.clearTexturePaint(); this.history.endAction(); }
    private getTerrains(): Terrain[] {
        return this.scene.getElements().filter((element): element is Terrain => element instanceof Terrain);
    }
}
