import type ProjectSettings from './ProjectSettings';

export default class SettingsPanel {
    private container: HTMLElement;
    private settings: ProjectSettings;

    constructor(settings: ProjectSettings) {
        this.settings = settings;
        this.container = document.createElement('div');
        this.container.id = 'settings-panel';
        document.body.appendChild(this.container);
        this.build();
    }

    public toggle(): void {
        this.container.classList.toggle('visible');
    }

    public show(): void {
        this.refresh();
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
                <span class="sp-title">Project Settings</span>
                <button class="sp-close">&times;</button>
            </div>
            <div class="sp-body">
                <div class="sp-section">
                    <div class="sp-section-label">Sky</div>
                    <div class="sp-row sp-sky-color-row" style="display: ${s.dayNightCycle ? 'none' : 'flex'}">
                        <label class="sp-label">Color</label>
                        <input type="color" class="sp-color" value="${s.skyColor}" data-prop="skyColor">
                    </div>
                </div>
                <div class="sp-section">
                    <div class="sp-section-label">Day / Night</div>
                    <div class="sp-row">
                        <label class="sp-label">Enable</label>
                        <input type="checkbox" class="sp-checkbox" ${s.dayNightCycle ? 'checked' : ''} data-prop="dayNightCycle">
                    </div>
                    <div class="sp-row sp-hour-row" style="display: ${s.dayNightCycle ? 'flex' : 'none'}">
                        <label class="sp-label">Hour</label>
                        <input type="range" class="sp-slider" min="0" max="24" step="0.5" value="${s.hour}" data-prop="hour">
                        <span class="sp-hour-value">${s.hour.toFixed(1)}</span>
                    </div>
                </div>
            </div>
        `;

        this.container.querySelector('.sp-close')!.addEventListener('click', () => this.hide());

        this.container.querySelector('[data-prop="skyColor"]')!.addEventListener('input', (e) => {
            s.skyColor = (e.target as HTMLInputElement).value;
            s.apply();
        });

        this.container.querySelector('[data-prop="dayNightCycle"]')!.addEventListener('change', (e) => {
            s.dayNightCycle = (e.target as HTMLInputElement).checked;
            s.apply();
            this.build();
        });

        this.container.querySelector('[data-prop="hour"]')!.addEventListener('input', (e) => {
            s.hour = parseFloat((e.target as HTMLInputElement).value);
            s.apply();
            (this.container.querySelector('.sp-hour-value') as HTMLElement).textContent = s.hour.toFixed(1);
        });
    }
}
