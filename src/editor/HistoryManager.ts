import { singleton, inject } from 'tsyringe';
import { createIcons, icons } from 'lucide';
import ProjectSerializer from './ProjectSerializer';

interface HistoryEntry {
    label: string;
    snapshot: string;
}

@singleton()
export default class HistoryManager {
    private readonly entries: HistoryEntry[] = [];
    private index = -1;
    private isRestoring = false;
    private pendingAction: { label: string; beforeSnapshot: string } | null = null;

    private container: HTMLElement;
    private list: HTMLElement;
    private toggleButton: HTMLButtonElement;
    private undoButton: HTMLButtonElement;
    private redoButton: HTMLButtonElement;
    private status: HTMLElement;

    constructor(@inject(ProjectSerializer) private readonly serializer: ProjectSerializer) {
        this.container = document.createElement('section');
        this.container.id = 'history-panel';
        this.container.classList.add('folded');
        this.container.innerHTML = `
            <div class="history-header">
                <div class="history-header-main">
                    <span class="history-title">History</span>
                    <span class="history-status">0 / 0</span>
                </div>
                <div class="history-actions">
                    <button class="history-btn history-icon-btn" type="button" data-action="undo" title="Undo [Ctrl+Z]">
                        <i data-lucide="undo-2"></i>
                    </button>
                    <button class="history-btn history-icon-btn" type="button" data-action="redo" title="Redo [Ctrl+Y]">
                        <i data-lucide="redo-2"></i>
                    </button>
                    <button class="history-toggle" type="button" data-action="toggle" title="Fold history">▴</button>
                </div>
            </div>
            <div class="history-body">
                <div class="history-list"></div>
            </div>
        `;

        document.body.appendChild(this.container);

        this.list = this.container.querySelector('.history-list') as HTMLElement;
        this.status = this.container.querySelector('.history-status') as HTMLElement;
        this.toggleButton = this.container.querySelector('[data-action="toggle"]') as HTMLButtonElement;
        this.undoButton = this.container.querySelector('[data-action="undo"]') as HTMLButtonElement;
        this.redoButton = this.container.querySelector('[data-action="redo"]') as HTMLButtonElement;
    }

    public init(): void {
        this.toggleButton.addEventListener('click', () => {
            this.container.classList.toggle('folded');
            this.toggleButton.textContent = this.container.classList.contains('folded') ? '▴' : '▾';
        });

        this.undoButton.addEventListener('click', () => {
            this.undo();
        });

        this.redoButton.addEventListener('click', () => {
            this.redo();
        });

        createIcons({ icons });
        this.render();
    }

    public get canUndo(): boolean {
        return this.index > 0;
    }

    public get canRedo(): boolean {
        return this.index >= 0 && this.index < this.entries.length - 1;
    }

    public reset(label: string, snapshot?: string): void {
        const currentSnapshot = snapshot ?? this.serializer.save();
        this.entries.length = 0;
        this.entries.push({ label, snapshot: currentSnapshot });
        this.index = 0;
        this.pendingAction = null;
        this.render();
    }

    public record(label: string): void {
        if (this.isRestoring) return;
        this.pushSnapshot(label, this.serializer.save());
    }

    public beginAction(label: string): void {
        if (this.isRestoring || this.pendingAction) return;
        this.pendingAction = {
            label,
            beforeSnapshot: this.serializer.save(),
        };
    }

    public endAction(label?: string): void {
        if (this.isRestoring || !this.pendingAction) return;

        const actionLabel = label ?? this.pendingAction.label;
        const beforeSnapshot = this.pendingAction.beforeSnapshot;
        const afterSnapshot = this.serializer.save();
        this.pendingAction = null;

        if (beforeSnapshot === afterSnapshot) {
            return;
        }

        this.pushSnapshot(actionLabel, afterSnapshot);
    }

    public undo(): boolean {
        if (!this.canUndo) return false;
        this.applyIndex(this.index - 1);
        return true;
    }

    public redo(): boolean {
        if (!this.canRedo) return false;
        this.applyIndex(this.index + 1);
        return true;
    }

    private pushSnapshot(label: string, snapshot: string): void {
        const currentSnapshot = this.entries[this.index]?.snapshot;
        if (currentSnapshot === snapshot) return;

        if (this.index < this.entries.length - 1) {
            this.entries.splice(this.index + 1);
        }

        this.entries.push({ label, snapshot });
        this.index = this.entries.length - 1;
        this.render();
    }

    private applyIndex(nextIndex: number): void {
        const entry = this.entries[nextIndex];
        if (!entry) return;

        this.isRestoring = true;
        this.pendingAction = null;

        try {
            this.serializer.load(entry.snapshot);
            this.index = nextIndex;
            window.dispatchEvent(new CustomEvent('history-restored'));
        } finally {
            this.isRestoring = false;
            this.render();
        }
    }

    private render(): void {
        this.undoButton.disabled = !this.canUndo;
        this.redoButton.disabled = !this.canRedo;
        this.status.textContent = this.entries.length === 0 ? '0 / 0' : `${this.index + 1} / ${this.entries.length}`;

        this.list.innerHTML = '';

        if (this.entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'history-empty';
            empty.textContent = 'No history yet';
            this.list.appendChild(empty);
            return;
        }

        for (let i = this.entries.length - 1; i >= 0; i--) {
            const entry = this.entries[i];
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'history-entry';
            if (i === this.index) {
                row.classList.add('active');
            }
            row.innerHTML = `
                <span class="history-entry-index">${i + 1}</span>
                <span class="history-entry-label">${entry.label}</span>
            `;
            row.addEventListener('click', () => {
                if (i === this.index) return;
                this.applyIndex(i);
            });
            this.list.appendChild(row);
        }
    }
}