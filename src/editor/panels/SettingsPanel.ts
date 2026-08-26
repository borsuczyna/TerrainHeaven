import { singleton, inject } from 'tsyringe';
import { createIcons, icons } from 'lucide';
import ProjectSettings from '../ProjectSettings';
import HistoryManager from '../HistoryManager';
import LODPreviewManager from '../LODPreviewManager';

@singleton()
export default class SettingsPanel {
    private readonly container: HTMLElement;
    private activeActionLabel: string | null = null;

    constructor(
        @inject(ProjectSettings) private readonly settings: ProjectSettings,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(LODPreviewManager) private readonly lodPreview: LODPreviewManager,
    ) {
        this.container = document.createElement('div');
        this.container.id = 'settings-panel';
        document.body.appendChild(this.container);
        this.settings.onTimeChanged = (hour) => this.syncTimeDisplay(hour);
        this.build();
    }

    public toggle(): void {
        this.container.classList.toggle('visible');
    }

    public show(): void {
        this.build();
        this.container.classList.add('visible');
    }

    public hide(): void {
        this.container.classList.remove('visible');
    }

    public get isVisible(): boolean {
        return this.container.classList.contains('visible');
    }

    public refresh(): void {
        this.build();
    }

    private build(): void {
        const s = this.settings;
        this.container.innerHTML = `
            <div class="sp-header">
                <div class="sp-heading"><span class="sp-eyebrow">Viewport</span><span class="sp-title">Visual Settings</span><small>Lighting, grid and preview quality</small></div>
                <button class="sp-close" type="button" aria-label="Close"><i data-lucide="x"></i></button>
            </div>
            <div class="sp-body">
                <div class="sp-section">
                    <div class="sp-section-label">Rendering</div>
                    <div class="sp-row">
                        <label class="sp-label">Enhanced Visuals</label>
                        <input type="checkbox" class="sp-checkbox" ${s.enhancedVisuals ? 'checked' : ''} data-prop="enhancedVisuals">
                    </div>
                    <p class="sp-help">Warm sunlight, soft shadows and lightweight day/night lighting.</p>
                </div>
                ${s.enhancedVisuals ? this.buildEnhancedControls() : this.buildBasicControls()}
                <div class="sp-section">
                    <div class="sp-section-label">Unity Export</div>
                    <div class="sp-row">
                        <label class="sp-label">LOD Preview</label>
                        <select class="sp-select" data-prop="lodPreview">
                            <option value="0" ${this.lodPreview.level === 0 ? 'selected' : ''}>Full detail</option>
                            <option value="1" ${this.lodPreview.level === 1 ? 'selected' : ''}>LOD 1</option>
                            <option value="2" ${this.lodPreview.level === 2 ? 'selected' : ''}>LOD 2</option>
                            <option value="3" ${this.lodPreview.level === 3 ? 'selected' : ''}>LOD 3</option>
                        </select>
                    </div>
                    <p class="sp-help">Temporarily view terrain/roads/rivers at one of the Unity exporter's LOD levels. Not saved with the project.</p>
                    <div class="sp-row sp-wide-row">
                        <label class="sp-label">LOD 0 &rarr; 1 Distance</label>
                        <input type="range" class="sp-slider" min="1" max="500" step="1" value="${s.lodDistances[0]}" data-prop="lodDistance0">
                        <span class="sp-value sp-lod-distance-0-value">${Math.round(s.lodDistances[0])}m</span>
                    </div>
                    <div class="sp-row sp-wide-row">
                        <label class="sp-label">LOD 1 &rarr; 2 Distance</label>
                        <input type="range" class="sp-slider" min="1" max="1000" step="1" value="${s.lodDistances[1]}" data-prop="lodDistance1">
                        <span class="sp-value sp-lod-distance-1-value">${Math.round(s.lodDistances[1])}m</span>
                    </div>
                    <div class="sp-row sp-wide-row">
                        <label class="sp-label">LOD 2 &rarr; 3 Distance</label>
                        <input type="range" class="sp-slider" min="1" max="2000" step="1" value="${s.lodDistances[2]}" data-prop="lodDistance2">
                        <span class="sp-value sp-lod-distance-2-value">${Math.round(s.lodDistances[2])}m</span>
                    </div>
                    <p class="sp-help">How far the camera must be before the Unity importer switches to the next LOD. Wider gaps between these three values make the switch less noticeable.</p>
                </div>
            </div>
        `;

        this.container.querySelector('.sp-close')?.addEventListener('click', () => this.hide());
        this.bindCheckbox('enhancedVisuals', 'Toggle Enhanced Visuals', (checked) => {
            s.enhancedVisuals = checked;
            s.apply();
            this.build();
        });

        if (s.enhancedVisuals) this.bindEnhancedControls();
        else this.bindBasicControls();

        const lodSelect = this.container.querySelector<HTMLSelectElement>('[data-prop="lodPreview"]');
        lodSelect?.addEventListener('change', () => this.lodPreview.setLevel(Number(lodSelect.value)));

        this.bindLodDistance(0, 'lodDistance0', '.sp-lod-distance-0-value');
        this.bindLodDistance(1, 'lodDistance1', '.sp-lod-distance-1-value');
        this.bindLodDistance(2, 'lodDistance2', '.sp-lod-distance-2-value');

        createIcons({ icons });
    }

    private buildEnhancedControls(): string {
        const s = this.settings;
        return `
            <div class="sp-section">
                <div class="sp-section-label">Time &amp; Atmosphere</div>
                <div class="sp-row sp-wide-row">
                    <label class="sp-label">Time of Day</label>
                    <input type="range" class="sp-slider" min="0" max="24" step="0.1" value="${s.hour}" data-prop="hour">
                    <span class="sp-value sp-hour-value">${this.formatHour(s.hour)}</span>
                </div>
                <div class="sp-row">
                    <label class="sp-label">Day / Night Cycle</label>
                    <input type="checkbox" class="sp-checkbox" ${s.dayNightCycle ? 'checked' : ''} data-prop="dayNightCycle">
                </div>
                ${s.dayNightCycle ? `
                    <div class="sp-row sp-wide-row">
                        <label class="sp-label">Day Length</label>
                        <input type="range" class="sp-slider" min="30" max="1200" step="30" value="${s.dayLength}" data-prop="dayLength">
                        <span class="sp-value sp-day-length-value">${this.formatDuration(s.dayLength)}</span>
                    </div>
                ` : ''}
            </div>
        `;
    }

    private buildBasicControls(): string {
        const s = this.settings;
        return `
            <div class="sp-section">
                <div class="sp-section-label">Basic Sky</div>
                <div class="sp-row sp-sky-color-row" style="display: ${s.dayNightCycle ? 'none' : 'flex'}">
                    <label class="sp-label">Color</label>
                    <input type="color" class="sp-color" value="${s.skyColor}" data-prop="skyColor">
                </div>
                <div class="sp-row">
                    <label class="sp-label">Day / Night</label>
                    <input type="checkbox" class="sp-checkbox" ${s.dayNightCycle ? 'checked' : ''} data-prop="dayNightCycle">
                </div>
                ${s.dayNightCycle ? `
                    <div class="sp-row sp-wide-row">
                        <label class="sp-label">Time of Day</label>
                        <input type="range" class="sp-slider" min="0" max="24" step="0.1" value="${s.hour}" data-prop="hour">
                        <span class="sp-value sp-hour-value">${this.formatHour(s.hour)}</span>
                    </div>
                ` : ''}
            </div>
        `;
    }

    private bindEnhancedControls(): void {
        this.bindCheckbox('dayNightCycle', 'Toggle Day/Night Cycle', (checked) => {
            this.settings.dayNightCycle = checked;
            this.settings.apply();
            this.build();
        });
        this.bindHour();

        const dayLength = this.container.querySelector<HTMLInputElement>('[data-prop="dayLength"]');
        dayLength?.addEventListener('input', () => {
            this.beginAction('Change Day Length');
            this.settings.dayLength = Number(dayLength.value);
            const value = this.container.querySelector('.sp-day-length-value');
            if (value) value.textContent = this.formatDuration(this.settings.dayLength);
        });
        dayLength?.addEventListener('change', () => this.endAction('Change Day Length'));
    }

    private bindBasicControls(): void {
        const skyColor = this.container.querySelector<HTMLInputElement>('[data-prop="skyColor"]');
        skyColor?.addEventListener('input', () => {
            this.beginAction('Change Sky Color');
            this.settings.skyColor = skyColor.value;
            this.settings.apply();
        });
        skyColor?.addEventListener('change', () => this.endAction('Change Sky Color'));

        this.bindCheckbox('dayNightCycle', 'Toggle Day/Night', (checked) => {
            this.settings.dayNightCycle = checked;
            this.settings.apply();
            this.build();
        });
        this.bindHour();
    }

    private bindLodDistance(index: 0 | 1 | 2, prop: string, valueSelector: string): void {
        const label = `Change LOD ${index} Distance`;
        const input = this.container.querySelector<HTMLInputElement>(`[data-prop="${prop}"]`);
        input?.addEventListener('input', () => {
            this.beginAction(label);
            this.settings.setLodDistance(index, Number(input.value));
            const value = this.container.querySelector(valueSelector);
            if (value) value.textContent = `${Math.round(this.settings.lodDistances[index])}m`;
        });
        input?.addEventListener('change', () => this.endAction(label));
    }

    private bindHour(): void {
        const hour = this.container.querySelector<HTMLInputElement>('[data-prop="hour"]');
        hour?.addEventListener('input', () => {
            this.beginAction('Change Time Of Day');
            this.settings.hour = Number(hour.value);
            this.settings.apply();
            this.syncTimeDisplay(this.settings.hour);
        });
        hour?.addEventListener('change', () => this.endAction('Change Time Of Day'));
    }

    private bindCheckbox(prop: string, label: string, onChange: (checked: boolean) => void): void {
        const checkbox = this.container.querySelector<HTMLInputElement>(`[data-prop="${prop}"]`);
        checkbox?.addEventListener('change', () => {
            this.history.beginAction(label);
            onChange(checkbox.checked);
            this.history.endAction(label);
        });
    }

    private syncTimeDisplay(hour: number): void {
        if (!this.isVisible) return;
        const input = this.container.querySelector<HTMLInputElement>('[data-prop="hour"]');
        const value = this.container.querySelector('.sp-hour-value');
        if (input && document.activeElement !== input) input.value = String(hour);
        if (value) value.textContent = this.formatHour(hour);
    }

    private formatHour(hour: number): string {
        const normalized = ((hour % 24) + 24) % 24;
        const whole = Math.floor(normalized);
        const minutes = Math.floor((normalized - whole) * 60);
        return `${whole.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }

    private formatDuration(seconds: number): string {
        if (seconds < 60) return `${Math.round(seconds)}s`;
        return `${Math.round(seconds / 60)}m`;
    }

    private beginAction(label: string): void {
        if (this.activeActionLabel) return;
        this.activeActionLabel = label;
        this.history.beginAction(label);
    }

    private endAction(label: string): void {
        if (this.activeActionLabel !== label) return;
        this.activeActionLabel = null;
        this.history.endAction(label);
    }
}
