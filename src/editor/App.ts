import { injectable, inject } from 'tsyringe';
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
import TerrainTool from "./TerrainTool";
import WireframeManager from "./WireframeManager";
import { container } from 'tsyringe';
import TextureBrowser from "./TextureBrowser";
import UVTool from "./UVTool";
import ProjectSettings from "./ProjectSettings";
import CopyManager from "./CopyManager";
import * as THREE from "three";
import type WorldNode from "../elements/WorldNode";
import type WorldElement from "../elements/WorldElement";
import type { PropertyDefinition } from "./Properties";
import HeaderManager from "./HeaderManager";

@injectable()
export default class App {
    public readonly renderer: Renderer;
    public readonly camera: Camera;
    public readonly scene: SceneManager;
    public readonly selection: SelectionManager;
    public readonly gizmo: GizmoManager;
    public readonly properties: PropertiesPanel;
    public readonly toolManager: ToolManager;
    public readonly projectSettings: ProjectSettings;
    public readonly copyManager: CopyManager;
    private textureBrowser: TextureBrowser;
    private roadTool: RoadTool;
    private intersectionTool: IntersectionTool;
    private terrainTool: TerrainTool;
    private uvTool: UVTool;
    private headerManager: HeaderManager;
    private lastTime = 0;

    constructor(
        @inject(Renderer) renderer: Renderer,
        @inject(Camera) camera: Camera,
        @inject(SceneManager) scene: SceneManager,
        @inject(SelectionManager) selection: SelectionManager,
        @inject(GizmoManager) gizmo: GizmoManager,
        @inject(PropertiesPanel) properties: PropertiesPanel,
        @inject(ToolManager) toolManager: ToolManager,
        @inject(ProjectSettings) projectSettings: ProjectSettings,
        @inject(CopyManager) copyManager: CopyManager,
        @inject(TextureBrowser) textureBrowser: TextureBrowser,
        @inject(RoadTool) roadTool: RoadTool,
        @inject(IntersectionTool) intersectionTool: IntersectionTool,
        @inject(TerrainTool) terrainTool: TerrainTool,
        @inject(UVTool) uvTool: UVTool,
        @inject(HeaderManager) headerManager: HeaderManager,
    ) {
        this.renderer = renderer;
        this.camera = camera;
        this.scene = scene;
        this.selection = selection;
        this.gizmo = gizmo;
        this.properties = properties;
        this.toolManager = toolManager;
        this.projectSettings = projectSettings;
        this.copyManager = copyManager;
        this.textureBrowser = textureBrowser;
        this.roadTool = roadTool;
        this.intersectionTool = intersectionTool;
        this.terrainTool = terrainTool;
        this.uvTool = uvTool;
        this.headerManager = headerManager;

        // Post-construction wiring
        this.properties.copyManager = this.copyManager;
        this.projectSettings.setCamera(this.camera.instance);
        this.selection.gizmo = this.gizmo;
        this.selection.toolManager = this.toolManager;
        this.camera.selectionManager = this.selection;
        this.camera.toolManager = this.toolManager;

        this.selection.onSelectionChanged = (nodes) => {
            if (nodes.length > 0) {
                this.gizmo.attach(nodes);
            } else {
                this.gizmo.attachElements(this.selection.getSelectedElements());
            }

            const selectedElements = this.selection.getSelectedElements();
            const isMultiSelection = nodes.length >= 2 || selectedElements.length >= 2;
            if (isMultiSelection) {
                const actions = this.getSelectionActions(nodes, selectedElements);
                if (actions) {
                    this.properties.showCustom(actions);
                } else {
                    this.properties.hide();
                }
                return;
            }

            if (selectedElements.length === 1) {
                this.properties.show(selectedElements[0]);
                return;
            }

            if (nodes.length === 1 && nodes[0].parent) {
                this.properties.show(nodes[0].parent);
                return;
            }

            this.properties.hide();
        };

        this.selection.onElementSelected = (element) => {
            if (element) {
                this.properties.show(element);
            } else {
                this.properties.hide();
            }
        };

        this.setupTools();
        this.headerManager.init();
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

        this.toolManager.registerTool(selectTool);
        this.toolManager.registerTool(this.roadTool);
        this.toolManager.registerTool(this.intersectionTool);
        this.toolManager.registerTool(this.terrainTool);
        this.toolManager.registerTool(this.uvTool);

        this.toolManager.bindButton('select', document.getElementById('btn-select') as HTMLButtonElement, 'Select', 'Q');
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

        const btnWireframe = document.getElementById('btn-wireframe')!;
        btnWireframe.addEventListener('click', () => {
            const active = container.resolve(WireframeManager).toggle();
            btnWireframe.classList.toggle('active', active);
        });

        const btnTextures = document.getElementById('btn-textures')!;
        this.textureBrowser.onHide = () => btnTextures.classList.remove('active');
        btnTextures.addEventListener('click', () => {
            this.textureBrowser.toggle();
            btnTextures.classList.toggle('active', this.textureBrowser.isVisible);
        });

        // Drag-and-drop textures onto 3D elements
        const canvas = this.renderer.instance.domElement;
        canvas.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer!.dropEffect = 'copy';
        });
        canvas.addEventListener('drop', (e) => {
            e.preventDefault();
            const url = e.dataTransfer?.getData('application/x-texture-url');
            if (!url) return;

            const mouse = new THREE.Vector2(
                (e.clientX / window.innerWidth) * 2 - 1,
                -(e.clientY / window.innerHeight) * 2 + 1,
            );
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(mouse, this.camera.instance);

            const targets: THREE.Object3D[] = [];
            for (const child of this.scene.instance.children) {
                if (child.type !== 'TransformControlsRoot' && child.type !== 'TransformControlsGizmo' && child.type !== 'TransformControlsPlane') {
                    targets.push(child);
                }
            }
            const intersects = raycaster.intersectObjects(targets, true);

            for (const hit of intersects) {
                const el = hit.object.userData.worldElement as WorldElement | undefined;
                if (el && hit.faceIndex != null) {
                    const groupName = el.getGroupNameAtFace(hit.faceIndex);
                    if (groupName) {
                        const loader = new THREE.TextureLoader();
                        loader.load(url, (tex) => {
                            tex.wrapS = THREE.RepeatWrapping;
                            tex.wrapT = THREE.RepeatWrapping;
                            tex.colorSpace = THREE.SRGBColorSpace;
                            el.setGroupTexture(groupName, tex);
                        });
                    }
                    break;
                }
            }
        });
    }

    private bindEvents(): void {
        window.addEventListener('resize', () => {
            this.renderer.resize();
            this.camera.resize();
        });

        window.addEventListener('keydown', (e) => {
            // Ignore shortcuts when typing in inputs
            if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;

            // Handle only one tool-switch action per physical key press.
            if (e.repeat) return;

            if (!e.ctrlKey && !e.metaKey) {
                if (this.toolManager.handleShortcut(e.key)) {
                    this.renderer.instance.domElement.focus();
                    e.preventDefault();
                    return;
                }
            }

            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'c' || e.key === 'C') {
                    const el = this.selection.getSelectedElement();
                    if (el) {
                        e.preventDefault();
                        this.copyManager.copyElement(el);
                    }
                } else if (e.key === 'v' || e.key === 'V') {
                    e.preventDefault();
                    const selectedEl = this.selection.getSelectedElement();
                    if (this.copyManager.canPastePropertiesOnto(selectedEl!)) {
                        // Properties-copy mode + same type selected → apply in-place
                        this.copyManager.pastePropertiesOnto(selectedEl!);
                    } else if (this.copyManager.canPasteElement()) {
                        // Element-copy mode → spawn in front of camera
                        const newEl = this.copyManager.pasteElement(this.camera.instance, this.scene);
                        if (newEl) {
                            this.selection.selectElement(newEl);
                        }
                    }
                }
            }
        });
    }

    private getSelectionActions(nodes: WorldNode[], selectedElements: WorldElement[]): PropertyDefinition | null {
        const actions: { type: 'button'; label: string; onClick: () => void }[] = [];

        if (nodes.length === 2) {
            actions.push({
                type: 'button',
                label: 'Merge Nodes',
                onClick: () => {
                    const [a, b] = nodes;
                    if (!a.parent || !b.parent) return;
                    if (a.parent === b.parent) return;
                    const idxA = a.parent.getNodeIndex(a);
                    const idxB = b.parent.getNodeIndex(b);
                    if (idxA < 0 || idxB < 0) return;
                    if (a.parent.isConnected(idxA) || b.parent.isConnected(idxB)) return;

                    const parentA = a.parent;
                    const parentB = b.parent;
                    parentA.connect(idxA, parentB, idxB);
                    parentA.update();
                    parentB.update();
                    this.selection.clearSelection();
                    this.properties.hide();
                },
            });
        }

        if (nodes.length >= 2 || selectedElements.length >= 2) {
            actions.push({
                type: 'button',
                label: 'Clear Selection',
                onClick: () => {
                    this.selection.clearSelection();
                    this.properties.hide();
                },
            });
        }

        if (actions.length === 0) return null;

        return {
            title: 'Selection',
            icon: '&#9654;',
            sections: [{
                label: 'Actions',
                properties: actions,
            }],
        };
    }

    private animate(time: number): void {
        const delta = (time - this.lastTime) / 1000;
        this.lastTime = time;

        this.projectSettings.update();
        this.scene.update();
        this.renderer.render(this.scene.instance, this.camera.instance);
        this.camera.update(delta);

        requestAnimationFrame(this.animate);
    }
}