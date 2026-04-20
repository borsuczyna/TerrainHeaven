import { singleton } from 'tsyringe';

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

    public register(tool: Tool, button: HTMLButtonElement): void {
        this.tools.set(tool.name, tool);
        this.buttons.set(tool.name, button);
        button.addEventListener('click', () => this.setActive(tool.name));
    }

    public setActive(name: string): void {
        if (this.activeTool) {
            this.activeTool.deactivate();
            this.buttons.get(this.activeTool.name)?.classList.remove('active');
        }
        const tool = this.tools.get(name) ?? null;
        this.activeTool = tool;
        if (tool) {
            tool.activate();
            this.buttons.get(name)?.classList.add('active');
        }
    }

    public getActive(): Tool | null {
        return this.activeTool;
    }
}
