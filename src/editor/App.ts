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
import TextureBrowser from "./TextureBrowser";
import UVEditorPanel from "./UVEditorPanel";
import UVTool from "./UVTool";
import ProjectSettings from "./ProjectSettings";
import SettingsPanel from "./SettingsPanel";
import ProjectSerializer from "./ProjectSerializer";
import * as THREE from "three";
import type WorldNode from "../elements/WorldNode";
import type WorldElement from "../elements/WorldElement";
import type { PropertyDefinition } from "./Properties";

export default class App {
    public readonly renderer: Renderer;
    public readonly camera: Camera;
    public readonly scene: SceneManager;
    public readonly selection: SelectionManager;
    public readonly gizmo: GizmoManager;
    public readonly properties: PropertiesPanel;
    public readonly toolManager: ToolManager;
    public readonly projectSettings: ProjectSettings;
    private settingsPanel: SettingsPanel;
    private serializer: ProjectSerializer;
    private lastTime = 0;

    constructor() {
        this.renderer = new Renderer();
        this.camera = new Camera();
        this.scene = new SceneManager();
        this.properties = new PropertiesPanel();
        this.toolManager = new ToolManager();
        this.projectSettings = new ProjectSettings(this.renderer, this.scene);
        this.projectSettings.setCamera(this.camera.instance);
        this.settingsPanel = new SettingsPanel(this.projectSettings);
        this.serializer = new ProjectSerializer(this.scene, this.projectSettings);

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
        const uvEditor = new UVEditorPanel();
        const uvTool = new UVTool(this.scene.instance, this.camera.instance, uvEditor);

        this.toolManager.register(selectTool, document.getElementById('btn-select') as HTMLButtonElement);
        this.toolManager.register(roadTool, document.getElementById('btn-road') as HTMLButtonElement);
        this.toolManager.register(intersectionTool, document.getElementById('btn-intersection') as HTMLButtonElement);
        this.toolManager.register(uvTool, document.getElementById('btn-uv') as HTMLButtonElement);
        this.toolManager.setActive('select');

        const btnWireframe = document.getElementById('btn-wireframe')!;
        btnWireframe.addEventListener('click', () => {
            const active = WireframeManager.toggle();
            btnWireframe.classList.toggle('active', active);
        });

        const textureBrowser = new TextureBrowser();
        const btnTextures = document.getElementById('btn-textures')!;
        textureBrowser.onHide = () => btnTextures.classList.remove('active');
        btnTextures.addEventListener('click', () => {
            textureBrowser.toggle();
            btnTextures.classList.toggle('active', textureBrowser.isVisible);
        });

        const btnSettings = document.getElementById('btn-settings')!;
        btnSettings.addEventListener('click', () => {
            if (this.settingsPanel.isVisible) {
                this.settingsPanel.hide();
                btnSettings.classList.remove('active');
            } else {
                this.settingsPanel.show();
                btnSettings.classList.add('active');
            }
        });

        document.getElementById('btn-save')!.addEventListener('click', () => {
            const json = this.serializer.save();
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'project.santown';
            a.click();
            URL.revokeObjectURL(url);
        });

        document.getElementById('btn-load')!.addEventListener('click', () => {
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
                        this.properties.hide();
                        this.selection.clearSelection();
                    } catch (e) {
                        console.error('Failed to load project:', e);
                    }
                };
                reader.readAsText(file);
            });
            input.click();
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

        this.projectSettings.update();
        this.scene.update();
        this.renderer.render(this.scene.instance, this.camera.instance);
        this.camera.update(delta);

        requestAnimationFrame(this.animate);
    }
}