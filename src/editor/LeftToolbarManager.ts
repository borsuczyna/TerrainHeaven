import { singleton, inject } from 'tsyringe';
import ToolManager from './ToolManager';
import type { Tool } from './ToolManager';
import RoadTool from './tools/RoadTool';
import IntersectionTool from './tools/IntersectionTool';
import TerrainTool from './tools/TerrainTool';
import UVTool from './tools/UVTool';
import TextureBrowser from './panels/TextureBrowser';
import WireframeManager from './WireframeManager';

@singleton()
export default class LeftToolbarManager {
    constructor(
        @inject(ToolManager) private readonly toolManager: ToolManager,
        @inject(RoadTool) private readonly roadTool: RoadTool,
        @inject(IntersectionTool) private readonly intersectionTool: IntersectionTool,
        @inject(TerrainTool) private readonly terrainTool: TerrainTool,
        @inject(UVTool) private readonly uvTool: UVTool,
        @inject(TextureBrowser) private readonly textureBrowser: TextureBrowser,
        @inject(WireframeManager) private readonly wireframeManager: WireframeManager,
    ) {}

    public init(): void {
        const selectTool: Tool = {
            name: 'select',
            activate() {},
            deactivate() {},
        };

        this.toolManager.registerTool(selectTool);
        this.toolManager.registerTool(this.roadTool);
        this.toolManager.registerTool(this.intersectionTool);
        this.toolManager.registerTool(this.terrainTool);
        this.toolManager.registerTool(this.uvTool);

        this.toolManager.bindButton('select', document.getElementById('btn-select') as HTMLButtonElement, 'Select', 'V');
        this.toolManager.registerSwitcher(
            'road-switcher',
            document.getElementById('btn-road') as HTMLButtonElement,
            ['road', 'intersection'],
            'road',
            {
                road: { label: 'Road Tool', icon: 'route' },
                intersection: { label: 'Intersection Tool', icon: 'git-fork' },
            },
            'R',
        );
        this.toolManager.bindButton('terrain', document.getElementById('btn-terrain') as HTMLButtonElement, 'Terrain Tool', 'T');
        this.toolManager.bindButton('uv', document.getElementById('btn-uv') as HTMLButtonElement, 'UV Mapper', 'U');
        this.toolManager.setActive('select');

        const btnWireframe = document.getElementById('btn-wireframe') as HTMLButtonElement;
        btnWireframe.addEventListener('click', () => {
            const active = this.wireframeManager.toggle();
            btnWireframe.classList.toggle('active', active);
        });

        const btnTextures = document.getElementById('btn-textures') as HTMLButtonElement;
        this.textureBrowser.onHide = () => btnTextures.classList.remove('active');
        btnTextures.addEventListener('click', () => {
            this.textureBrowser.toggle();
            btnTextures.classList.toggle('active', this.textureBrowser.isVisible);
        });
    }
}
