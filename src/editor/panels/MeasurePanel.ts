import { createIcons, icons } from 'lucide';
import { singleton } from 'tsyringe';

@singleton()
export default class MeasurePanel {
    public onClear: (() => void) | null = null;

    private readonly container: HTMLElement;
    private readonly pointAEl: HTMLElement;
    private readonly pointBEl: HTMLElement;
    private readonly distanceEl: HTMLElement;
    private readonly dxEl: HTMLElement;
    private readonly dyEl: HTMLElement;
    private readonly dzEl: HTMLElement;
    private visible = false;

    constructor() {
        this.container = document.createElement('aside');
        this.container.id = 'measure-panel';
        this.container.innerHTML = `
            <div class="measure-header">
                <div><span>Utility</span><strong>Measure</strong></div>
                <button type="button" data-action="close" aria-label="Close measure tool"><i data-lucide="x"></i></button>
            </div>
            <div class="measure-body">
                <div class="measure-readout">
                    <div class="measure-row"><span>Point A</span><b data-role="a">-</b></div>
                    <div class="measure-row"><span>Point B</span><b data-role="b">-</b></div>
                    <div class="measure-distance"><span>Distance</span><strong data-role="distance">-</strong></div>
                    <div class="measure-delta">
                        <div><span>Δ X</span><b data-role="dx">-</b></div>
                        <div><span>Δ Y</span><b data-role="dy">-</b></div>
                        <div><span>Δ Z</span><b data-role="dz">-</b></div>
                    </div>
                </div>
                <button type="button" class="measure-clear" data-action="clear"><i data-lucide="rotate-ccw"></i> Clear</button>
                <div class="measure-help"><i data-lucide="mouse-pointer-2"></i><span><b>LMB</b> picks a point, snapping to nearby vertices and aligning with the first point.<br>A third click starts a new measurement. <b>Escape</b> clears, <b>Backspace</b> undoes the last point.</span></div>
            </div>
        `;
        document.body.appendChild(this.container);
        this.pointAEl = this.container.querySelector('[data-role="a"]')!;
        this.pointBEl = this.container.querySelector('[data-role="b"]')!;
        this.distanceEl = this.container.querySelector('[data-role="distance"]')!;
        this.dxEl = this.container.querySelector('[data-role="dx"]')!;
        this.dyEl = this.container.querySelector('[data-role="dy"]')!;
        this.dzEl = this.container.querySelector('[data-role="dz"]')!;
        this.container.querySelector('[data-action="close"]')?.addEventListener('click', () => this.hide());
        this.container.querySelector('[data-action="clear"]')?.addEventListener('click', () => this.onClear?.());
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

    public setPointA(point: { x: number; y: number; z: number } | null): void {
        this.pointAEl.textContent = point ? this.formatPoint(point) : '-';
    }

    public setPointB(point: { x: number; y: number; z: number } | null): void {
        this.pointBEl.textContent = point ? this.formatPoint(point) : '-';
    }

    public setDistance(a: { x: number; y: number; z: number } | null, b: { x: number; y: number; z: number } | null): void {
        if (!a || !b) {
            this.distanceEl.textContent = '-';
            this.dxEl.textContent = this.dyEl.textContent = this.dzEl.textContent = '-';
            return;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        this.distanceEl.textContent = `${distance.toFixed(2)} m`;
        this.dxEl.textContent = dx.toFixed(2);
        this.dyEl.textContent = dy.toFixed(2);
        this.dzEl.textContent = dz.toFixed(2);
    }

    private formatPoint(point: { x: number; y: number; z: number }): string {
        return `${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)}`;
    }
}
