import { singleton } from 'tsyringe';
import { createIcons, icons } from 'lucide';

interface ShortcutEntry {
    keys: string[];
    label: string;
}

interface ShortcutSection {
    title: string;
    entries: ShortcutEntry[];
}

const SECTIONS: ShortcutSection[] = [
    {
        title: 'Tools',
        entries: [
            { keys: ['V'], label: 'Select tool' },
            { keys: ['R'], label: 'Road tool (press again for Intersection / Fence)' },
            { keys: ['T'], label: 'Terrain tool (press again to cycle Cut Point / Cut Spline / River)' },
            { keys: ['U'], label: 'UV Mapper tool' },
            { keys: ['Drag preset'], label: 'Apply it to a matching element' },
            { keys: ['W'], label: 'Move gizmo (with an element selected)' },
            { keys: ['E'], label: 'Rotate gizmo (with an element selected)' },
        ],
    },
    {
        title: 'Editing',
        entries: [
            { keys: ['LMB', 'Drag'], label: 'Box-select multiple elements (on empty space)' },
            { keys: ['Ctrl', 'LMB', 'Drag'], label: 'Add a curved path with tangent handles' },
            { keys: ['Shift', 'LMB', 'Drag'], label: 'Snap a straight path to 45° angles' },
            { keys: ['Delete'], label: 'Delete selection' },
            { keys: ['Ctrl', 'C'], label: 'Copy selected element' },
            { keys: ['Ctrl', 'V'], label: 'Paste element / properties' },
            { keys: ['Ctrl', 'Z'], label: 'Undo' },
            { keys: ['Ctrl', 'Shift', 'Z'], label: 'Redo' },
            { keys: ['Ctrl', 'Y'], label: 'Redo' },
        ],
    },
    {
        title: 'Viewport',
        entries: [
            { keys: ['MMB', 'Drag'], label: 'Orbit around view target' },
            { keys: ['Shift', 'MMB', 'Drag'], label: 'Pan view' },
            { keys: ['Scroll'], label: 'Zoom in / out' },
            { keys: ['RMB', 'Drag'], label: 'Look around' },
            { keys: ['Numpad 5'], label: 'Toggle perspective / orthographic' },
            { keys: ['W', 'A', 'S', 'D'], label: 'Fly move' },
            { keys: ['Space'], label: 'Fly up' },
            { keys: ['Q'], label: 'Fly down' },
            { keys: ['X'], label: 'Toggle X-ray node view (see nodes through walls)' },
            { keys: ['?'], label: 'Toggle this help screen' },
        ],
    },
];

@singleton()
export default class HelpPanel {
    private readonly container: HTMLElement;
    public onHide: (() => void) | null = null;

    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'help-panel';
        document.body.appendChild(this.container);
        this.build();
        window.addEventListener('keydown', this.onKeyDown);
    }

    private onKeyDown = (e: KeyboardEvent): void => {
        const tagName = (e.target as HTMLElement | null)?.tagName;
        if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') return;
        if (e.repeat) return;
        if (e.key === '?') {
            e.preventDefault();
            this.toggle();
        } else if (e.key === 'Escape' && this.isVisible) {
            this.hide();
        }
    };

    public toggle(): void {
        if (this.isVisible) this.hide();
        else this.show();
    }

    public show(): void {
        this.container.classList.add('visible');
    }

    public hide(): void {
        this.container.classList.remove('visible');
        this.onHide?.();
    }

    public get isVisible(): boolean {
        return this.container.classList.contains('visible');
    }

    private build(): void {
        this.container.innerHTML = `
            <div class="sp-header">
                <div class="sp-heading"><span class="sp-eyebrow">Reference</span><span class="sp-title">Keyboard Shortcuts</span><small>Editor controls at a glance</small></div>
                <button class="sp-close" type="button" aria-label="Close"><i data-lucide="x"></i></button>
            </div>
            <div class="sp-body">
                ${SECTIONS.map((section) => `
                    <div class="sp-section">
                        <div class="sp-section-label">${section.title}</div>
                        <div class="help-shortcut-list">
                            ${section.entries.map((entry) => `
                                <div class="help-shortcut-row">
                                    <span>${entry.label}</span>
                                    <span class="help-shortcut-keys">${entry.keys.map((key) => `<kbd>${key}</kbd>`).join('<span class="help-plus">+</span>')}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
        this.container.querySelector('.sp-close')?.addEventListener('click', () => this.hide());
        createIcons({ icons });
    }
}
