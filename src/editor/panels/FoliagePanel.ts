import { createIcons, icons } from 'lucide';
import { inject, singleton } from 'tsyringe';
import FoliageManager from '../FoliageManager';
import HistoryManager from '../HistoryManager';
import TextureLibrary from '../TextureLibrary';
import { createDefaultFoliageType, type FoliageColor, type FoliageTypeData } from '../../foliage/FoliageData';

export interface FoliageBrushSettings {
    enabled: boolean;
    radius: number;
    density: number;
    minimumSpacing: number;
    maxHeightDifference: number;
}

type PanelTab = 'paint' | 'presets';

@singleton()
export default class FoliagePanel {
    public readonly settings: FoliageBrushSettings = {
        enabled: true,
        radius: 2,
        density: 25,
        minimumSpacing: 0.3,
        maxHeightDifference: 1.5,
    };

    private readonly selectedTypes = new Set<number>();
    private readonly container: HTMLElement;
    private readonly paintTypeList: HTMLElement;
    private readonly presetList: HTMLElement;
    private readonly presetEditor: HTMLElement;
    private visible = false;
    private activeTab: PanelTab = 'paint';
    private editingTypeIndex = -1;
    private suppressRender = false;

    constructor(
        @inject(FoliageManager) private readonly foliage: FoliageManager,
        @inject(TextureLibrary) private readonly textures: TextureLibrary,
        @inject(HistoryManager) private readonly history: HistoryManager,
    ) {
        this.container = document.createElement('aside');
        this.container.id = 'foliage-panel';
        this.container.innerHTML = `
            <div class="foliage-header">
                <div><span class="foliage-eyebrow">World Tool</span><strong>Foliage Editor</strong></div>
                <button type="button" class="foliage-close" aria-label="Close foliage editor"><i data-lucide="x"></i></button>
            </div>
            <div class="foliage-tabs" role="tablist">
                <button type="button" data-tab="paint" class="active"><i data-lucide="paintbrush"></i> Paint</button>
                <button type="button" data-tab="presets"><i data-lucide="sliders-horizontal"></i> Presets</button>
            </div>
            <div class="foliage-body">
                <div class="foliage-tab-view active" data-view="paint">
                    <label class="foliage-toggle"><input type="checkbox" data-setting="enabled" checked><span>Enable Painting</span></label>
                    <section class="foliage-section">
                        <h3>Brush</h3>
                        <label><span>Brush Radius</span><input type="number" min="0.1" max="25" step="0.1" data-setting="radius" value="2"></label>
                        <label><span>Paint Density</span><input type="number" min="1" max="100" step="1" data-setting="density" value="25"></label>
                        <label><span>Minimum Spacing</span><input type="number" min="0.02" max="5" step="0.02" data-setting="minimumSpacing" value="0.3"></label>
                        <label><span>Max Height Difference</span><input type="number" min="0" max="20" step="0.1" data-setting="maxHeightDifference" value="1.5"></label>
                    </section>
                    <section class="foliage-section">
                        <h3>Foliage Presets <span>Select one or more</span></h3>
                        <div class="foliage-types" data-role="paint-types"></div>
                    </section>
                    <div class="foliage-help"><i data-lucide="mouse-pointer-2"></i><span><b>LMB + drag</b> paints foliage.<br><b>Ctrl + LMB</b> erases every preset.</span></div>
                </div>
                <div class="foliage-tab-view" data-view="presets">
                    <div class="foliage-preset-actions">
                        <button type="button" data-action="add"><i data-lucide="plus"></i> Add Preset</button>
                        <button type="button" data-action="duplicate" title="Duplicate selected preset"><i data-lucide="copy"></i></button>
                        <button type="button" data-action="delete" class="danger" title="Delete selected preset"><i data-lucide="trash-2"></i></button>
                    </div>
                    <div class="foliage-preset-list" data-role="preset-list"></div>
                    <div class="foliage-preset-editor" data-role="preset-editor"></div>
                </div>
            </div>
        `;
        document.body.appendChild(this.container);
        this.paintTypeList = this.container.querySelector('[data-role="paint-types"]') as HTMLElement;
        this.presetList = this.container.querySelector('[data-role="preset-list"]') as HTMLElement;
        this.presetEditor = this.container.querySelector('[data-role="preset-editor"]') as HTMLElement;
        this.bindSettings();
        this.bindPanelActions();
        this.foliage.onChanged = () => {
            if (!this.suppressRender) this.render();
        };
        this.render();
    }

    public get selectedTypeIndices(): number[] {
        return [...this.selectedTypes].filter((index) => index >= 0 && index < this.foliage.types.length);
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
        window.dispatchEvent(new CustomEvent('foliage-panel-closed'));
    }

    private bindPanelActions(): void {
        this.container.querySelector('.foliage-close')?.addEventListener('click', () => this.hide());
        this.container.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                this.activeTab = button.dataset.tab as PanelTab;
                this.renderTab();
            });
        });
        this.container.querySelector('[data-action="add"]')?.addEventListener('click', () => this.addPreset());
        this.container.querySelector('[data-action="duplicate"]')?.addEventListener('click', () => this.duplicatePreset());
        this.container.querySelector('[data-action="delete"]')?.addEventListener('click', () => this.deletePreset());
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

    private addPreset(): void {
        this.history.beginAction('Add Foliage Preset');
        const existingNames = new Set(this.foliage.types.map((type) => type.DisplayName));
        let displayName = 'New Foliage';
        for (let suffix = 2; existingNames.has(displayName); suffix++) displayName = `New Foliage ${suffix}`;
        const index = this.foliage.addType(createDefaultFoliageType(displayName));
        this.editingTypeIndex = index;
        this.selectedTypes.add(index);
        this.activeTab = 'presets';
        this.foliage.commitChanges();
        this.history.endAction();
    }

    private duplicatePreset(): void {
        if (!this.foliage.types[this.editingTypeIndex]) return;
        this.history.beginAction('Duplicate Foliage Preset');
        const index = this.foliage.duplicateType(this.editingTypeIndex);
        if (index >= 0) {
            this.editingTypeIndex = index;
            this.selectedTypes.add(index);
            this.foliage.commitChanges();
        }
        this.history.endAction();
    }

    private deletePreset(): void {
        const deletedIndex = this.editingTypeIndex;
        if (!this.foliage.types[deletedIndex]) return;
        this.history.beginAction('Delete Foliage Preset');
        if (this.foliage.removeType(deletedIndex)) {
            const remapped = new Set<number>();
            for (const index of this.selectedTypes) {
                if (index < deletedIndex) remapped.add(index);
                else if (index > deletedIndex) remapped.add(index - 1);
            }
            this.selectedTypes.clear();
            remapped.forEach((index) => this.selectedTypes.add(index));
            this.editingTypeIndex = Math.min(deletedIndex, this.foliage.types.length - 1);
            this.foliage.commitChanges();
        }
        this.history.endAction();
    }

    private updatePreset(patch: Partial<FoliageTypeData>, label = 'Edit Foliage Preset'): void {
        if (!this.foliage.types[this.editingTypeIndex]) return;
        this.history.beginAction(label);
        this.suppressRender = true;
        this.foliage.updateType(this.editingTypeIndex, patch);
        this.foliage.commitChanges();
        this.suppressRender = false;
        this.history.endAction();
        this.renderPaintTypes();
        this.renderPresetList();
        createIcons({ icons });
    }

    private render(): void {
        for (const index of this.selectedTypes) if (index >= this.foliage.types.length) this.selectedTypes.delete(index);
        if (!this.foliage.types[this.editingTypeIndex]) this.editingTypeIndex = this.foliage.types.length > 0 ? 0 : -1;
        this.renderTab();
        this.renderPaintTypes();
        this.renderPresetList();
        this.renderPresetEditor();
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

    private renderPaintTypes(): void {
        this.paintTypeList.innerHTML = '';
        if (this.foliage.types.length === 0) {
            this.paintTypeList.appendChild(this.createEmptyState('No foliage presets', 'Create a preset before painting.', true));
            return;
        }
        this.foliage.types.forEach((type, index) => {
            const row = document.createElement('div');
            row.className = 'foliage-type';
            row.classList.toggle('selected', this.selectedTypes.has(index));
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.selectedTypes.has(index);
            checkbox.setAttribute('aria-label', `Paint ${type.DisplayName}`);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) this.selectedTypes.add(index);
                else this.selectedTypes.delete(index);
                row.classList.toggle('selected', checkbox.checked);
            });
            row.append(checkbox, this.createPreview(type));
            const copy = document.createElement('button');
            copy.type = 'button';
            copy.className = 'foliage-type-copy';
            copy.innerHTML = '<strong></strong><small></small>';
            (copy.querySelector('strong') as HTMLElement).textContent = type.DisplayName;
            const count = this.foliage.getInstances(index).length;
            (copy.querySelector('small') as HTMLElement).textContent = `${count} instance${count === 1 ? '' : 's'} · ${type.TexturePath || 'no texture'}`;
            copy.addEventListener('click', () => {
                this.editingTypeIndex = index;
                this.activeTab = 'presets';
                this.render();
            });
            row.appendChild(copy);
            this.paintTypeList.appendChild(row);
        });
    }

    private renderPresetList(): void {
        this.presetList.innerHTML = '';
        this.foliage.types.forEach((type, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'foliage-preset-row';
            button.classList.toggle('active', index === this.editingTypeIndex);
            button.append(this.createPreview(type));
            const copy = document.createElement('span');
            copy.innerHTML = '<strong></strong><small></small>';
            (copy.querySelector('strong') as HTMLElement).textContent = type.DisplayName;
            (copy.querySelector('small') as HTMLElement).textContent = type.TexturePath || 'No texture selected';
            button.appendChild(copy);
            button.addEventListener('click', () => {
                this.editingTypeIndex = index;
                this.render();
            });
            this.presetList.appendChild(button);
        });
        const duplicate = this.container.querySelector<HTMLButtonElement>('[data-action="duplicate"]');
        const remove = this.container.querySelector<HTMLButtonElement>('[data-action="delete"]');
        if (duplicate) duplicate.disabled = this.editingTypeIndex < 0;
        if (remove) remove.disabled = this.editingTypeIndex < 0;
    }

    private renderPresetEditor(): void {
        const type = this.foliage.types[this.editingTypeIndex];
        this.presetEditor.innerHTML = '';
        if (!type) {
            this.presetEditor.appendChild(this.createEmptyState('No preset selected', 'Add a preset to configure its texture and rendering.', false));
            return;
        }
        this.presetEditor.innerHTML = `
            <section class="foliage-inspector-section">
                <h3>Preset</h3>
                <label><span>Display Name</span><input type="text" data-type-field="DisplayName"></label>
                <label><span>Texture</span><select data-type-field="TexturePath"></select></label>
                <button type="button" class="foliage-library-link" data-action="open-library"><i data-lucide="images"></i> Open Texture Library</button>
            </section>
            <section class="foliage-inspector-section">
                <h3>Size</h3>
                <label><span>Min Size</span><input type="number" min="0.01" max="100" step="0.01" data-type-field="MinSize"></label>
                <label><span>Max Size</span><input type="number" min="0.01" max="100" step="0.01" data-type-field="MaxSize"></label>
                <label><span>Length Factor</span><input type="number" min="0.01" max="20" step="0.01" data-type-field="LengthFactor"></label>
            </section>
            <section class="foliage-inspector-section">
                <h3>Color</h3>
                <label><span>Color A</span><input type="color" data-type-field="ColorA"></label>
                <label><span>Color B</span><input type="color" data-type-field="ColorB"></label>
            </section>
            <section class="foliage-inspector-section">
                <h3>Wind</h3>
                <label><span>Wind Effectiveness</span><input type="number" min="0" max="10" step="0.01" data-type-field="WindEffectiveness"></label>
                <label><span>Wind Height Offset</span><input type="number" min="-100" max="100" step="0.01" data-type-field="WindHeightOffset"></label>
                <label><span>Wind Base Offset</span><input type="number" min="-100" max="100" step="0.01" data-type-field="WindBaseOffset"></label>
            </section>
            <section class="foliage-inspector-section">
                <h3>Rendering</h3>
                <label><span>Max Draw Distance</span><input type="number" min="0" max="100000" step="1" data-type-field="MaxDrawDistance"></label>
                <label><span>Alpha Cutoff</span><input type="number" min="0" max="1" step="0.01" data-type-field="AlphaCutoff"></label>
                <label class="foliage-check"><span>Cast Shadows</span><input type="checkbox" data-type-field="CastShadows"></label>
            </section>
        `;

        const nameInput = this.presetEditor.querySelector<HTMLInputElement>('[data-type-field="DisplayName"]')!;
        nameInput.value = type.DisplayName;
        let nameEditing = false;
        nameInput.addEventListener('focus', () => {
            nameEditing = true;
            this.history.beginAction('Rename Foliage Preset');
        });
        nameInput.addEventListener('input', () => {
            this.foliage.updateType(this.editingTypeIndex, { DisplayName: nameInput.value.trim() || 'New Foliage' });
            this.renderPaintTypes();
            this.renderPresetList();
        });
        nameInput.addEventListener('blur', () => {
            if (!nameEditing) return;
            nameEditing = false;
            this.suppressRender = true;
            this.foliage.commitChanges();
            this.suppressRender = false;
            this.history.endAction();
        });

        const textureSelect = this.presetEditor.querySelector<HTMLSelectElement>('[data-type-field="TexturePath"]')!;
        textureSelect.add(new Option('None', ''));
        const assets = this.textures.getAssets();
        if (type.TexturePath && !assets.some((asset) => asset.path === type.TexturePath)) textureSelect.add(new Option(`${type.TexturePath} (missing)`, type.TexturePath));
        assets.forEach((asset) => textureSelect.add(new Option(asset.name, asset.path)));
        textureSelect.value = type.TexturePath;
        textureSelect.addEventListener('change', () => this.updatePreset({ TexturePath: textureSelect.value }, 'Change Foliage Texture'));
        this.presetEditor.querySelector('[data-action="open-library"]')?.addEventListener('click', () => {
            (document.getElementById('btn-textures') as HTMLButtonElement | null)?.click();
        });

        const numberFields: Array<keyof FoliageTypeData> = [
            'MinSize', 'MaxSize', 'LengthFactor', 'WindEffectiveness', 'WindHeightOffset',
            'WindBaseOffset', 'MaxDrawDistance', 'AlphaCutoff',
        ];
        numberFields.forEach((field) => {
            const input = this.presetEditor.querySelector<HTMLInputElement>(`[data-type-field="${field}"]`)!;
            input.value = String(type[field]);
            let fieldEditing = false;
            input.addEventListener('focus', () => {
                fieldEditing = true;
                this.history.beginAction(`Edit ${this.formatFieldName(field)}`);
            });
            input.addEventListener('input', () => {
                const parsed = Number(input.value);
                if (!Number.isFinite(parsed)) return;
                const min = input.min === '' ? -Infinity : Number(input.min);
                const max = input.max === '' ? Infinity : Number(input.max);
                this.foliage.updateType(this.editingTypeIndex, { [field]: Math.min(max, Math.max(min, parsed)) });
                this.foliage.rebuild();
            });
            input.addEventListener('blur', () => {
                if (!fieldEditing) return;
                fieldEditing = false;
                const parsed = Number(input.value);
                if (!Number.isFinite(parsed)) this.renderPresetEditor();
                else {
                    this.suppressRender = true;
                    this.foliage.commitChanges();
                    this.suppressRender = false;
                }
                this.history.endAction();
            });
        });

        (['ColorA', 'ColorB'] as const).forEach((field) => {
            const input = this.presetEditor.querySelector<HTMLInputElement>(`[data-type-field="${field}"]`)!;
            input.value = this.colorToHex(type[field]);
            input.addEventListener('change', () => this.updatePreset({ [field]: this.hexToColor(input.value) }, `Edit ${field}`));
        });
        const shadows = this.presetEditor.querySelector<HTMLInputElement>('[data-type-field="CastShadows"]')!;
        shadows.checked = type.CastShadows;
        shadows.addEventListener('change', () => this.updatePreset({ CastShadows: shadows.checked }, 'Edit Cast Shadows'));
    }

    private createPreview(type: FoliageTypeData): HTMLElement {
        const preview = document.createElement('span');
        preview.className = 'foliage-preview';
        const asset = this.textures.getAssets().find((candidate) => candidate.path === type.TexturePath);
        if (asset) preview.style.backgroundImage = `url("${asset.url}")`;
        else preview.style.background = `linear-gradient(145deg, ${this.colorToHex(type.ColorA)}, ${this.colorToHex(type.ColorB)})`;
        return preview;
    }

    private createEmptyState(title: string, message: string, addButton: boolean): HTMLElement {
        const empty = document.createElement('div');
        empty.className = 'foliage-empty';
        empty.innerHTML = '<i data-lucide="sprout"></i><strong></strong><span></span>';
        (empty.querySelector('strong') as HTMLElement).textContent = title;
        (empty.querySelector('span') as HTMLElement).textContent = message;
        if (addButton) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Add Preset';
            button.addEventListener('click', () => this.addPreset());
            empty.appendChild(button);
        }
        return empty;
    }

    private colorToHex(color: FoliageColor): string {
        const channel = (value: number): string => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0');
        return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
    }

    private hexToColor(hex: string): FoliageColor {
        const value = Number.parseInt(hex.slice(1), 16);
        return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255, a: 1 };
    }

    private formatFieldName(field: keyof FoliageTypeData): string {
        return String(field).replace(/([a-z])([A-Z])/g, '$1 $2');
    }
}
