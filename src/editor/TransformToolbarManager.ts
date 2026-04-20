import { singleton, inject } from 'tsyringe';
import { createIcons, icons } from 'lucide';
import GizmoManager, { type GizmoModeState } from './GizmoManager';

@singleton()
export default class TransformToolbarManager {
    private translateButton: HTMLButtonElement | null = null;
    private rotateButton: HTMLButtonElement | null = null;
    private toolbar: HTMLElement | null = null;
    private propertiesPanel: HTMLElement | null = null;
    private propertiesObserver: MutationObserver | null = null;

    constructor(@inject(GizmoManager) private readonly gizmo: GizmoManager) {}

    public init(): void {
        this.toolbar = document.getElementById('transform-toolbar');
        this.translateButton = document.getElementById('btn-transform-translate') as HTMLButtonElement | null;
        this.rotateButton = document.getElementById('btn-transform-rotate') as HTMLButtonElement | null;
        this.propertiesPanel = document.getElementById('properties-panel');
        if (!this.toolbar || !this.translateButton || !this.rotateButton) return;

        this.translateButton.dataset.tooltip = 'Translate [G]';
        this.rotateButton.dataset.tooltip = 'Rotate [E]';

        this.translateButton.addEventListener('click', () => {
            this.gizmo.setMode('translate');
        });

        this.rotateButton.addEventListener('click', () => {
            this.gizmo.setMode('rotate');
        });

        this.gizmo.onModeStateChanged = (state) => {
            this.syncState(state);
        };

        this.bindPropertiesPanelState();
        this.syncState(this.gizmo.getModeState());
        createIcons({ icons });
    }

    private bindPropertiesPanelState(): void {
        if (!this.toolbar || !this.propertiesPanel) return;

        const syncPosition = () => {
            this.toolbar?.classList.toggle('properties-open', this.propertiesPanel?.classList.contains('visible') ?? false);
        };

        this.propertiesObserver?.disconnect();
        this.propertiesObserver = new MutationObserver(syncPosition);
        this.propertiesObserver.observe(this.propertiesPanel, {
            attributes: true,
            attributeFilter: ['class'],
        });
        syncPosition();
    }

    private syncState(state: GizmoModeState): void {
        if (!this.translateButton || !this.rotateButton) return;

        this.translateButton.classList.toggle('active', state.effective === 'translate');
        this.rotateButton.classList.toggle('active', state.effective === 'rotate');
        this.rotateButton.disabled = !state.canRotate;
    }
}