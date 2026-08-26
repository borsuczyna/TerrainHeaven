import { createIcons, icons } from 'lucide';
import { singleton } from 'tsyringe';

export type HeightPaintMode = 'raise' | 'lower' | 'smooth';

export interface HeightPaintBrushSettings {
    radius: number;
    strength: number;
    mode: HeightPaintMode;
}

@singleton()
export default class HeightPaintPanel {
    public readonly settings: HeightPaintBrushSettings = {
        radius: 3,
        strength: 0.25,
        mode: 'raise',
    };
    public onClear: (() => void) | null = null;

    private readonly container: HTMLElement;
    private visible = false;

    constructor() {
        this.container = document.createElement('aside');
        this.container.id = 'height-paint-panel';
        this.container.innerHTML = `
            <div class="height-paint-header">
                <div><span>Terrain</span><strong>Height Map Painter</strong><small>Sculpt the terrain surface</small></div>
                <button type="button" data-action="close" aria-label="Close height map painter"><i data-lucide="x"></i></button>
            </div>
            <div class="height-paint-body">
                <section>
                    <h3>Mode</h3>
                    <div class="height-paint-modes height-paint-modes-3">
                        <button type="button" data-mode="raise" class="active"><i data-lucide="arrow-up"></i> Raise</button>
                        <button type="button" data-mode="lower"><i data-lucide="arrow-down"></i> Lower</button>
                        <button type="button" data-mode="smooth"><i data-lucide="blend"></i> Smooth</button>
                    </div>
                </section>
                <section>
                    <h3>Brush</h3>
                    <label><span>Radius</span><input type="number" min="0.5" max="25" step="0.25" data-setting="radius" value="3"></label>
                    <label><span>Strength</span><input type="number" min="0.01" max="5" step="0.05" data-setting="strength" value="0.25"></label>
                </section>
                <button type="button" class="height-paint-clear" data-action="clear"><i data-lucide="rotate-ccw"></i> Clear Painted Height</button>
                <div class="height-paint-help"><i data-lucide="mouse-pointer-2"></i><span><b>LMB + drag</b> paints height.<br><b>Ctrl + LMB</b> temporarily inverts Raise/Lower (no effect on Smooth).</span></div>
            </div>
        `;
        document.body.appendChild(this.container);
        this.bind();
        this.renderMode();
        createIcons({ icons });
    }

    public get isVisible(): boolean { return this.visible; }

    public show(): void {
        this.visible = true;
        this.container.classList.add('visible');
    }

    public hide(): void {
        this.visible = false;
        this.container.classList.remove('visible');
        window.dispatchEvent(new CustomEvent('height-paint-panel-closed'));
    }

    private bind(): void {
        this.container.querySelector('[data-action="close"]')?.addEventListener('click', () => this.hide());
        this.container.querySelector('[data-action="clear"]')?.addEventListener('click', () => this.onClear?.());
        this.container.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
            button.addEventListener('click', () => {
                this.settings.mode = button.dataset.mode as HeightPaintMode;
                this.renderMode();
            });
        });
        this.bindNumber('radius', 0.5, 25);
        this.bindNumber('strength', 0.01, 5);
    }

    private bindNumber(name: 'radius' | 'strength', min: number, max: number): void {
        const input = this.container.querySelector<HTMLInputElement>(`[data-setting="${name}"]`)!;
        input.addEventListener('change', () => {
            const parsed = Number(input.value);
            this.settings[name] = Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : this.settings[name]));
            input.value = String(this.settings[name]);
        });
    }

    private renderMode(): void {
        this.container.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
            button.classList.toggle('active', button.dataset.mode === this.settings.mode);
        });
    }
}
