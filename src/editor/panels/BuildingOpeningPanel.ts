import { createIcons, icons } from 'lucide';
import { singleton } from 'tsyringe';

export interface BuildingOpeningSettings {
    type: 'window' | 'door';
}

@singleton()
export default class BuildingOpeningPanel {
    public readonly settings: BuildingOpeningSettings = {
        type: 'window',
    };

    private readonly container: HTMLElement;
    private visible = false;

    constructor() {
        this.container = document.createElement('aside');
        this.container.id = 'building-opening-panel';
        this.container.innerHTML = `
            <div class="building-opening-header">
                <div><span>Building</span><strong>Windows &amp; Doors</strong><small>Place openings on walls</small></div>
                <button type="button" data-action="close" aria-label="Close"><i data-lucide="x"></i></button>
            </div>
            <div class="building-opening-body">
                <section>
                    <h3>Type</h3>
                    <div class="building-opening-modes">
                        <button type="button" data-type="window" class="active"><i data-lucide="app-window"></i> Window</button>
                        <button type="button" data-type="door"><i data-lucide="door-open"></i> Door</button>
                    </div>
                </section>
                <div class="building-opening-help"><i data-lucide="mouse-pointer-2"></i><span>Click a wall to cut an opening. Select it afterward to adjust width, height, sill height and position.</span></div>
            </div>
        `;
        document.body.appendChild(this.container);
        this.bind();
        this.renderType();
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

    private bind(): void {
        this.container.querySelector('[data-action="close"]')?.addEventListener('click', () => this.hide());
        this.container.querySelectorAll<HTMLButtonElement>('[data-type]').forEach((button) => {
            button.addEventListener('click', () => {
                this.settings.type = button.dataset.type === 'door' ? 'door' : 'window';
                this.renderType();
            });
        });
    }

    private renderType(): void {
        this.container.querySelectorAll<HTMLButtonElement>('[data-type]').forEach((button) => {
            button.classList.toggle('active', button.dataset.type === this.settings.type);
        });
    }
}
