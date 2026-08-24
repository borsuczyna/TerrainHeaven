import { singleton, inject } from 'tsyringe';
import ToolManager from './ToolManager';
import type { Tool } from './ToolManager';
import RoadTool from './tools/RoadTool';
import TerrainTool from './tools/TerrainTool';
import TerrainCutPointTool from './tools/TerrainCutPointTool';
import TerrainCutSplineTool from './tools/TerrainCutSplineTool';
import TerrainPolygonTool from './tools/TerrainPolygonTool';
import RiverSplineTool from './tools/RiverSplineTool';
import UVTool from './tools/UVTool';
import TextureBrowser from './panels/TextureBrowser';
import WireframeManager from './WireframeManager';
import XRayManager from './XRayManager';
import FoliageTool from './tools/FoliageTool';
import HeightPaintTool from './tools/HeightPaintTool';
import FenceTool from './tools/FenceTool';
import MeshTool from './tools/MeshTool';
import MeasureTool from './tools/MeasureTool';
import BuildingTool from './tools/BuildingTool';
import BuildingSegmentTool from './tools/BuildingSegmentTool';
import BuildingOpeningTool from './tools/BuildingOpeningTool';
import BuildingRoofWindowTool from './tools/BuildingRoofWindowTool';
import PresetPanel from './panels/PresetPanel';

@singleton()
export default class LeftToolbarManager {
    constructor(
        @inject(ToolManager) private readonly toolManager: ToolManager,
        @inject(RoadTool) private readonly roadTool: RoadTool,
        @inject(TerrainTool) private readonly terrainTool: TerrainTool,
        @inject(TerrainCutPointTool) private readonly terrainCutPointTool: TerrainCutPointTool,
        @inject(TerrainCutSplineTool) private readonly terrainCutSplineTool: TerrainCutSplineTool,
        @inject(TerrainPolygonTool) private readonly terrainPolygonTool: TerrainPolygonTool,
        @inject(RiverSplineTool) private readonly riverSplineTool: RiverSplineTool,
        @inject(UVTool) private readonly uvTool: UVTool,
        @inject(TextureBrowser) private readonly textureBrowser: TextureBrowser,
        @inject(WireframeManager) private readonly wireframeManager: WireframeManager,
        @inject(XRayManager) private readonly xrayManager: XRayManager,
        @inject(FoliageTool) private readonly foliageTool: FoliageTool,
        @inject(HeightPaintTool) private readonly heightPaintTool: HeightPaintTool,
        @inject(FenceTool) private readonly fenceTool: FenceTool,
        @inject(MeshTool) private readonly meshTool: MeshTool,
        @inject(MeasureTool) private readonly measureTool: MeasureTool,
        @inject(BuildingTool) private readonly buildingTool: BuildingTool,
        @inject(BuildingSegmentTool) private readonly buildingSegmentTool: BuildingSegmentTool,
        @inject(BuildingOpeningTool) private readonly buildingOpeningTool: BuildingOpeningTool,
        @inject(BuildingRoofWindowTool) private readonly buildingRoofWindowTool: BuildingRoofWindowTool,
        @inject(PresetPanel) private readonly presetPanel: PresetPanel,
    ) {}

    public init(): void {
        const selectTool: Tool = {
            name: 'select',
            activate() {},
            deactivate() {},
        };
        // Textures and Presets are floating panels, not canvas tools, but routing them
        // through ToolManager.setActive gives them the same mutual-exclusion every other
        // side panel already gets for free: switching to any other tool (including these
        // two switching each other out) always deactivates whatever was open before.
        const texturesTool: Tool = {
            name: 'textures',
            activate: () => this.textureBrowser.show(),
            deactivate: () => this.textureBrowser.hide(),
        };
        const presetsTool: Tool = {
            name: 'presets',
            activate: () => this.presetPanel.show(),
            deactivate: () => this.presetPanel.hide(),
        };

        this.toolManager.registerTool(selectTool);
        this.toolManager.registerTool(texturesTool);
        this.toolManager.registerTool(presetsTool);
        this.toolManager.registerTool(this.roadTool);
        this.toolManager.registerTool(this.terrainTool);
        this.toolManager.registerTool(this.terrainCutPointTool);
        this.toolManager.registerTool(this.terrainCutSplineTool);
        this.toolManager.registerTool(this.terrainPolygonTool);
        this.toolManager.registerTool(this.riverSplineTool);
        this.toolManager.registerTool(this.uvTool);
        this.toolManager.registerTool(this.foliageTool);
        this.toolManager.registerTool(this.heightPaintTool);
        this.toolManager.registerTool(this.fenceTool);
        this.toolManager.registerTool(this.meshTool);
        this.toolManager.registerTool(this.measureTool);
        this.toolManager.registerTool(this.buildingTool);
        this.toolManager.registerTool(this.buildingSegmentTool);
        this.toolManager.registerTool(this.buildingOpeningTool);
        this.toolManager.registerTool(this.buildingRoofWindowTool);

        this.toolManager.bindButton('select', document.getElementById('btn-select') as HTMLButtonElement, 'Select', 'V');
        this.toolManager.registerSwitcher(
            'road-switcher',
            document.getElementById('btn-road') as HTMLButtonElement,
            ['road', 'fence'],
            'road',
            {
                road: { label: 'Road Tool', icon: 'route' },
                fence: { label: 'Fence Tool', icon: 'panels-top-left' },
            },
            'R',
        );
        this.toolManager.registerSwitcher(
            'terrain-switcher',
            document.getElementById('btn-terrain') as HTMLButtonElement,
            ['terrain', 'terrain-height-paint', 'terrain-cut-point', 'terrain-cut-spline', 'terrain-polygon', 'river'],
            'terrain',
            {
                terrain: { label: 'Terrain Tool', icon: 'mountain' },
                'terrain-height-paint': { label: 'Height Map Painter', icon: 'paintbrush' },
                'terrain-cut-point': { label: 'Terrain Cut Point Tool', icon: 'plus' },
                'terrain-cut-spline': { label: 'Terrain Cut Spline Tool', icon: 'spline' },
                'terrain-polygon': { label: 'Polygon Terrain Tool', icon: 'hexagon' },
                river: { label: 'River Tool', icon: 'waves' },
            },
            'T',
        );
        this.toolManager.registerSwitcher(
            'building-switcher',
            document.getElementById('btn-building') as HTMLButtonElement,
            ['building', 'building-segment', 'building-opening', 'building-roof-window'],
            'building',
            {
                building: { label: 'Building Tool', icon: 'home' },
                'building-segment': { label: 'Add Building Segment', icon: 'square-plus' },
                'building-opening': { label: 'Windows & Doors', icon: 'app-window' },
                'building-roof-window': { label: 'Roof Window (Dormer)', icon: 'house-plus' },
            },
            'B',
        );
        this.toolManager.bindButton('uv', document.getElementById('btn-uv') as HTMLButtonElement, 'UV Mapper', 'U');
        this.toolManager.bindButton('foliage', document.getElementById('btn-foliage') as HTMLButtonElement, 'Foliage Editor', 'F');
        this.toolManager.bindButton('meshes', document.getElementById('btn-meshes') as HTMLButtonElement, 'Mesh Props', 'M');
        this.toolManager.bindButton('measure', document.getElementById('btn-measure') as HTMLButtonElement, 'Measure Tool', 'L');
        this.toolManager.bindButton('textures', document.getElementById('btn-textures') as HTMLButtonElement, 'Texture Library');
        this.toolManager.bindButton('presets', document.getElementById('btn-presets') as HTMLButtonElement, 'Element Presets');
        this.toolManager.setActive('select');

        const btnWireframe = document.getElementById('btn-wireframe') as HTMLButtonElement;
        btnWireframe.addEventListener('click', () => {
            const active = this.wireframeManager.toggle();
            btnWireframe.classList.toggle('active', active);
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
