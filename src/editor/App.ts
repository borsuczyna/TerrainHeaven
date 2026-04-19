import Camera from "./Camera";
import Renderer from "./Renderer";
import SceneManager from "./SceneManager";
import SelectionManager from "./SelectionManager";
import GizmoManager from "./GizmoManager";
import PropertiesPanel from "./PropertiesPanel";
import ToolManager from "./ToolManager";
import type { Tool } from "./ToolManager";
import RoadTool from "./RoadTool";
import IntersectionTool from "./IntersectionTool";
import WireframeManager from "./WireframeManager";
import type WorldNode from "../elements/WorldNode";
import type { PropertyDefinition } from "./Properties";

export default class App {
    public readonly renderer: Renderer;
    public readonly camera: Camera;
    public readonly scene: SceneManager;
    public readonly selection: SelectionManager;
    public readonly gizmo: GizmoManager;
    public readonly properties: PropertiesPanel;
    public readonly toolManager: ToolManager;
    private lastTime = 0;

    constructor() {
        this.renderer = new Renderer();
        this.camera = new Camera();
        this.scene = new SceneManager();
        this.properties = new PropertiesPanel();
        this.toolManager = new ToolManager();

        this.selection = new SelectionManager(this.camera.instance, this.scene.instance);
        this.gizmo = new GizmoManager(this.camera.instance, this.renderer.instance.domElement, this.scene.instance);
        this.selection.gizmo = this.gizmo;
        this.selection.toolManager = this.toolManager;
        this.camera.selectionManager = this.selection;
        this.camera.toolManager = this.toolManager;

        this.selection.onSelectionChanged = (nodes) => {
            this.gizmo.attach(nodes);
            this.checkMerge(nodes);
        };

        this.selection.onElementSelected = (element) => {
            if (element) {
                this.properties.show(element);
            } else {
                this.properties.hide();
            }
        };

        this.setupTools();
        this.bindEvents();
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    private setupTools(): void {
        const selectTool: Tool = {
            name: 'select',
            activate() {},
            deactivate() {},
        };

        const roadTool = new RoadTool(this.scene, this.camera.instance);
        const intersectionTool = new IntersectionTool(this.scene, this.camera.instance);

        this.toolManager.register(selectTool, document.getElementById('btn-select') as HTMLButtonElement);
        this.toolManager.register(roadTool, document.getElementById('btn-road') as HTMLButtonElement);
        this.toolManager.register(intersectionTool, document.getElementById('btn-intersection') as HTMLButtonElement);
        this.toolManager.setActive('select');

        const btnWireframe = document.getElementById('btn-wireframe')!;
        btnWireframe.addEventListener('click', () => {
            const active = WireframeManager.toggle();
            btnWireframe.classList.toggle('active', active);
        });
    }

    private bindEvents(): void {
        window.addEventListener('resize', () => {
            this.renderer.resize();
            this.camera.resize();
        });
    }

    private checkMerge(nodes: WorldNode[]): void {
        if (nodes.length !== 2) return;
        const [a, b] = nodes;
        if (!a.parent || !b.parent) return;
        if (a.parent === b.parent) return;
        const idxA = a.parent.getNodeIndex(a);
        const idxB = b.parent.getNodeIndex(b);
        if (idxA < 0 || idxB < 0) return;
        if (a.parent.isConnected(idxA) || b.parent.isConnected(idxB)) return;

        const def: PropertyDefinition = {
            title: 'Selection',
            icon: '&#9654;',
            sections: [{
                label: 'Actions',
                properties: [{
                    type: 'button' as const,
                    label: 'Merge Nodes',
                    onClick: () => {
                        const parentA = a.parent!;
                        const parentB = b.parent!;
                        const idxA = parentA.getNodeIndex(a);
                        const idxB = parentB.getNodeIndex(b);
                        if (idxA >= 0 && idxB >= 0) {
                            parentA.connect(idxA, parentB, idxB);
                            parentA.update();
                            parentB.update();
                        }
                        this.selection.clearSelection();
                        this.properties.hide();
                    },
                }],
            }],
        };
        this.properties.showCustom(def);
    }

    private animate(time: number): void {
        const delta = (time - this.lastTime) / 1000;
        this.lastTime = time;

        this.scene.update();
        this.renderer.render(this.scene.instance, this.camera.instance);
        this.camera.update(delta);

        requestAnimationFrame(this.animate);
    }
}