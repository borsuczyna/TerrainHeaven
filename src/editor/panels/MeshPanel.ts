import { createIcons, icons } from 'lucide';
import { inject, singleton } from 'tsyringe';
import MeshManager from '../MeshManager';
import MeshLibrary from '../MeshLibrary';
import HistoryManager from '../HistoryManager';
import MeshCalibrationPanel from './MeshCalibrationPanel';
import { createMeshAsset } from '../../mesh/MeshData';

export type MeshPlacementMode = 'scatter' | 'line';

export interface MeshBrushSettings {
    enabled: boolean;
    mode: MeshPlacementMode;
    radius: number;
    density: number;
    minimumSpacing: number;
    maxHeightDifference: number;
    randomizeRotationY: boolean;
    randomTiltDegrees: number;
    minScale: number;
    maxScale: number;
    lineSpacing: number;
    lineSpacingRandomness: number;
    lineAngleOffset: number;
}

type PanelTab = 'library' | 'place';

@singleton()
export default class MeshPanel {
    public readonly settings: MeshBrushSettings = {
        enabled: true,
        mode: 'scatter',
        radius: 3,
        density: 8,
        minimumSpacing: 1,
        maxHeightDifference: 2,
        randomizeRotationY: true,
        randomTiltDegrees: 0,
        minScale: 0.85,
        maxScale: 1.15,
        lineSpacing: 2,
        lineSpacingRandomness: 0.15,
        lineAngleOffset: 0,
    };

    private readonly selectedAssets = new Set<number>();
    private readonly container: HTMLElement;
    private readonly assetList: HTMLElement;
    private readonly paintAssetList: HTMLElement;
    private readonly fileInput: HTMLInputElement;
    private visible = false;
    private activeTab: PanelTab = 'library';

    constructor(
        @inject(MeshManager) private readonly meshes: MeshManager,
        @inject(MeshLibrary) private readonly library: MeshLibrary,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(MeshCalibrationPanel) private readonly calibration: MeshCalibrationPanel,
    ) {
        this.container = document.createElement('aside');
        this.container.id = 'mesh-panel';
        this.container.innerHTML = `
            <div class="mesh-header">
                <div><span class="mesh-eyebrow">World</span><strong>Mesh Props</strong><small>Place and scatter mesh assets</small></div>
                <button type="button" class="mesh-close" aria-label="Close mesh panel"><i data-lucide="x"></i></button>
            </div>
            <div class="mesh-tabs" role="tablist">
                <button type="button" data-tab="library" class="active"><i data-lucide="boxes"></i> Library</button>
                <button type="button" data-tab="place"><i data-lucide="paintbrush"></i> Place</button>
            </div>
            <div class="mesh-body">
                <div class="mesh-tab-view active" data-view="library">
                    <div class="mesh-drop-zone" data-role="drop-zone">
                        <i data-lucide="upload"></i>
                        <strong>Drop a mesh here</strong>
                        <span>OBJ (+ .mtl/textures), FBX or GLB - select every file for one prop at once</span>
                        <button type="button" data-action="browse">Choose files</button>
                    </div>
                    <div class="mesh-assets" data-role="asset-list"></div>
                </div>
                <div class="mesh-tab-view" data-view="place">
                    <label class="mesh-toggle"><input type="checkbox" data-setting="enabled" checked><span>Enable Placing</span></label>
                    <section class="mesh-section">
                        <h3>Mode</h3>
                        <div class="mesh-mode-switch">
                            <button type="button" data-mode="scatter" class="active"><i data-lucide="spray-can"></i> Scatter Brush</button>
                            <button type="button" data-mode="line"><i data-lucide="minus"></i> Line</button>
                        </div>
                    </section>
                    <section class="mesh-section" data-role="scatter-settings">
                        <h3>Brush</h3>
                        <label><span>Brush Radius</span><input type="number" min="0.2" max="40" step="0.1" data-setting="radius"></label>
                        <label><span>Density</span><input type="number" min="1" max="60" step="1" data-setting="density"></label>
                        <label><span>Minimum Spacing</span><input type="number" min="0.05" max="20" step="0.05" data-setting="minimumSpacing"></label>
                        <label><span>Max Height Difference</span><input type="number" min="0" max="20" step="0.1" data-setting="maxHeightDifference"></label>
                    </section>
                    <section class="mesh-section" data-role="line-settings">
                        <h3>Line <span>Angle overrides random Y rotation</span></h3>
                        <label><span>Spacing</span><input type="number" min="0.1" max="40" step="0.1" data-setting="lineSpacing"></label>
                        <label><span>Spacing Randomness</span><input type="number" min="0" max="1" step="0.01" data-setting="lineSpacingRandomness"></label>
                        <label><span>Angle (deg)</span><input type="number" min="-180" max="180" step="1" data-setting="lineAngleOffset"></label>
                    </section>
                    <section class="mesh-section">
                        <h3>Random Rotation &amp; Scale</h3>
                        <label class="mesh-check"><span>Random Y Rotation</span><input type="checkbox" data-setting="randomizeRotationY"></label>
                        <label><span>Random Tilt (deg)</span><input type="number" min="0" max="45" step="1" data-setting="randomTiltDegrees"></label>
                        <label><span>Min Scale</span><input type="number" min="0.05" max="20" step="0.05" data-setting="minScale"></label>
                        <label><span>Max Scale</span><input type="number" min="0.05" max="20" step="0.05" data-setting="maxScale"></label>
                    </section>
                    <section class="mesh-section">
                        <h3>Props <span>Select one or more</span></h3>
                        <div class="mesh-types" data-role="paint-asset-list"></div>
                    </section>
                    <div class="mesh-help" data-role="scatter-help"><i data-lucide="mouse-pointer-2"></i><span><b>LMB + drag</b> scatters props.<br><b>Ctrl + LMB</b> erases every selected prop.</span></div>
                    <div class="mesh-help" data-role="line-help"><i data-lucide="mouse-pointer-2"></i><span><b>LMB drag</b> draws a line, release to place along it, each facing the line at the set Angle.<br><b>Ctrl + LMB</b> erases.</span></div>
                </div>
            </div>
        `;
        document.body.appendChild(this.container);

        this.assetList = this.container.querySelector('[data-role="asset-list"]') as HTMLElement;
        this.paintAssetList = this.container.querySelector('[data-role="paint-asset-list"]') as HTMLElement;
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.obj,.mtl,.fbx,.glb,.gltf,image/*';
        this.fileInput.multiple = true;
        this.fileInput.hidden = true;
        this.container.appendChild(this.fileInput);

        this.bindPanelActions();
        this.bindSettings();
        this.bindUpload();

        this.meshes.onChanged = () => this.render();
        this.library.onChanged = () => this.render();
        this.render();
    }

    public get selectedAssetIndices(): number[] {
        return [...this.selectedAssets].filter((index) => index >= 0 && index < this.meshes.assets.length);
    }

    public get isVisible(): boolean { return this.visible; }

    public show(): void {
        this.visible = true;
        this.container.classList.add('visible');
        this.render();
    }

    public hide(): void {
        this.visible = false;
        this.container.classList.remove('visible');
        window.dispatchEvent(new CustomEvent('mesh-panel-closed'));
    }

    private bindPanelActions(): void {
        this.container.querySelector('.mesh-close')?.addEventListener('click', () => this.hide());
        this.container.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                this.activeTab = button.dataset.tab as PanelTab;
                this.renderTab();
            });
        });
        this.container.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
            button.addEventListener('click', () => {
                this.settings.mode = button.dataset.mode as MeshPlacementMode;
                this.renderModeVisibility();
            });
        });
    }

    private bindSettings(): void {
        const enabled = this.container.querySelector<HTMLInputElement>('[data-setting="enabled"]')!;
        enabled.checked = this.settings.enabled;
        enabled.addEventListener('change', () => { this.settings.enabled = enabled.checked; });

        const randomY = this.container.querySelector<HTMLInputElement>('[data-setting="randomizeRotationY"]')!;
        randomY.checked = this.settings.randomizeRotationY;
        randomY.addEventListener('change', () => { this.settings.randomizeRotationY = randomY.checked; });

        const bindNumber = (name: Exclude<keyof MeshBrushSettings, 'enabled' | 'mode' | 'randomizeRotationY'>, min: number, max: number, integer = false): void => {
            const input = this.container.querySelector<HTMLInputElement>(`[data-setting="${name}"]`)!;
            input.value = String(this.settings[name]);
            input.addEventListener('change', () => {
                const parsed = Number(input.value);
                const value = Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : this.settings[name]));
                this.settings[name] = integer ? Math.round(value) : value;
                input.value = String(this.settings[name]);
            });
        };
        bindNumber('radius', 0.2, 40);
        bindNumber('density', 1, 60, true);
        bindNumber('minimumSpacing', 0.05, 20);
        bindNumber('maxHeightDifference', 0, 20);
        bindNumber('randomTiltDegrees', 0, 45);
        bindNumber('minScale', 0.05, 20);
        bindNumber('maxScale', 0.05, 20);
        bindNumber('lineSpacing', 0.1, 40);
        bindNumber('lineSpacingRandomness', 0, 1);
        bindNumber('lineAngleOffset', -180, 180);

        this.renderModeVisibility();
    }

    private bindUpload(): void {
        const dropZone = this.container.querySelector('[data-role="drop-zone"]') as HTMLElement;
        dropZone.querySelector('[data-action="browse"]')?.addEventListener('click', () => this.fileInput.click());
        this.fileInput.addEventListener('change', () => {
            void this.importFiles(this.fileInput.files);
            this.fileInput.value = '';
        });
        dropZone.addEventListener('dragover', (event) => {
            if (!event.dataTransfer?.types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            dropZone.classList.add('drag-over');
        });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', (event) => {
            if (!event.dataTransfer?.files.length) return;
            event.preventDefault();
            dropZone.classList.remove('drag-over');
            void this.importFiles(event.dataTransfer.files);
        });
    }

    private async importFiles(files: FileList | null): Promise<void> {
        if (!files || files.length === 0) return;
        this.history.beginAction('Add Mesh Prop');
        const addedPaths = await this.library.addFiles(files);
        const existingPaths = new Set(this.meshes.assets.map((asset) => asset.LibraryPath));
        let lastAddedIndex = -1;
        for (const path of addedPaths) {
            if (existingPaths.has(path)) continue;
            const libraryAsset = this.library.getAsset(path);
            const index = this.meshes.addAsset(createMeshAsset(libraryAsset?.displayName ?? path, path));
            this.selectedAssets.add(index);
            lastAddedIndex = index;
        }
        this.meshes.commitChanges();
        this.history.endAction();
        // Uploaded files routinely arrive at the wrong scale (e.g. authored in
        // centimeters) - open calibration immediately so the user fixes that before
        // scattering dozens of oversized instances across the terrain.
        if (lastAddedIndex >= 0) this.calibration.open(lastAddedIndex);
    }

    private async removeAsset(assetIndex: number): Promise<void> {
        const asset = this.meshes.assets[assetIndex];
        if (!asset) return;
        this.history.beginAction('Remove Mesh Prop');
        const remapped = new Set<number>();
        for (const index of this.selectedAssets) {
            if (index < assetIndex) remapped.add(index);
            else if (index > assetIndex) remapped.add(index - 1);
        }
        this.selectedAssets.clear();
        remapped.forEach((index) => this.selectedAssets.add(index));
        this.meshes.removeAsset(assetIndex);
        this.meshes.commitChanges();
        await this.library.removeAsset(asset.LibraryPath);
        this.history.endAction();
    }

    private renderModeVisibility(): void {
        this.container.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
            button.classList.toggle('active', button.dataset.mode === this.settings.mode);
        });
        const scatter = this.settings.mode === 'scatter';
        (this.container.querySelector('[data-role="scatter-settings"]') as HTMLElement).style.display = scatter ? '' : 'none';
        (this.container.querySelector('[data-role="line-settings"]') as HTMLElement).style.display = scatter ? 'none' : '';
        (this.container.querySelector('[data-role="scatter-help"]') as HTMLElement).style.display = scatter ? '' : 'none';
        (this.container.querySelector('[data-role="line-help"]') as HTMLElement).style.display = scatter ? 'none' : '';
    }

    private render(): void {
        for (const index of this.selectedAssets) if (index >= this.meshes.assets.length) this.selectedAssets.delete(index);
        this.renderTab();
        this.renderAssetList();
        this.renderPaintAssetList();
        createIcons({ icons });
    }

    private renderTab(): void {
        this.container.querySelectorAll<HTMLElement>('[data-tab]').forEach((button) => {
            button.classList.toggle('active', button.dataset.tab === this.activeTab);
        });
        this.container.querySelectorAll<HTMLElement>('[data-view]').forEach((view) => {
            view.classList.toggle('active', view.dataset.view === this.activeTab);
        });
    }

    private renderAssetList(): void {
        this.assetList.innerHTML = '';

        const missing = this.library.getMissingPaths();
        if (missing.length > 0) {
            const warning = document.createElement('section');
            warning.className = 'mesh-missing';
            warning.innerHTML = `
                <div class="mesh-missing-icon"><i data-lucide="triangle-alert"></i></div>
                <div><strong>${missing.length} missing prop${missing.length === 1 ? '' : 's'}</strong><span>Re-upload the original files (same main filename) to relink them.</span></div>
            `;
            this.assetList.appendChild(warning);
        }

        if (this.meshes.assets.length === 0) {
            this.assetList.appendChild(this.createEmptyState('No props yet', 'Upload an OBJ, FBX or GLB to get started.'));
            return;
        }
        this.meshes.assets.forEach((asset, index) => {
            const libraryAsset = this.library.getAsset(asset.LibraryPath);
            const row = document.createElement('div');
            row.className = 'mesh-asset-row';

            const icon = document.createElement('span');
            icon.className = 'mesh-asset-icon';
            icon.innerHTML = '<i data-lucide="box"></i>';

            const copy = document.createElement('div');
            copy.className = 'mesh-asset-copy';
            const name = document.createElement('input');
            name.type = 'text';
            name.value = asset.DisplayName;
            name.addEventListener('change', () => {
                this.history.beginAction('Rename Mesh Prop');
                this.meshes.renameAsset(index, name.value.trim() || asset.DisplayName);
                this.history.endAction();
            });
            const meta = document.createElement('small');
            const count = this.meshes.getInstances(index).length;
            meta.textContent = `${(libraryAsset?.format ?? '?').toUpperCase()} · ${count} instance${count === 1 ? '' : 's'}`;
            copy.append(name, meta);

            const calibrate = document.createElement('button');
            calibrate.type = 'button';
            calibrate.className = 'mesh-asset-remove';
            calibrate.innerHTML = '<i data-lucide="ruler"></i>';
            calibrate.title = 'Calibrate scale';
            calibrate.addEventListener('click', () => this.calibration.open(index));

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'mesh-asset-remove';
            remove.innerHTML = '<i data-lucide="trash-2"></i>';
            remove.title = 'Remove prop';
            remove.addEventListener('click', () => void this.removeAsset(index));

            row.append(icon, copy, calibrate, remove);
            this.assetList.appendChild(row);
        });
    }

    private renderPaintAssetList(): void {
        this.paintAssetList.innerHTML = '';
        if (this.meshes.assets.length === 0) {
            this.paintAssetList.appendChild(this.createEmptyState('No props yet', 'Add props from the Library tab first.'));
            return;
        }
        this.meshes.assets.forEach((asset, index) => {
            const row = document.createElement('label');
            row.className = 'mesh-type';
            row.classList.toggle('selected', this.selectedAssets.has(index));
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.selectedAssets.has(index);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) this.selectedAssets.add(index);
                else this.selectedAssets.delete(index);
                row.classList.toggle('selected', checkbox.checked);
            });
            const label = document.createElement('span');
            label.textContent = asset.DisplayName;
            row.append(checkbox, label);
            this.paintAssetList.appendChild(row);
        });
    }

    private createEmptyState(title: string, message: string): HTMLElement {
        const empty = document.createElement('div');
        empty.className = 'mesh-empty';
        empty.innerHTML = '<i data-lucide="box"></i><strong></strong><span></span>';
        (empty.querySelector('strong') as HTMLElement).textContent = title;
        (empty.querySelector('span') as HTMLElement).textContent = message;
        return empty;
    }
}
