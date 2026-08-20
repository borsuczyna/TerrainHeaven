import { singleton, inject } from 'tsyringe';
import Camera from '../Camera';

type ViewName = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

const VIEWS: { view: ViewName; label: string }[] = [
    { view: 'front', label: 'Front' },
    { view: 'top', label: 'Top' },
    { view: 'back', label: 'Back' },
    { view: 'left', label: 'Left' },
    { view: 'bottom', label: 'Bottom' },
    { view: 'right', label: 'Right' },
];

@singleton()
export default class ViewGizmoMenu {
    private readonly menu: HTMLDivElement;
    private button: HTMLButtonElement | null = null;

    constructor(@inject(Camera) private readonly camera: Camera) {
        this.menu = document.createElement('div');
        this.menu.id = 'view-gizmo-menu';
        this.menu.innerHTML = `
            <div class="view-gizmo-grid">
                ${VIEWS.map((v) => `<button type="button" class="view-gizmo-btn" data-view="${v.view}">${v.label}</button>`).join('')}
            </div>
        `;
        document.body.appendChild(this.menu);

        this.menu.querySelectorAll<HTMLButtonElement>('.view-gizmo-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.camera.setView(btn.dataset.view as ViewName);
                this.hide();
            });
        });
        this.menu.addEventListener('click', (e) => e.stopPropagation());

        document.addEventListener('click', () => this.hide());
    }

    public init(button: HTMLButtonElement): void {
        this.button = button;
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });
    }

    public toggle(): void {
        if (this.menu.classList.contains('visible')) this.hide();
        else this.show();
    }

    public show(): void {
        if (!this.button) return;
        const rect = this.button.getBoundingClientRect();
        const menuWidth = 176;
        this.menu.style.left = `${Math.max(8, rect.right - menuWidth)}px`;
        this.menu.style.top = `${rect.bottom + 8}px`;
        this.menu.classList.add('visible');
        this.button.classList.add('active');
    }

    public hide(): void {
        this.menu.classList.remove('visible');
        this.button?.classList.remove('active');
    }
}
