import { singleton } from 'tsyringe';
import { createIcons, icons } from 'lucide';

export interface Tool {
    name: string;
    blocksCamera?: boolean;
    activate(): void;
    deactivate(): void;
    onMouseDown?(e: MouseEvent): boolean;
    onMouseUp?(e: MouseEvent): void;
}

@singleton()
export default class ToolManager {
    private tools: Map<string, Tool> = new Map();
    private activeTool: Tool | null = null;
    private buttons: Map<string, HTMLButtonElement> = new Map();
    private buttonMeta: Map<string, { label: string; shortcut?: string }> = new Map();
    private switchers: Map<string, {
        button: HTMLButtonElement;
        toolNames: string[];
        activeToolName: string;
        shortcut?: string;
        meta: Record<string, { label: string; icon: string }>;
    }> = new Map();
    private switcherMenu: HTMLDivElement;
    private switcherHideTimer: number | null = null;

    constructor() {
        this.switcherMenu = document.createElement('div');
        this.switcherMenu.className = 'tool-switcher-menu';
        this.switcherMenu.style.display = 'none';
        document.body.appendChild(this.switcherMenu);

        this.switcherMenu.addEventListener('mouseenter', () => this.cancelSwitcherHide());
        this.switcherMenu.addEventListener('mouseleave', () => this.scheduleSwitcherHide());

        document.addEventListener('click', () => {
            this.hideSwitcherMenu();
        });
    }

    public registerTool(tool: Tool): void {
        this.tools.set(tool.name, tool);
    }

    public bindButton(name: string, button: HTMLButtonElement, label?: string, shortcut?: string): void {
        this.buttons.set(name, button);
        this.buttonMeta.set(name, { label: label ?? name, shortcut: shortcut?.toUpperCase() });
        button.dataset.tooltip = this.formatTooltip(label ?? name, shortcut);
        button.addEventListener('click', () => this.setActive(name));
    }

    public register(tool: Tool, button: HTMLButtonElement): void {
        this.registerTool(tool);
        this.bindButton(tool.name, button, tool.name);
    }

    public registerSwitcher(
        id: string,
        button: HTMLButtonElement,
        toolNames: string[],
        defaultToolName: string,
        meta: Record<string, { label: string; icon: string }>,
        shortcut?: string,
    ): void {
        this.switchers.set(id, {
            button,
            toolNames,
            activeToolName: defaultToolName,
            meta,
            shortcut: shortcut?.toUpperCase(),
        });
        this.updateSwitcherButtonVisual(button, defaultToolName, meta, shortcut);

        button.addEventListener('click', () => {
            const sw = this.switchers.get(id);
            if (!sw) return;
            this.setActive(sw.activeToolName);
        });

        button.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showSwitcherMenu(id);
        });

        button.addEventListener('mouseenter', () => {
            this.cancelSwitcherHide();
            this.showSwitcherMenu(id);
        });
        button.addEventListener('mouseleave', () => this.scheduleSwitcherHide());
        button.addEventListener('focus', () => this.showSwitcherMenu(id));
        button.addEventListener('blur', () => this.scheduleSwitcherHide());
    }

    public setActive(name: string): void {
        if (this.activeTool) {
            this.activeTool.deactivate();
        }
        const tool = this.tools.get(name) ?? null;
        this.activeTool = tool;
        if (tool) {
            tool.activate();
        }

        this.refreshButtonStates();
    }

    public getActive(): Tool | null {
        return this.activeTool;
    }

    public handleShortcut(key: string): boolean {
        const k = key.toUpperCase();

        for (const [, sw] of this.switchers) {
            if (sw.shortcut !== k) continue;
            const switcherActive = !!this.activeTool && sw.toolNames.includes(this.activeTool.name);
            if (!switcherActive) {
                this.setActive(sw.activeToolName);
                return true;
            }

            const i = sw.toolNames.indexOf(sw.activeToolName);
            const next = i >= 0 ? (i + 1) % sw.toolNames.length : 0;
            sw.activeToolName = sw.toolNames[next];
            this.setActive(sw.activeToolName);
            this.hideSwitcherMenu();
            return true;
        }

        for (const [toolName, info] of this.buttonMeta) {
            if (info.shortcut !== k) continue;
            this.setActive(toolName);
            return true;
        }

        return false;
    }

    private refreshButtonStates(): void {
        for (const [, button] of this.buttons) {
            button.classList.remove('active');
        }
        for (const [, sw] of this.switchers) {
            sw.button.classList.remove('active');
            this.updateSwitcherButtonVisual(sw.button, sw.activeToolName, sw.meta, sw.shortcut);
        }

        if (!this.activeTool) return;

        const directButton = this.buttons.get(this.activeTool.name);
        if (directButton) {
            directButton.classList.add('active');
            return;
        }

        for (const [, sw] of this.switchers) {
            if (sw.toolNames.includes(this.activeTool.name)) {
                sw.button.classList.add('active');
                sw.activeToolName = this.activeTool.name;
                this.updateSwitcherButtonVisual(sw.button, sw.activeToolName, sw.meta, sw.shortcut);
            }
        }
    }

    private updateSwitcherButtonVisual(
        button: HTMLButtonElement,
        toolName: string,
        meta: Record<string, { label: string; icon: string }>,
        shortcut?: string,
    ): void {
        const info = meta[toolName] ?? { label: toolName, icon: 'circle' };
        button.dataset.tooltip = this.formatTooltip(info.label, shortcut);
        button.innerHTML = `<i data-lucide="${info.icon}"></i>`;
        createIcons({ icons });
    }

    private showSwitcherMenu(id: string): void {
        const sw = this.switchers.get(id);
        if (!sw) return;

        this.switcherMenu.innerHTML = '';
        for (const toolName of sw.toolNames) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'tool-switcher-item';
            const info = sw.meta[toolName] ?? { label: toolName, icon: 'circle' };
            item.title = this.formatTooltip(info.label, sw.shortcut);
            item.innerHTML = `<span class="tool-switcher-icon"><i data-lucide="${info.icon}"></i></span><span class="tool-switcher-label">${info.label}</span>${sw.shortcut ? `<kbd>${sw.shortcut}</kbd>` : ''}`;
            if (toolName === sw.activeToolName) item.classList.add('active');
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                sw.activeToolName = toolName;
                this.setActive(toolName);
                this.hideSwitcherMenu();
            });
            this.switcherMenu.appendChild(item);
        }

        createIcons({ icons });

        const rect = sw.button.getBoundingClientRect();
        const top = rect.top + rect.height / 2 - 22;

        this.switcherMenu.style.left = `${rect.right + 8}px`;
        this.switcherMenu.style.top = `${Math.max(8, top)}px`;
        this.switcherMenu.style.display = 'flex';
    }

    private hideSwitcherMenu(): void {
        this.cancelSwitcherHide();
        this.switcherMenu.style.display = 'none';
    }

    private scheduleSwitcherHide(): void {
        this.cancelSwitcherHide();
        this.switcherHideTimer = window.setTimeout(() => this.hideSwitcherMenu(), 180);
    }

    private cancelSwitcherHide(): void {
        if (this.switcherHideTimer === null) return;
        window.clearTimeout(this.switcherHideTimer);
        this.switcherHideTimer = null;
    }

    private formatTooltip(label: string, shortcut?: string): string {
        return shortcut ? `${label} [${shortcut.toUpperCase()}]` : label;
    }
}
