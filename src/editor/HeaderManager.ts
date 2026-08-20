import { singleton, inject } from 'tsyringe';
import SettingsPanel from './panels/SettingsPanel';
import ProjectSerializer from './ProjectSerializer';
import SelectionManager from './SelectionManager';
import HistoryManager from './HistoryManager';

@singleton()
export default class HeaderManager {
    constructor(
        @inject(SettingsPanel) private readonly settingsPanel: SettingsPanel,
        @inject(ProjectSerializer) private readonly serializer: ProjectSerializer,
        @inject(SelectionManager) private readonly selection: SelectionManager,
        @inject(HistoryManager) private readonly history: HistoryManager,
    ) {}

    public init(): void {
        const btnSettings = document.getElementById('header-settings') as HTMLButtonElement;
        const btnSave = document.getElementById('header-save') as HTMLButtonElement;
        const btnLoad = document.getElementById('header-load') as HTMLButtonElement;

        btnSettings.addEventListener('click', () => {
            btnSettings.blur();
            if (this.settingsPanel.isVisible) {
                this.settingsPanel.hide();
                btnSettings.classList.remove('active');
            } else {
                this.settingsPanel.show();
                btnSettings.classList.add('active');
            }
        });

        btnSave.addEventListener('click', () => {
            btnSave.blur();
            void this.saveWithDialog();
        });

        btnLoad.addEventListener('click', () => {
            // Buttons keep keyboard focus after a click, so without this, pressing
            // Space to fly up in the viewport re-triggers this button's click handler
            // and reopens the load dialog.
            btnLoad.blur();
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.santown,.json';
            input.addEventListener('change', () => {
                const file = input.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    try {
                        this.serializer.load(reader.result as string);
                        this.selection.clearSelection();
                        this.history.reset('Loaded Project', reader.result as string);
                    } catch (e) {
                        console.error('Failed to load project:', e);
                    }
                };
                reader.readAsText(file);
            });
            input.click();
        });
    }

    private async saveWithDialog(): Promise<void> {
        const json = this.serializer.save();

        try {
            const picker = (window as any).showSaveFilePicker as undefined | ((opts: any) => Promise<any>);
            if (picker) {
                const handle = await picker({
                    suggestedName: 'project.santown',
                    types: [{
                        description: 'TerrainHeaven Project',
                        accept: { 'application/json': ['.santown', '.json'] },
                    }],
                });
                const writable = await handle.createWritable();
                await writable.write(json);
                await writable.close();
                return;
            }
        } catch {
            // User may cancel the dialog; do not force fallback in that case.
            return;
        }

        // Fallback for browsers without File System Access API.
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'project.santown';
        a.click();
        URL.revokeObjectURL(url);
    }
}
