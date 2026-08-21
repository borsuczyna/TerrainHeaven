import { singleton, inject } from 'tsyringe';
import { createIcons, icons } from 'lucide';
import UnityExporter from '../../export/UnityExporter';
import { MAX_LOD_INDEX } from '../../export/LODLevels';

@singleton()
export default class ExportPanel {
    private readonly container: HTMLElement;
    private lodLevels = 3;
    private scale = 1;
    private exporting = false;
    private errorMessage: string | null = null;
    private progressMessage: string | null = null;
    private progressStatusEl: HTMLElement | null = null;

    constructor(@inject(UnityExporter) private readonly exporter: UnityExporter) {
        this.container = document.createElement('div');
        this.container.id = 'export-panel';
        document.body.appendChild(this.container);
        this.build();
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

    private build(): void {
        this.container.innerHTML = `
            <div class="ep-header">
                <div class="ep-heading"><span class="ep-eyebrow">Unity</span><span class="ep-title">Export Map</span></div>
                <button class="ep-close" type="button" aria-label="Close"><i data-lucide="x"></i></button>
            </div>
            <div class="ep-body">
                <div class="ep-row">
                    <label class="ep-label">LOD Levels</label>
                    <input type="number" class="ep-input" min="1" max="${MAX_LOD_INDEX + 1}" step="1" value="${this.lodLevels}" data-prop="lodLevels">
                </div>
                <p class="ep-help">How many detail levels to bake per terrain tile/road/river (1-${MAX_LOD_INDEX + 1}). LOD 0 matches what's on screen; each level above it is a fixed, coarser preset - use Settings &gt; LOD Preview to see them before exporting.</p>
                <div class="ep-row">
                    <label class="ep-label">Scale</label>
                    <input type="number" class="ep-input" min="0.01" step="0.1" value="${this.scale}" data-prop="scale">
                </div>
                <p class="ep-help">Uniform scale baked into every exported position (terrain, roads, foliage placements).</p>
                <button type="button" class="ep-export" data-action="export" ${this.exporting ? 'disabled' : ''}>
                    <i data-lucide="upload"></i><span>${this.exporting ? 'Exporting...' : 'Export to Unity'}</span>
                </button>
                ${this.exporting ? '<p class="ep-progress" data-role="progress"></p>' : ''}
                ${this.errorMessage ? `<p class="ep-error">${this.escapeHtml(this.errorMessage)}</p>` : ''}
            </div>
        `;

        this.progressStatusEl = this.container.querySelector<HTMLElement>('[data-role="progress"]');
        this.renderProgress();

        this.container.querySelector('.ep-close')?.addEventListener('click', () => this.hide());

        const lodInput = this.container.querySelector<HTMLInputElement>('[data-prop="lodLevels"]');
        lodInput?.addEventListener('change', () => {
            const parsed = Math.round(Number(lodInput.value));
            this.lodLevels = Math.min(MAX_LOD_INDEX + 1, Math.max(1, Number.isFinite(parsed) ? parsed : this.lodLevels));
            lodInput.value = String(this.lodLevels);
        });

        const scaleInput = this.container.querySelector<HTMLInputElement>('[data-prop="scale"]');
        scaleInput?.addEventListener('change', () => {
            const parsed = Number(scaleInput.value);
            this.scale = parsed > 0 ? parsed : this.scale;
            scaleInput.value = String(this.scale);
        });

        const exportButton = this.container.querySelector<HTMLButtonElement>('[data-action="export"]');
        exportButton?.addEventListener('click', () => void this.runExport());

        createIcons({ icons });
    }

    private async runExport(): Promise<void> {
        if (this.exporting) return;
        this.exporting = true;
        this.errorMessage = null;
        this.progressMessage = null;
        this.build();
        try {
            await this.exporter.export({ lodLevels: this.lodLevels, scale: this.scale }, (progress) => {
                this.progressMessage = `${progress.message} (${progress.current}/${progress.total})`;
                this.renderProgress();
            });
        } catch (error) {
            console.error('Unity export failed:', error);
            this.errorMessage = error instanceof Error ? error.message : 'Export failed.';
        } finally {
            this.exporting = false;
            this.build();
        }
    }

    // Updates the progress line directly rather than going through build() on every
    // tick, so a fast export doesn't repeatedly rebuild the whole panel/re-run
    // createIcons for no visible benefit.
    private renderProgress(): void {
        if (this.progressStatusEl) this.progressStatusEl.textContent = this.progressMessage ?? '';
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
