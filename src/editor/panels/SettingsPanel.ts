import { singleton, inject } from 'tsyringe';
import { createIcons, icons } from 'lucide';
import ProjectSettings from '../ProjectSettings';
import HistoryManager from '../HistoryManager';

@singleton()
export default class SettingsPanel {
    private readonly container: HTMLElement;
    private activeActionLabel: string | null = null;

    constructor(
        @inject(ProjectSettings) private readonly settings: ProjectSettings,
        @inject(HistoryManager) private readonly history: HistoryManager,
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
                <div class="sp-heading"><span class="sp-eyebrow">Viewport</span><span class="sp-title">Visual Settings</span></div>
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
