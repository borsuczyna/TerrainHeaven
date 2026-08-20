import { createIcons, icons } from 'lucide';
import { inject, singleton } from 'tsyringe';
import FoliageManager from '../FoliageManager';
import TextureLibrary from '../TextureLibrary';

export interface FoliageBrushSettings {
    enabled: boolean;
    radius: number;
    density: number;
    minimumSpacing: number;
    maxHeightDifference: number;
}

@singleton()
export default class FoliagePanel {
    public readonly settings: FoliageBrushSettings = {
        enabled: true,
        radius: 2,
        density: 25,
        minimumSpacing: 0.3,
        maxHeightDifference: 1.5,
    };

    private readonly selectedTypes: boolean[];
    private readonly container: HTMLElement;
    private readonly typeList: HTMLElement;
    private visible = false;

    constructor(
        @inject(FoliageManager) private readonly foliage: FoliageManager,
        @inject(TextureLibrary) private readonly textures: TextureLibrary,
    ) {
        this.selectedTypes = foliage.types.map((_, index) => index === 0);
        this.container = document.createElement('aside');
        this.container.id = 'foliage-panel';
        this.container.innerHTML = `
            <div class="foliage-header">
                <div><span class="foliage-eyebrow">Paint Tool</span><strong>Foliage Editor</strong></div>
                <button type="button" class="foliage-close" aria-label="Close foliage editor"><i data-lucide="x"></i></button>
            </div>
            <div class="foliage-body">
                <label class="foliage-toggle"><input type="checkbox" data-setting="enabled" checked><span>Enable Painting</span></label>
                <section class="foliage-section">
                    <h3>Brush</h3>
                    <label><span>Brush Radius</span><input type="number" min="0.1" max="25" step="0.1" data-setting="radius" value="2"></label>
                    <label><span>Paint Density</span><input type="number" min="1" max="100" step="1" data-setting="density" value="25"></label>
                    <label><span>Minimum Spacing</span><input type="number" min="0.02" max="5" step="0.02" data-setting="minimumSpacing" value="0.3"></label>
                    <label><span>Max Height Difference</span><input type="number" min="0" max="20" step="0.1" data-setting="maxHeightDifference" value="1.5"></label>
                </section>
                <section class="foliage-section">
                    <h3>Foliage Types <span>Select one or more</span></h3>
                    <div class="foliage-types"></div>
                </section>
                <div class="foliage-help"><i data-lucide="mouse-pointer-2"></i><span><b>LMB + drag</b> paints foliage.<br><b>Ctrl + LMB</b> erases every type.</span></div>
            </div>
        `;
        document.body.appendChild(this.container);
        this.typeList = this.container.querySelector('.foliage-types') as HTMLElement;
        this.bindSettings();
        this.container.querySelector('.foliage-close')?.addEventListener('click', () => this.hide());
        this.foliage.onChanged = () => this.renderTypes();
        this.renderTypes();
        createIcons({ icons });
    }

    public get selectedTypeIndices(): number[] {
        return this.selectedTypes.flatMap((selected, index) => selected ? [index] : []);
    }

    public get isVisible(): boolean { return this.visible; }

    public show(): void {
        this.visible = true;
        this.container.classList.add('visible');
        this.renderTypes();
    }

    public hide(): void {
        this.visible = false;
        this.container.classList.remove('visible');
        window.dispatchEvent(new CustomEvent('foliage-panel-closed'));
    }

    private bindSettings(): void {
        const enabled = this.container.querySelector<HTMLInputElement>('[data-setting="enabled"]')!;
        enabled.addEventListener('change', () => { this.settings.enabled = enabled.checked; });
        const bindNumber = (name: keyof Omit<FoliageBrushSettings, 'enabled'>, min: number, max: number, integer = false): void => {
            const input = this.container.querySelector<HTMLInputElement>(`[data-setting="${name}"]`)!;
            input.addEventListener('change', () => {
                const parsed = Number(input.value);
                const value = Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : this.settings[name]));
                this.settings[name] = integer ? Math.round(value) : value;
                input.value = String(this.settings[name]);
            });
        };
        bindNumber('radius', 0.1, 25);
        bindNumber('density', 1, 100, true);
        bindNumber('minimumSpacing', 0.02, 5);
        bindNumber('maxHeightDifference', 0, 20);
    }

    private renderTypes(): void {
        this.typeList.innerHTML = '';
        const assets = new Map(this.textures.getAssets().map((asset) => [asset.path, asset]));
        this.foliage.types.forEach((type, index) => {
            const row = document.createElement('label');
            row.className = 'foliage-type';
            if (this.selectedTypes[index]) row.classList.add('selected');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.selectedTypes[index] ?? false;
            checkbox.addEventListener('change', () => {
                this.selectedTypes[index] = checkbox.checked;
                row.classList.toggle('selected', checkbox.checked);
            });
            const preview = document.createElement('span');
            preview.className = 'foliage-preview';
            const asset = assets.get(type.TexturePath);
            if (asset) preview.style.backgroundImage = `url("${asset.url}")`;
            else {
                const toHex = (value: number): string => Math.round(value * 255).toString(16).padStart(2, '0');
                preview.style.background = `linear-gradient(145deg, #${toHex(type.ColorA.r)}${toHex(type.ColorA.g)}${toHex(type.ColorA.b)}, #${toHex(type.ColorB.r)}${toHex(type.ColorB.g)}${toHex(type.ColorB.b)})`;
            }
            const copy = document.createElement('span');
            copy.className = 'foliage-type-copy';
            const count = this.foliage.getInstances(index).length;
            copy.innerHTML = `<strong>${type.DisplayName}</strong><small>${count} instance${count === 1 ? '' : 's'} · ${type.TexturePath}</small>`;
            row.append(checkbox, preview, copy);
            this.typeList.appendChild(row);
        });
    }
}
