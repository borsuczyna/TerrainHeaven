import { singleton, inject } from 'tsyringe';
import ToolManager from './ToolManager';
import type { Tool } from './ToolManager';
import RoadTool from './tools/RoadTool';
import IntersectionTool from './tools/IntersectionTool';
import TerrainTool from './tools/TerrainTool';
import TerrainCutPointTool from './tools/TerrainCutPointTool';
import TerrainCutSplineTool from './tools/TerrainCutSplineTool';
import RiverSplineTool from './tools/RiverSplineTool';
import UVTool from './tools/UVTool';
import TextureBrowser from './panels/TextureBrowser';
import WireframeManager from './WireframeManager';
import XRayManager from './XRayManager';
import FoliageTool from './tools/FoliageTool';
import HeightPaintTool from './tools/HeightPaintTool';
import FenceTool from './tools/FenceTool';
import MeshTool from './tools/MeshTool';
import PresetPanel from './panels/PresetPanel';

@singleton()
export default class LeftToolbarManager {
    constructor(
        @inject(ToolManager) private readonly toolManager: ToolManager,
        @inject(RoadTool) private readonly roadTool: RoadTool,
        @inject(IntersectionTool) private readonly intersectionTool: IntersectionTool,
        @inject(TerrainTool) private readonly terrainTool: TerrainTool,
        @inject(TerrainCutPointTool) private readonly terrainCutPointTool: TerrainCutPointTool,
        @inject(TerrainCutSplineTool) private readonly terrainCutSplineTool: TerrainCutSplineTool,
        @inject(RiverSplineTool) private readonly riverSplineTool: RiverSplineTool,
        @inject(UVTool) private readonly uvTool: UVTool,
        @inject(TextureBrowser) private readonly textureBrowser: TextureBrowser,
        @inject(WireframeManager) private readonly wireframeManager: WireframeManager,
        @inject(XRayManager) private readonly xrayManager: XRayManager,
        @inject(FoliageTool) private readonly foliageTool: FoliageTool,
        @inject(HeightPaintTool) private readonly heightPaintTool: HeightPaintTool,
        @inject(FenceTool) private readonly fenceTool: FenceTool,
        @inject(MeshTool) private readonly meshTool: MeshTool,
        @inject(PresetPanel) private readonly presetPanel: PresetPanel,
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
        this.toolManager.registerTool(this.terrainCutPointTool);
        this.toolManager.registerTool(this.terrainCutSplineTool);
        this.toolManager.registerTool(this.riverSplineTool);
        this.toolManager.registerTool(this.uvTool);
        this.toolManager.registerTool(this.foliageTool);
        this.toolManager.registerTool(this.heightPaintTool);
        this.toolManager.registerTool(this.fenceTool);
        this.toolManager.registerTool(this.meshTool);

        this.toolManager.bindButton('select', document.getElementById('btn-select') as HTMLButtonElement, 'Select', 'V');
        this.toolManager.registerSwitcher(
            'road-switcher',
            document.getElementById('btn-road') as HTMLButtonElement,
            ['road', 'intersection', 'fence'],
            'road',
            {
                road: { label: 'Road Tool', icon: 'route' },
                intersection: { label: 'Intersection Tool', icon: 'git-fork' },
                fence: { label: 'Fence Tool', icon: 'panels-top-left' },
            },
            'R',
        );
        this.toolManager.registerSwitcher(
            'terrain-switcher',
            document.getElementById('btn-terrain') as HTMLButtonElement,
            ['terrain', 'terrain-height-paint', 'terrain-cut-point', 'terrain-cut-spline', 'river'],
            'terrain',
            {
                terrain: { label: 'Terrain Tool', icon: 'mountain' },
                'terrain-height-paint': { label: 'Height Map Painter', icon: 'paintbrush' },
                'terrain-cut-point': { label: 'Terrain Cut Point Tool', icon: 'plus' },
                'terrain-cut-spline': { label: 'Terrain Cut Spline Tool', icon: 'spline' },
                river: { label: 'River Tool', icon: 'waves' },
            },
            'T',
        );
        this.toolManager.bindButton('uv', document.getElementById('btn-uv') as HTMLButtonElement, 'UV Mapper', 'U');
        this.toolManager.bindButton('foliage', document.getElementById('btn-foliage') as HTMLButtonElement, 'Foliage Editor', 'F');
        this.toolManager.bindButton('meshes', document.getElementById('btn-meshes') as HTMLButtonElement, 'Mesh Props', 'M');
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

        const btnPresets = document.getElementById('btn-presets') as HTMLButtonElement;
        this.presetPanel.onHide = () => btnPresets.classList.remove('active');
        btnPresets.addEventListener('click', () => {
            this.presetPanel.toggle();
            btnPresets.classList.toggle('active', this.presetPanel.isVisible);
        });

        const btnXray = document.getElementById('btn-xray') as HTMLButtonElement;
        const toggleXray = (): void => {
            const active = this.xrayManager.toggle();
            btnXray.classList.toggle('active', active);
        };
        btnXray.addEventListener('click', toggleXray);
        window.addEventListener('keydown', (e) => {
            const tagName = (e.target as HTMLElement | null)?.tagName;
            if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') return;
            if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key.toLowerCase() === 'x') toggleXray();
        });
    }
}
