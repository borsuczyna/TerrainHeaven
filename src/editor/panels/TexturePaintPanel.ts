import { createIcons, icons } from 'lucide';
import { inject, singleton } from 'tsyringe';
import TextureLibrary, { type TextureAsset } from '../TextureLibrary';
import type { TextureBrushShape } from '../../terrain/TerrainTexturePaint';

export interface TexturePaintBrushSettings {
    radius: number; opacity: number; hardness: number; spacing: number; rotation: number;
    shape: TextureBrushShape; layer: number;
}

const CHANNEL_NAMES = ['R', 'G', 'B', 'A'];

@singleton()
export default class TexturePaintPanel {
    public readonly settings: TexturePaintBrushSettings = {
        radius: 4, opacity: 0.35, hardness: 0.45, spacing: 0.15, rotation: 0,
        shape: 'soft-round', layer: 0,
    };
    public onLayerTextureChanged: ((layer: number, path: string) => void) | null = null;
    public onLayerTilingChanged: ((layer: number, tiling: number) => void) | null = null;
    public onClear: (() => void) | null = null;
    private readonly container: HTMLElement;
    private readonly fileInput: HTMLInputElement;
    private visible = false;
    private activeTab: 'paint' | 'layers' = 'paint';
    private pickerLayer: number | null = null;
    private pickerSearch = '';
    private displayedLayers = Array.from({ length: 4 }, () => ({ texturePath: '', tiling: 8 }));

    constructor(@inject(TextureLibrary) private readonly library: TextureLibrary) {
        this.container = document.createElement('aside');
        this.container.id = 'texture-paint-panel';
        this.container.innerHTML = `
            <header class="texture-paint-header">
                <div class="texture-paint-heading"><span>Terrain</span><strong>Paint Texture</strong><small>RGBA control map · 4 layers</small></div>
                <button type="button" data-action="close" aria-label="Close texture painter"><i data-lucide="x"></i></button>
            </header>
            <div class="texture-paint-tabs" role="tablist">
                <button type="button" data-tab="paint" class="active"><i data-lucide="paintbrush"></i> Paint</button>
                <button type="button" data-tab="layers"><i data-lucide="layers-3"></i> Layers</button>
            </div>
            <div class="texture-paint-body">
                <div class="texture-paint-tab-view active" data-view="paint">
                    <section class="texture-paint-section">
                        <h3>Active Layer <span>Click to manage</span></h3>
                        <button type="button" class="texture-active-layer" data-action="show-layers"></button>
                    </section>
                    <section class="texture-paint-section">
                        <h3>Brush <span>Choose a mask</span></h3>
                        <div class="texture-brush-presets">
                            ${this.brushButton('soft-round', 'Soft round')}
                            ${this.brushButton('medium-round', 'Medium round')}
                            ${this.brushButton('hard-round', 'Hard round')}
                            ${this.brushButton('soft-square', 'Soft square')}
                            ${this.brushButton('hard-square', 'Hard square')}
                            ${this.brushButton('noise', 'Noise')}
                            ${this.brushButton('speckle', 'Speckle')}
                            ${this.brushButton('ridge', 'Ridge')}
                        </div>
                    </section>
                    <section class="texture-paint-section texture-paint-sliders">
                        <h3>Brush Settings <span>Live preview</span></h3>
                        ${this.slider('radius', 'Size', 'World radius', 0.5, 30, 0.25, 4)}
                        ${this.slider('opacity', 'Strength', 'Paint opacity', 0.01, 1, 0.01, 0.35)}
                        ${this.slider('hardness', 'Falloff', 'Edge hardness', 0, 1, 0.01, 0.45)}
                        ${this.slider('spacing', 'Spacing', 'Stamp distance', 0.05, 1, 0.01, 0.15)}
                        ${this.slider('rotation', 'Rotation', 'Brush angle', 0, 360, 1, 0)}
                    </section>
                    <div class="texture-paint-footer"><p><i data-lucide="mouse-pointer-2"></i><span><b>LMB + drag</b> paints the selected layer.</span></p></div>
                </div>
                <div class="texture-paint-tab-view" data-view="layers">
                    <section class="texture-paint-section texture-layers-section">
                        <h3>Terrain Layers <span>RGBA channels</span></h3>
                        <div class="texture-paint-layers"></div>
                    </section>
                    <button type="button" class="texture-paint-clear" data-action="clear"><i data-lucide="rotate-ccw"></i> Reset control map</button>
                    <div class="texture-paint-footer"><p><i data-lucide="info"></i><span>Each pixel stores normalized weights for four textures.</span></p></div>
                </div>
            </div>
            <div class="texture-asset-picker" aria-hidden="true">
                <div class="texture-picker-header"><div><small>Terrain Layer</small><strong>Select Texture</strong></div><button type="button" data-picker-action="close" aria-label="Close texture picker"><i data-lucide="x"></i></button></div>
                <div class="texture-picker-tools"><label><i data-lucide="search"></i><input type="search" placeholder="Search textures…" data-picker-search></label><button type="button" data-picker-action="upload"><i data-lucide="upload"></i> Import</button></div>
                <div class="texture-picker-grid"></div>
                <button type="button" class="texture-picker-remove" data-picker-action="remove"><i data-lucide="circle-slash"></i> Use default material</button>
            </div>`;
        document.body.appendChild(this.container);
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file'; this.fileInput.accept = 'image/*'; this.fileInput.multiple = true; this.fileInput.hidden = true;
        this.container.appendChild(this.fileInput);
        this.bind();
        void this.library.ready().then(() => { this.renderLayers(); this.renderAssetPicker(); });
        const previous = this.library.onChanged;
        this.library.onChanged = () => { previous?.(); this.renderLayers(); this.renderAssetPicker(); };
        createIcons({ icons });
    }

    public get isVisible(): boolean { return this.visible; }
    public show(): void { this.visible = true; this.container.classList.add('visible'); this.renderLayers(); }
    public hide(): void { this.closePicker(); this.visible = false; this.container.classList.remove('visible'); window.dispatchEvent(new CustomEvent('texture-paint-panel-closed')); }

    public syncTerrain(layers: readonly { texturePath: string; tiling: number }[]): void {
        this.displayedLayers = Array.from({ length: 4 }, (_, index) => ({ texturePath: layers[index]?.texturePath ?? '', tiling: layers[index]?.tiling ?? 8 }));
        this.renderLayers();
    }

    private brushButton(shape: TextureBrushShape, label: string): string {
        return `<button type="button" data-shape="${shape}" class="${shape === this.settings.shape ? 'active' : ''}" aria-label="${label}" title="${label}">${this.brushSvg(shape)}</button>`;
    }

    private brushSvg(shape: TextureBrushShape): string {
        const paths: Record<TextureBrushShape, string> = {
            'soft-round': '<circle cx="24" cy="24" r="16"/><circle cx="24" cy="24" r="10" opacity=".65"/><circle cx="24" cy="24" r="4" opacity=".35"/>',
            'medium-round': '<circle cx="24" cy="24" r="15"/><circle cx="24" cy="24" r="9"/>',
            'hard-round': '<circle cx="24" cy="24" r="15" stroke-width="2.2"/>',
            'soft-square': '<rect x="8" y="8" width="32" height="32" rx="3"/><rect x="14" y="14" width="20" height="20" rx="2" opacity=".55"/>',
            'hard-square': '<rect x="9" y="9" width="30" height="30" rx="1" stroke-width="2.2"/>',
            noise: '<path d="M8 28c5-18 9 7 14-10s8 18 12-2 8 9 8 9"/><path d="M9 36c8-9 9 3 15-7s9 8 15-4" opacity=".55"/>',
            speckle: '<circle cx="12" cy="15" r="2"/><circle cx="25" cy="10" r="1.5"/><circle cx="36" cy="17" r="2.5"/><circle cx="17" cy="29" r="2.5"/><circle cx="31" cy="33" r="2"/><circle cx="39" cy="38" r="1.3"/><circle cx="10" cy="39" r="1.4"/>',
            ridge: '<path d="M7 36 14 15l7 20 7-24 7 23 6-18"/><path d="M8 41h33" opacity=".45"/>',
        };
        return `<svg class="brush-line-preview" viewBox="0 0 48 48" aria-hidden="true">${paths[shape]}</svg>`;
    }

    private slider(name: keyof TexturePaintBrushSettings, label: string, description: string, min: number, max: number, step: number, value: number): string {
        return `<label class="texture-slider-row"><span><strong>${label}</strong><small>${description}</small></span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-setting="${name}"><input class="texture-slider-value" type="number" min="${min}" max="${max}" step="${step}" value="${value}" data-value-for="${name}" aria-label="${label} value"></label>`;
    }

    private bind(): void {
        this.container.querySelector('[data-action="close"]')?.addEventListener('click', () => this.hide());
        this.container.querySelector('[data-action="clear"]')?.addEventListener('click', () => this.onClear?.());
        this.container.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach((button) => button.addEventListener('click', () => {
            this.settings.shape = button.dataset.shape as TextureBrushShape;
            this.container.querySelectorAll('[data-shape]').forEach((candidate) => candidate.classList.toggle('active', candidate === button));
        }));
        this.container.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.addEventListener('click', () => {
            this.activeTab = button.dataset.tab as 'paint' | 'layers'; this.renderTab();
        }));
        this.container.querySelector('[data-action="show-layers"]')?.addEventListener('click', () => { this.activeTab = 'layers'; this.renderTab(); });
        this.container.querySelectorAll<HTMLInputElement>('[data-setting]').forEach((range) => {
            const name = range.dataset.setting as 'radius' | 'opacity' | 'hardness' | 'spacing' | 'rotation';
            const valueInput = this.container.querySelector<HTMLInputElement>(`[data-value-for="${name}"]`)!;
            const apply = (raw: string): void => {
                const min = Number(range.min); const max = Number(range.max); const value = Math.max(min, Math.min(max, Number(raw) || min));
                this.settings[name] = value; range.value = String(value); valueInput.value = String(value);
            };
            range.addEventListener('input', () => apply(range.value)); valueInput.addEventListener('change', () => apply(valueInput.value));
        });
        this.container.querySelector('[data-picker-action="close"]')?.addEventListener('click', () => this.closePicker());
        this.container.querySelector('[data-picker-action="upload"]')?.addEventListener('click', () => this.fileInput.click());
        this.container.querySelector('[data-picker-action="remove"]')?.addEventListener('click', () => this.chooseTexture(''));
        this.container.querySelector<HTMLInputElement>('[data-picker-search]')?.addEventListener('input', (event) => { this.pickerSearch = (event.currentTarget as HTMLInputElement).value.trim().toLowerCase(); this.renderAssetPicker(); });
        this.fileInput.addEventListener('change', async () => {
            const paths = await this.library.addFiles(this.fileInput.files ?? []); this.fileInput.value = '';
            if (paths.length === 1) this.chooseTexture(paths[0]);
        });
    }

    private renderLayers(): void {
        const root = this.container.querySelector('.texture-paint-layers'); if (!root) return;
        const assets = new Map(this.library.getAssets().map((asset) => [asset.path, asset])); root.innerHTML = '';
        for (let index = 0; index < 4; index++) {
            const layer = this.displayedLayers[index]; const asset = assets.get(layer.texturePath);
            const card = document.createElement('article'); card.className = 'texture-layer-card'; card.classList.toggle('active', this.settings.layer === index);
            const select = document.createElement('button'); select.type = 'button'; select.className = 'texture-layer-main';
            const preview = document.createElement('span'); preview.className = 'texture-layer-preview';
            if (asset) { const image = document.createElement('img'); image.src = asset.url; image.alt = ''; preview.appendChild(image); } else preview.innerHTML = '<i data-lucide="image"></i>';
            const copy = document.createElement('span'); copy.className = 'texture-layer-copy';
            const channel = document.createElement('small'); channel.textContent = `LAYER ${index + 1} · ${CHANNEL_NAMES[index]}`;
            const name = document.createElement('strong'); name.textContent = asset?.name ?? (index === 0 ? 'Base Material' : 'Empty Layer');
            const path = document.createElement('em'); path.textContent = asset?.path ?? (index === 0 ? 'Default terrain appearance' : 'Choose a texture to paint');
            copy.append(channel, name, path); select.append(preview, copy); select.addEventListener('click', () => { this.settings.layer = index; this.renderLayers(); });
            const controls = document.createElement('div'); controls.className = 'texture-layer-controls';
            const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'texture-layer-choose'; choose.innerHTML = '<i data-lucide="chevron-right"></i>'; choose.title = 'Choose texture'; choose.addEventListener('click', () => this.openPicker(index));
            const tilingLabel = document.createElement('label'); tilingLabel.innerHTML = '<span>Tiling</span>';
            const tiling = document.createElement('input'); tiling.type = 'number'; tiling.min = '0.1'; tiling.max = '100'; tiling.step = '0.5'; tiling.value = String(layer.tiling);
            tiling.addEventListener('change', () => { const value = Math.max(0.1, Math.min(100, Number(tiling.value) || 8)); layer.tiling = value; tiling.value = String(value); this.onLayerTilingChanged?.(index, value); });
            tilingLabel.appendChild(tiling); controls.append(tilingLabel, choose); card.append(select, controls); root.appendChild(card);
        }
        this.renderActiveLayer(assets);
        createIcons({ icons });
    }

    private renderActiveLayer(assets: Map<string, TextureAsset>): void {
        const root = this.container.querySelector<HTMLButtonElement>('.texture-active-layer'); if (!root) return;
        const layer = this.displayedLayers[this.settings.layer]; const asset = assets.get(layer.texturePath); root.innerHTML = '';
        const preview = document.createElement('span'); preview.className = 'texture-layer-preview';
        if (asset) { const image = document.createElement('img'); image.src = asset.url; image.alt = ''; preview.appendChild(image); } else preview.innerHTML = '<i data-lucide="image"></i>';
        const copy = document.createElement('span'); copy.className = 'texture-layer-copy';
        copy.innerHTML = `<small>LAYER ${this.settings.layer + 1} · ${CHANNEL_NAMES[this.settings.layer]}</small><strong></strong><em></em>`;
        copy.querySelector('strong')!.textContent = asset?.name ?? (this.settings.layer === 0 ? 'Base Material' : 'Empty Layer');
        copy.querySelector('em')!.textContent = asset?.path ?? 'Open Layers to choose a texture';
        const icon = document.createElement('i'); icon.dataset.lucide = 'chevron-right'; root.append(preview, copy, icon);
    }

    private renderTab(): void {
        this.container.querySelectorAll<HTMLElement>('[data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === this.activeTab));
        this.container.querySelectorAll<HTMLElement>('.texture-paint-tab-view').forEach((view) => view.classList.toggle('active', view.dataset.view === this.activeTab));
    }

    private openPicker(layer: number): void {
        this.pickerLayer = layer; this.pickerSearch = '';
        const search = this.container.querySelector<HTMLInputElement>('[data-picker-search]'); if (search) search.value = '';
        const picker = this.container.querySelector<HTMLElement>('.texture-asset-picker')!; picker.classList.add('visible'); picker.setAttribute('aria-hidden', 'false'); this.renderAssetPicker();
    }
    private closePicker(): void { this.pickerLayer = null; const picker = this.container.querySelector<HTMLElement>('.texture-asset-picker'); picker?.classList.remove('visible'); picker?.setAttribute('aria-hidden', 'true'); }
    private chooseTexture(path: string): void {
        if (this.pickerLayer === null) return;
        const layer = this.pickerLayer; this.displayedLayers[layer].texturePath = path; this.settings.layer = layer;
        this.onLayerTextureChanged?.(layer, path); this.closePicker(); this.renderLayers();
    }
    private renderAssetPicker(): void {
        const grid = this.container.querySelector<HTMLElement>('.texture-picker-grid'); if (!grid) return;
        const assets = this.library.getAssets().filter((asset) => !this.pickerSearch || asset.name.toLowerCase().includes(this.pickerSearch) || asset.path.toLowerCase().includes(this.pickerSearch)); grid.innerHTML = '';
        if (assets.length === 0) grid.innerHTML = '<div class="texture-picker-empty"><i data-lucide="images"></i><strong>No textures yet</strong><span>Import PNG, JPG or WEBP textures.</span></div>';
        else for (const asset of assets) grid.appendChild(this.assetButton(asset));
        createIcons({ icons });
    }
    private assetButton(asset: TextureAsset): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'texture-picker-asset';
        if (this.pickerLayer !== null && this.displayedLayers[this.pickerLayer].texturePath === asset.path) button.classList.add('active');
        const image = document.createElement('img'); image.src = asset.url; image.alt = asset.name;
        const name = document.createElement('strong'); name.textContent = asset.name;
        const size = document.createElement('small'); size.textContent = `${Math.max(1, Math.round(asset.size / 1024))} KB`;
        button.append(image, name, size); button.addEventListener('click', () => this.chooseTexture(asset.path)); return button;
    }
}
