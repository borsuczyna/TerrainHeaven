import { createIcons, icons } from 'lucide';
import { singleton } from 'tsyringe';

export interface TerrainPolygonSettings {
    flat: boolean;
}

@singleton()
export default class TerrainPolygonPanel {
    public readonly settings: TerrainPolygonSettings = {
        flat: true,
    };
    public onCancel: (() => void) | null = null;

    private readonly container: HTMLElement;
    private readonly countEl: HTMLElement;
    private visible = false;

    constructor() {
        this.container = document.createElement('aside');
        this.container.id = 'terrain-polygon-panel';
        this.container.innerHTML = `
            <div class="terrain-polygon-header">
                <div><span>Terrain</span><strong>Polygon Terrain</strong><small>Draw a custom terrain footprint</small></div>
                <button type="button" data-action="close" aria-label="Close polygon terrain tool"><i data-lucide="x"></i></button>
            </div>
            <div class="terrain-polygon-body">
                <section>
                    <h3>Shape</h3>
                    <div class="terrain-polygon-modes">
                        <button type="button" data-mode="flat" class="active"><i data-lucide="square"></i> Flat</button>
                        <button type="button" data-mode="nonflat"><i data-lucide="mountain-snow"></i> Non-Flat</button>
                    </div>
                </section>
                <div class="terrain-polygon-count"><i data-lucide="hexagon"></i><span><b data-role="count">0</b> points placed</span></div>
                <button type="button" class="terrain-polygon-cancel" data-action="cancel"><i data-lucide="x-circle"></i> Cancel Shape</button>
                <div class="terrain-polygon-help"><i data-lucide="mouse-pointer-2"></i><span><b>LMB</b> adds a point, <b>Shift</b> snaps it to 45°.<br><b>Click the first point</b> (or press <b>Enter</b>) to close the loop and finish.<br><b>Backspace</b> removes the last point, <b>Escape</b> cancels.<br>In <b>Flat</b> mode every new point locks to the first point's height.</span></div>
            </div>
        `;
        document.body.appendChild(this.container);
        this.countEl = this.container.querySelector('[data-role="count"]')!;
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
    }

    public setPointCount(count: number): void {
        this.countEl.textContent = String(count);
    }

    private bind(): void {
        this.container.querySelector('[data-action="close"]')?.addEventListener('click', () => this.onCancel?.());
        this.container.querySelector('[data-action="cancel"]')?.addEventListener('click', () => this.onCancel?.());
        this.container.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
            button.addEventListener('click', () => {
                this.settings.flat = button.dataset.mode === 'flat';
                this.renderMode();
            });
        });
    }

    private renderMode(): void {
        this.container.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
            const isFlat = button.dataset.mode === 'flat';
            button.classList.toggle('active', isFlat === this.settings.flat);
        });
    }
}
