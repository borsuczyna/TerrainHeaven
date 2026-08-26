import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import CustomTransformGizmo from '../CustomTransformGizmo';
import { createIcons, icons } from 'lucide';
import { inject, singleton } from 'tsyringe';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import MeshManager from '../MeshManager';
import MeshLibrary from '../MeshLibrary';
import HistoryManager from '../HistoryManager';
import { loadMeshAsset, type LoadedMeshGroup } from '../../mesh/MeshLoader';
import { computeGroundedCenterOffset, measureBounds, type MeshBounds } from '../../mesh/MeshCalibration';

const REFERENCE_HEIGHT = 2;
const REFERENCE_WIDTH = 1;
const REFERENCE_DEPTH = 1;
const MIN_LOG_SCALE = -3;
const MAX_LOG_SCALE = 3;

// Uploaded OBJ/FBX/GLB files carry no reliable "this model is N meters tall" metadata, so
// this gives the user a side-by-side comparison against a known 1x2x1m reference box (a
// rough human-scale stand-in) right after upload, with a scale slider and a pivot-offset
// nudge, instead of them discovering the prop is 100x too large only once it's scattered
// across the terrain. The result (MeshAssetData.BaseScale/PositionOffset) is baked into
// every consumer once - see src/mesh/MeshCalibration.ts.
@singleton()
export default class MeshCalibrationPanel {
    private readonly container: HTMLElement;
    private readonly canvas: HTMLCanvasElement;
    private readonly sizeLabel: HTMLElement;
    private readonly nameLabel: HTMLElement;
    private readonly scaleInput: HTMLInputElement;
    private readonly scaleSlider: HTMLInputElement;
    private readonly offsetInputs: Record<'x' | 'y' | 'z', HTMLInputElement>;
    private readonly missingView: HTMLElement;
    private readonly missingList: HTMLElement;
    private readonly missingFileInput: HTMLInputElement;
    private readonly missingDropZone: HTMLElement;

    private renderer: THREE.WebGLRenderer | null = null;
    private scene: THREE.Scene | null = null;
    private camera: THREE.PerspectiveCamera | null = null;
    private orbitControls: OrbitControls | null = null;
    private transformControls: CustomTransformGizmo | null = null;
    private previewContainer: THREE.Group | null = null;
    private rafHandle: number | null = null;

    private assetIndex = -1;
    private rawGroups: LoadedMeshGroup[] = [];
    private rawBounds: MeshBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, width: 0, height: 0, depth: 0 };
    private loadToken = 0;

    constructor(
        @inject(MeshManager) private readonly meshes: MeshManager,
        @inject(MeshLibrary) private readonly library: MeshLibrary,
        @inject(HistoryManager) private readonly history: HistoryManager,
    ) {
        this.container = document.createElement('div');
        this.container.id = 'mesh-calibration';
        this.container.innerHTML = `
            <div class="mc-dialog">
                <div class="mc-header">
                    <div><span class="mc-eyebrow">Mesh</span><strong data-role="name"></strong><small>Calibrate scale and pivot</small></div>
                    <button type="button" class="mc-close" aria-label="Close"><i data-lucide="x"></i></button>
                </div>
                <div class="mc-missing" data-view="missing">
                    <div class="mc-missing-banner">
                        <i data-lucide="triangle-alert"></i>
                        <div><strong>Missing textures</strong><span>This mesh references texture files that weren't found. Drop them below (you can drop several at once), or skip and use flat colors instead.</span></div>
                    </div>
                    <ul class="mc-missing-list" data-role="missing-list"></ul>
                    <div class="mc-missing-drop" data-role="missing-drop">
                        <i data-lucide="upload"></i>
                        <strong>Drop texture files here</strong>
                        <button type="button" data-action="browse-textures">Choose files</button>
                    </div>
                    <div class="mc-actions">
                        <button type="button" data-action="skip-textures" class="mc-primary">Skip &amp; Continue</button>
                    </div>
                </div>
                <div class="mc-body" data-view="calibrate">
                    <div class="mc-viewport"><canvas data-role="canvas"></canvas></div>
                    <div class="mc-controls">
                        <p class="mc-size" data-role="size"></p>
                        <section>
                            <h3>Scale <span>vs. the 1 x 2 x 1m reference box</span></h3>
                            <div class="mc-scale-row">
                                <input type="range" min="${MIN_LOG_SCALE}" max="${MAX_LOG_SCALE}" step="0.001" data-role="scale-slider">
                                <input type="number" min="0.0001" step="0.01" data-role="scale-input">
                            </div>
                        </section>
                        <section>
                            <h3>Position Offset (m)</h3>
                            <div class="mc-offset-row">
                                <label>X<input type="number" step="0.01" data-role="offset-x"></label>
                                <label>Y<input type="number" step="0.01" data-role="offset-y"></label>
                                <label>Z<input type="number" step="0.01" data-role="offset-z"></label>
                            </div>
                        </section>
                        <div class="mc-actions">
                            <button type="button" data-action="reset">Reset</button>
                            <button type="button" data-action="center">Center Mesh</button>
                            <button type="button" data-action="done" class="mc-primary">Done</button>
                        </div>
                        <p class="mc-help">Drag to orbit, scroll to zoom. Drag the arrows on the model to move it. The box on the left is 1m wide, 2m tall.</p>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(this.container);

        this.canvas = this.container.querySelector('[data-role="canvas"]') as HTMLCanvasElement;
        this.sizeLabel = this.container.querySelector('[data-role="size"]') as HTMLElement;
        this.nameLabel = this.container.querySelector('[data-role="name"]') as HTMLElement;
        this.scaleInput = this.container.querySelector('[data-role="scale-input"]') as HTMLInputElement;
        this.scaleSlider = this.container.querySelector('[data-role="scale-slider"]') as HTMLInputElement;
        this.offsetInputs = {
            x: this.container.querySelector('[data-role="offset-x"]') as HTMLInputElement,
            y: this.container.querySelector('[data-role="offset-y"]') as HTMLInputElement,
            z: this.container.querySelector('[data-role="offset-z"]') as HTMLInputElement,
        };
        this.missingView = this.container.querySelector('[data-view="missing"]') as HTMLElement;
        this.missingList = this.container.querySelector('[data-role="missing-list"]') as HTMLElement;
        this.missingDropZone = this.container.querySelector('[data-role="missing-drop"]') as HTMLElement;
        this.missingFileInput = document.createElement('input');
        this.missingFileInput.type = 'file';
        this.missingFileInput.accept = 'image/*';
        this.missingFileInput.multiple = true;
        this.missingFileInput.hidden = true;
        this.container.appendChild(this.missingFileInput);

        this.container.querySelector('.mc-close')?.addEventListener('click', () => this.close());
        this.container.querySelector('[data-action="done"]')?.addEventListener('click', () => this.close());
        this.container.querySelector('[data-action="reset"]')?.addEventListener('click', () => this.reset());
        this.container.querySelector('[data-action="center"]')?.addEventListener('click', () => this.centerMesh());
        this.container.querySelector('[data-action="skip-textures"]')?.addEventListener('click', () => this.showCalibrateStep());
        this.container.querySelector('[data-action="browse-textures"]')?.addEventListener('click', () => this.missingFileInput.click());
        this.missingFileInput.addEventListener('change', () => {
            void this.handleMissingTextureFiles(this.missingFileInput.files);
            this.missingFileInput.value = '';
        });
        this.missingDropZone.addEventListener('dragover', (event) => {
            if (!event.dataTransfer?.types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            this.missingDropZone.classList.add('drag-over');
        });
        this.missingDropZone.addEventListener('dragleave', () => this.missingDropZone.classList.remove('drag-over'));
        this.missingDropZone.addEventListener('drop', (event) => {
            if (!event.dataTransfer?.files.length) return;
            event.preventDefault();
            this.missingDropZone.classList.remove('drag-over');
            void this.handleMissingTextureFiles(event.dataTransfer.files);
        });

        this.scaleSlider.addEventListener('input', () => {
            this.applyScale(Math.pow(10, Number(this.scaleSlider.value)));
        });
        this.scaleInput.addEventListener('change', () => {
            const parsed = Number(this.scaleInput.value);
            this.applyScale(Number.isFinite(parsed) && parsed > 0 ? parsed : 1);
        });
        (['x', 'y', 'z'] as const).forEach((axis) => {
            this.offsetInputs[axis].addEventListener('change', () => this.applyOffsetFromInputs());
        });
    }

    public open(assetIndex: number): void {
        const asset = this.meshes.assets[assetIndex];
        const libraryAsset = this.library.getAsset(asset?.LibraryPath ?? '');
        if (!asset || !libraryAsset) return;

        this.assetIndex = assetIndex;
        this.nameLabel.textContent = asset.DisplayName;
        this.rawGroups = [];
        this.rawBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, width: 0, height: 0, depth: 0 };
        this.sizeLabel.textContent = 'Loading...';
        this.syncInputs(asset.BaseScale, asset.PositionOffset);

        this.container.classList.add('visible');
        this.showCalibrateStep();
        this.ensureViewport();
        this.setPreviewMesh(null);
        this.applyContainerTransform();
        this.startRenderLoop();

        void this.loadAndCheck(assetIndex);
    }

    public close(): void {
        this.container.classList.remove('visible');
        this.assetIndex = -1;
        this.loadToken++;
        this.stopRenderLoop();
    }

    private async loadAndCheck(assetIndex: number): Promise<void> {
        const asset = this.meshes.assets[assetIndex];
        const libraryAsset = this.library.getAsset(asset?.LibraryPath ?? '');
        if (!asset || !libraryAsset) return;

        const token = ++this.loadToken;
        try {
            const loaded = await loadMeshAsset(libraryAsset);
            if (token !== this.loadToken || this.assetIndex !== assetIndex) return;
            this.rawGroups = loaded.groups;
            this.rawBounds = measureBounds(loaded.groups);
            this.setPreviewMesh(loaded.groups);
            this.updateSizeLabel();
            if (loaded.missingTextures.length > 0) this.showMissingTexturesStep(loaded.missingTextures);
            else this.showCalibrateStep();
        } catch (error) {
            console.warn(`Could not load mesh "${asset.DisplayName}" for calibration:`, error);
            this.sizeLabel.textContent = 'Could not load this mesh.';
        }
    }

    private showMissingTexturesStep(names: string[]): void {
        this.missingView.classList.add('visible');
        this.missingList.innerHTML = '';
        for (const name of names) {
            const item = document.createElement('li');
            item.textContent = name;
            this.missingList.appendChild(item);
        }
        createIcons({ icons });
    }

    private showCalibrateStep(): void {
        this.missingView.classList.remove('visible');
    }

    private async handleMissingTextureFiles(files: FileList | null): Promise<void> {
        const asset = this.meshes.assets[this.assetIndex];
        if (!asset || !files || files.length === 0) return;
        await this.library.addCompanionFiles(asset.LibraryPath, files);
        this.meshes.notifyAssetAvailable(asset.LibraryPath);
        void this.loadAndCheck(this.assetIndex);
    }

    private reset(): void {
        this.applyScale(1);
        this.applyOffset({ x: 0, y: 0, z: 0 });
    }

    private centerMesh(): void {
        if (this.rawGroups.length === 0) return;
        this.history.beginAction('Center Mesh');
        this.applyOffset(computeGroundedCenterOffset(this.rawBounds, this.currentScale()));
        this.history.endAction();
    }

    private applyScale(scale: number): void {
        if (this.assetIndex < 0) return;
        this.history.beginAction('Calibrate Mesh Scale');
        this.meshes.updateCalibration(this.assetIndex, { BaseScale: scale });
        this.history.endAction();
        this.syncInputs(scale, this.currentOffset());
        this.applyContainerTransform();
        this.updateSizeLabel();
    }

    private applyOffsetFromInputs(): void {
        const offset = {
            x: Number(this.offsetInputs.x.value) || 0,
            y: Number(this.offsetInputs.y.value) || 0,
            z: Number(this.offsetInputs.z.value) || 0,
        };
        this.applyOffset(offset);
    }

    private applyOffset(offset: { x: number; y: number; z: number }): void {
        if (this.assetIndex < 0) return;
        this.history.beginAction('Calibrate Mesh Offset');
        this.meshes.updateCalibration(this.assetIndex, { PositionOffset: offset });
        this.history.endAction();
        this.syncInputs(this.currentScale(), offset);
        this.applyContainerTransform();
    }

    private currentScale(): number {
        return this.meshes.assets[this.assetIndex]?.BaseScale ?? 1;
    }

    private currentOffset(): { x: number; y: number; z: number } {
        return this.meshes.assets[this.assetIndex]?.PositionOffset ?? { x: 0, y: 0, z: 0 };
    }

    private syncInputs(scale: number, offset: { x: number; y: number; z: number }): void {
        this.scaleInput.value = String(Math.round(scale * 10000) / 10000);
        this.scaleSlider.value = String(THREE.MathUtils.clamp(Math.log10(scale), MIN_LOG_SCALE, MAX_LOG_SCALE));
        this.offsetInputs.x.value = String(offset.x);
        this.offsetInputs.y.value = String(offset.y);
        this.offsetInputs.z.value = String(offset.z);
    }

    private updateSizeLabel(): void {
        if (this.rawGroups.length === 0) return;
        const scale = this.currentScale();
        const width = this.rawBounds.width * scale;
        const height = this.rawBounds.height * scale;
        const depth = this.rawBounds.depth * scale;
        this.sizeLabel.textContent = `${height.toFixed(2)}m tall (${width.toFixed(2)} x ${depth.toFixed(2)}m footprint)`;
    }

    private applyContainerTransform(): void {
        if (!this.previewContainer) return;
        const offset = this.currentOffset();
        this.previewContainer.position.set(offset.x, offset.y, offset.z);
        this.previewContainer.scale.setScalar(this.currentScale());
    }

    private ensureViewport(): void {
        if (this.renderer) return;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1b1d22);

        this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
        this.camera.position.set(3, 2.4, 3);

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.shadowMap.enabled = false;

        this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbitControls.target.set(0, REFERENCE_HEIGHT / 2, 0);
        this.orbitControls.enableDamping = true;
        this.orbitControls.update();

        this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
        const directional = new THREE.DirectionalLight(0xffffff, 1.2);
        directional.position.set(4, 6, 3);
        this.scene.add(directional);
        this.scene.add(new THREE.GridHelper(10, 20, 0x555a63, 0x33363c));

        const referenceBox = new THREE.Mesh(
            new THREE.BoxGeometry(REFERENCE_WIDTH, REFERENCE_HEIGHT, REFERENCE_DEPTH),
            new THREE.MeshStandardMaterial({ color: 0x4c9eea, transparent: true, opacity: 0.28, roughness: 0.6 }),
        );
        referenceBox.position.set(-1.2, REFERENCE_HEIGHT / 2, 0);
        this.scene.add(referenceBox);
        const referenceEdges = new THREE.LineSegments(
            new THREE.EdgesGeometry(referenceBox.geometry),
            new THREE.LineBasicMaterial({ color: 0x8dc7ff }),
        );
        referenceEdges.position.copy(referenceBox.position);
        this.scene.add(referenceEdges);

        this.previewContainer = new THREE.Group();
        this.scene.add(this.previewContainer);

        // Lets the user drag the model directly into place instead of only typing offset
        // numbers - attached to previewContainer, whose own .position IS the calibration
        // PositionOffset (see applyContainerTransform), so a drag maps onto it 1:1.
        this.transformControls = new CustomTransformGizmo(this.camera, this.renderer.domElement);
        this.transformControls.setMode('translate');
        this.transformControls.setSize(0.9);
        this.transformControls.attach(this.previewContainer);
        this.scene.add(this.transformControls.getHelper());
        // This preview has its own isolated renderer/scene/camera, not routed through
        // SelectionManager, so (unlike GizmoManager/MeshInstanceSelector) it needs its own
        // explicit call into tryStartDrag - see that method's own note on why it isn't a
        // DOM listener owned by the gizmo itself.
        this.renderer.domElement.addEventListener('mousedown', (e) => {
            this.transformControls?.tryStartDrag(e);
        });
        this.transformControls.addEventListener('dragging-changed', (event) => {
            if (this.orbitControls) this.orbitControls.enabled = !event.value;
            if (event.value) {
                this.history.beginAction('Calibrate Mesh Offset');
                return;
            }
            const position = this.previewContainer!.position;
            const offset = { x: position.x, y: position.y, z: position.z };
            if (this.assetIndex >= 0) this.meshes.updateCalibration(this.assetIndex, { PositionOffset: offset });
            this.syncInputs(this.currentScale(), offset);
            this.history.endAction();
        });

        this.resizeViewport();
    }

    private resizeViewport(): void {
        if (!this.renderer || !this.camera) return;
        const size = this.canvas.clientWidth || 340;
        this.renderer.setSize(size, size, false);
        this.camera.aspect = 1;
        this.camera.updateProjectionMatrix();
    }

    private setPreviewMesh(groups: LoadedMeshGroup[] | null): void {
        if (!this.previewContainer) return;
        for (const child of [...this.previewContainer.children]) {
            this.previewContainer.remove(child);
            if (child instanceof THREE.Mesh) {
                child.geometry.dispose();
                (child.material as THREE.Material).dispose();
            }
        }
        if (!groups) return;

        for (const group of groups) {
            if (group.positions.length === 0) continue;
            const raw = new THREE.BufferGeometry();
            raw.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
            raw.setAttribute('uv', new THREE.Float32BufferAttribute(group.uvs, 2));
            const merged = mergeVertices(raw) as THREE.BufferGeometry;
            merged.computeVertexNormals();
            raw.dispose();
            const material = new THREE.MeshStandardMaterial({
                map: group.texture,
                color: group.texture ? 0xffffff : new THREE.Color(group.color.r, group.color.g, group.color.b),
                roughness: 0.9,
                // Matches MeshManager.buildMaterial's alpha-cutout handling so this preview
                // doesn't mislead the user about how the placed prop will actually render.
                alphaTest: group.texture ? 0.5 : 0,
            });
            this.previewContainer.add(new THREE.Mesh(merged, material));
        }
    }

    private startRenderLoop(): void {
        this.stopRenderLoop();
        const tick = (): void => {
            this.orbitControls?.update();
            if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
            this.rafHandle = requestAnimationFrame(tick);
        };
        this.resizeViewport();
        tick();
        createIcons({ icons });
    }

    private stopRenderLoop(): void {
        if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
        this.rafHandle = null;
    }
}
