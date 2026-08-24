import { inject, singleton } from 'tsyringe';
import { createIcons, icons } from 'lucide';
import PresetManager from '../PresetManager';
import '../../styles/preset-panel.css';

@singleton()
export default class PresetPanel {
    private readonly container: HTMLElement;
    private readonly list: HTMLElement;
    private readonly search: HTMLInputElement;
    private visible = false;
    public onHide: (() => void) | null = null;

    constructor(@inject(PresetManager) private readonly presets: PresetManager) {
        this.container = document.createElement('aside');
        this.container.id = 'preset-panel';
        this.container.innerHTML = `
            <div class="preset-header">
                <div><span class="preset-eyebrow">Library</span><strong>Element Presets</strong></div>
                <button type="button" class="preset-close" aria-label="Close"><i data-lucide="x"></i></button>
            </div>
            <div class="preset-toolbar">
                <input type="search" placeholder="Search presets…" aria-label="Search presets">
            </div>
            <div class="preset-hint"><i data-lucide="mouse-pointer-2"></i><span>Drag a preset onto a matching element. Use the star to make it the default for newly created elements.</span></div>
            <div class="preset-list"></div>`;
        document.body.appendChild(this.container);
        this.list = this.container.querySelector('.preset-list')!;
        this.search = this.container.querySelector('input')!;
        this.container.querySelector('.preset-close')?.addEventListener('click', () => this.hide());
        this.search.addEventListener('input', () => this.render());
        this.presets.onChanged = () => this.render();
        this.render();
    }

    public get isVisible(): boolean { return this.visible; }
    public toggle(): void { this.visible ? this.hide() : this.show(); }
    public show(): void { this.visible = true; this.container.classList.add('visible'); this.render(); }
    public hide(): void { this.visible = false; this.container.classList.remove('visible'); this.onHide?.(); }

    private render(): void {
        this.list.innerHTML = '';
        const query = this.search.value.trim().toLowerCase();
        const items = this.presets.getPresets().filter((preset) =>
            !query || preset.name.toLowerCase().includes(query) || preset.elementTitle.toLowerCase().includes(query));
        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'preset-empty';
            empty.innerHTML = '<i data-lucide="bookmark-plus"></i><strong>No presets yet</strong><span>Select an element, open its ••• menu and choose “Save as preset”.</span>';
            this.list.appendChild(empty);
            createIcons({ icons });
            return;
        }

        const groups = new Map<string, typeof items>();
        for (const preset of items) {
            const group = groups.get(preset.elementTitle) ?? [];
            group.push(preset);
            groups.set(preset.elementTitle, group);
        }
        for (const [title, group] of groups) {
            const section = document.createElement('section');
            section.className = 'preset-group';
            const heading = document.createElement('h3');
            heading.textContent = title;
            section.appendChild(heading);
            for (const preset of group) {
                const card = document.createElement('article');
                card.className = 'preset-card';
                card.draggable = true;
                if (this.presets.isDefault(preset)) card.classList.add('default');
                card.title = `Drag “${preset.name}” onto a ${preset.elementTitle}`;
                card.innerHTML = `
                    <div class="preset-card-icon"><i data-lucide="${this.iconFor(preset.elementType)}"></i></div>
                    <div class="preset-card-copy"><strong></strong><span>${Object.keys(preset.properties).length} properties · ${Object.keys(preset.textures).length} textures</span></div>
                    <button type="button" class="preset-default" title="Toggle default"><i data-lucide="star"></i></button>
                    <button type="button" class="preset-delete" title="Delete preset"><i data-lucide="trash-2"></i></button>`;
                (card.querySelector('.preset-card-copy strong') as HTMLElement).textContent = preset.name;
                card.addEventListener('dragstart', (event) => {
                    event.dataTransfer?.setData('application/x-santown-preset-id', preset.id);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
                });
                card.querySelector('.preset-default')?.addEventListener('click', () => this.presets.setDefault(preset.id));
                card.querySelector('.preset-delete')?.addEventListener('click', () => this.presets.deletePreset(preset.id));
                section.appendChild(card);
            }
            this.list.appendChild(section);
        }
        createIcons({ icons });
    }

    private iconFor(type: string): string {
        const iconsByType: Record<string, string> = {
            Road: 'route', Terrain: 'mountain',
            TerrainCutSpline: 'spline', RiverSpline: 'waves', Fence: 'panels-top-left',
        };
        return iconsByType[type] ?? 'box';
    }
}
