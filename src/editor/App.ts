import { injectable, inject } from 'tsyringe';
import Camera from "./Camera";
import Renderer from "./Renderer";
import SceneManager from "./SceneManager";
import SelectionManager from "./SelectionManager";
import GizmoManager from "./GizmoManager";
import ToolManager from "./ToolManager";
import LeftToolbarManager from "./LeftToolbarManager";
import TextureDropManager from "./TextureDropManager";
import ProjectSettings from "./ProjectSettings";
import HeaderManager from "./HeaderManager";
import TransformToolbarManager from "./TransformToolbarManager";
import HistoryManager from './HistoryManager';

@injectable()
export default class App {
    public readonly renderer: Renderer;
    public readonly camera: Camera;
    public readonly scene: SceneManager;
    public readonly selection: SelectionManager;
    public readonly gizmo: GizmoManager;
    public readonly toolManager: ToolManager;
    public readonly projectSettings: ProjectSettings;
    public readonly history: HistoryManager;
    private headerManager: HeaderManager;
    private leftToolbarManager: LeftToolbarManager;
    private textureDropManager: TextureDropManager;
    private transformToolbarManager: TransformToolbarManager;
    private lastTime = 0;

    constructor(
        @inject(Renderer) renderer: Renderer,
        @inject(Camera) camera: Camera,
        @inject(SceneManager) scene: SceneManager,
        @inject(SelectionManager) selection: SelectionManager,
        @inject(GizmoManager) gizmo: GizmoManager,
        @inject(ToolManager) toolManager: ToolManager,
        @inject(ProjectSettings) projectSettings: ProjectSettings,
        @inject(HistoryManager) history: HistoryManager,
        @inject(LeftToolbarManager) leftToolbarManager: LeftToolbarManager,
        @inject(TextureDropManager) textureDropManager: TextureDropManager,
        @inject(HeaderManager) headerManager: HeaderManager,
        @inject(TransformToolbarManager) transformToolbarManager: TransformToolbarManager,
    ) {
        this.renderer = renderer;
        this.camera = camera;
        this.scene = scene;
        this.selection = selection;
        this.gizmo = gizmo;
        this.toolManager = toolManager;
        this.projectSettings = projectSettings;
        this.history = history;
        this.leftToolbarManager = leftToolbarManager;
        this.textureDropManager = textureDropManager;
        this.headerManager = headerManager;
        this.transformToolbarManager = transformToolbarManager;

        // Post-construction wiring
        this.projectSettings.setCamera(this.camera.instance);
        this.camera.setGizmoManager(this.gizmo);

        this.leftToolbarManager.init();
        this.textureDropManager.init();
        this.headerManager.init();
        this.transformToolbarManager.init();
        this.history.init();
        this.bindEvents();
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
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
                if (this.toolManager.getActive()?.name === 'select' && this.gizmo.handleShortcut(e.key)) {
                    this.renderer.instance.domElement.focus();
                    e.preventDefault();
                    return;
                }

                if (this.toolManager.handleShortcut(e.key)) {
                    this.renderer.instance.domElement.focus();
                    e.preventDefault();
                    return;
                }
            }
        });
    }

    private animate(time: number): void {
        const delta = (time - this.lastTime) / 1000;
        this.lastTime = time;

        this.projectSettings.update(delta);
        this.scene.flushDirty();
        this.renderer.render(this.scene.instance, this.camera.instance);
        this.camera.update(delta);

        requestAnimationFrame(this.animate);
    }
}
