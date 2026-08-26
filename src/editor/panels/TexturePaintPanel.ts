import { createIcons, icons } from 'lucide';
import { inject, singleton } from 'tsyringe';
import TextureLibrary from '../TextureLibrary';
import type { TextureBrushShape } from '../../terrain/TerrainTexturePaint';

export interface TexturePaintBrushSettings {
    radius: number;
    opacity: number;
    hardness: number;
    spacing: number;
    rotation: number;
    shape: TextureBrushShape;
    layer: number;
}

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
    private visible = false;
    private displayedLayers = Array.from({ length: 4 }, () => ({ texturePath: '', tiling: 8 }));

    constructor(@inject(TextureLibrary) private readonly library: TextureLibrary) {
        this.container = document.createElement('aside');
        this.container.id = 'texture-paint-panel';
        this.container.innerHTML = `
            <div class="texture-paint-header">
                <div><span>Terrain Tool</span><strong>Texture Painter</strong></div>
                <button type="button" data-action="close" aria-label="Close"><i data-lucide="x"></i></button>
            </div>
            <div class="texture-paint-body">
                <section><h3>Layers</h3><div class="texture-paint-layers"></div></section>
                <section>
                    <h3>Brush preset</h3>
                    <div class="texture-brush-presets">
                        <button data-shape="soft-round" class="active"><span class="brush-dot soft"></span>Soft</button>
                        <button data-shape="hard-round"><span class="brush-dot hard"></span>Hard</button>
                        <button data-shape="square"><span class="brush-dot square"></span>Square</button>
                        <button data-shape="noise"><span class="brush-dot noise"></span>Noise</button>
                    </div>
                </section>
                <section class="texture-paint-sliders">
                    <h3>Brush settings</h3>
                    ${this.slider('radius', 'Size', 0.5, 30, 0.25, 4)}
                    ${this.slider('opacity', 'Opacity', 0.01, 1, 0.01, 0.35)}
                    ${this.slider('hardness', 'Hardness', 0, 1, 0.01, 0.45)}
                    ${this.slider('spacing', 'Spacing', 0.05, 1, 0.01, 0.15)}
                    ${this.slider('rotation', 'Rotation', 0, 360, 1, 0)}
                </section>
                <button type="button" class="texture-paint-clear" data-action="clear"><i data-lucide="rotate-ccw"></i> Reset to Layer 1</button>
                <div class="texture-paint-help"><i data-lucide="mouse-pointer-2"></i><span><b>LMB + drag</b> paints the selected layer. The preview shows size, shape, rotation and softness.</span></div>
            </div>`;
        document.body.appendChild(this.container);
        this.bind();
        void this.library.ready().then(() => this.renderLayers());
        const previous = this.library.onChanged;
        this.library.onChanged = () => { previous?.(); this.renderLayers(); };
        createIcons({ icons });
    }

    public get isVisible(): boolean { return this.visible; }
    public show(): void { this.visible = true; this.container.classList.add('visible'); this.renderLayers(); }
    public hide(): void { this.visible = false; this.container.classList.remove('visible'); window.dispatchEvent(new CustomEvent('texture-paint-panel-closed')); }

    public syncTerrain(layers: readonly { texturePath: string; tiling: number }[]): void {
        this.displayedLayers = Array.from({ length: 4 }, (_, index) => ({
            texturePath: layers[index]?.texturePath ?? '', tiling: layers[index]?.tiling ?? 8,
        }));
        const selects = this.container.querySelectorAll<HTMLSelectElement>('[data-layer-texture]');
        selects.forEach((select, index) => { select.value = layers[index]?.texturePath ?? ''; });
        const tilings = this.container.querySelectorAll<HTMLInputElement>('[data-layer-tiling]');
        tilings.forEach((input, index) => { input.value = String(layers[index]?.tiling ?? 8); });
    }

    private slider(name: keyof TexturePaintBrushSettings, label: string, min: number, max: number, step: number, value: number): string {
        return `<label><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-setting="${name}"><output>${value}</output></label>`;
    }

    private bind(): void {
        this.container.querySelector('[data-action="close"]')?.addEventListener('click', () => this.hide());
        this.container.querySelector('[data-action="clear"]')?.addEventListener('click', () => this.onClear?.());
        this.container.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach((button) => button.addEventListener('click', () => {
            this.settings.shape = button.dataset.shape as TextureBrushShape;
            this.container.querySelectorAll('[data-shape]').forEach((candidate) => candidate.classList.toggle('active', candidate === button));
        }));
        this.container.querySelectorAll<HTMLInputElement>('[data-setting]').forEach((input) => input.addEventListener('input', () => {
            const name = input.dataset.setting as 'radius' | 'opacity' | 'hardness' | 'spacing' | 'rotation';
            this.settings[name] = Number(input.value);
            const suffix = name === 'rotation' ? '°' : '';
            input.nextElementSibling!.textContent = `${Number(input.value).toFixed(name === 'radius' ? 1 : name === 'rotation' ? 0 : 2)}${suffix}`;
        }));
    }

    private renderLayers(): void {
        const root = this.container.querySelector('.texture-paint-layers')!;
        const assets = this.library.getAssets();
        root.innerHTML = '';
        for (let index = 0; index < 4; index++) {
            const row = document.createElement('div');
            row.className = 'texture-layer-row';
            row.classList.toggle('active', this.settings.layer === index);
            const swatch = document.createElement('button');
            swatch.className = `texture-layer-swatch layer-${index}`;
            swatch.type = 'button';
            swatch.textContent = String(index + 1);
            swatch.addEventListener('click', () => { this.settings.layer = index; this.renderLayers(); });
            const select = document.createElement('select');
            select.dataset.layerTexture = String(index);
            select.innerHTML = '<option value="">Default / empty</option>';
            for (const asset of assets) select.add(new Option(asset.name, asset.path));
            select.value = this.displayedLayers[index].texturePath;
            select.addEventListener('change', () => { this.displayedLayers[index].texturePath = select.value; this.onLayerTextureChanged?.(index, select.value); });
            const tiling = document.createElement('input');
            tiling.type = 'number'; tiling.min = '0.1'; tiling.max = '100'; tiling.step = '0.5'; tiling.value = String(this.displayedLayers[index].tiling);
            tiling.title = 'Texture tiling'; tiling.dataset.layerTiling = String(index);
            tiling.addEventListener('change', () => { const value = Math.max(0.1, Math.min(100, Number(tiling.value) || 8)); this.displayedLayers[index].tiling = value; this.onLayerTilingChanged?.(index, value); });
            row.append(swatch, select, tiling);
            root.appendChild(row);
        }
    }
}
