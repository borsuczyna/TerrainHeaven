import Camera from "./Camera";
import Renderer from "./Renderer";
import SceneManager from "./SceneManager";
import SelectionManager from "./SelectionManager";
import GizmoManager from "./GizmoManager";
import PropertiesPanel from "./PropertiesPanel";

export default class App {
    public readonly renderer: Renderer;
    public readonly camera: Camera;
    public readonly scene: SceneManager;
    public readonly selection: SelectionManager;
    public readonly gizmo: GizmoManager;
    public readonly properties: PropertiesPanel;
    private lastTime = 0;

    constructor() {
        this.renderer = new Renderer();
        this.camera = new Camera();
        this.scene = new SceneManager();
        this.properties = new PropertiesPanel();

        this.selection = new SelectionManager(this.camera.instance, this.scene.instance);
        this.gizmo = new GizmoManager(this.camera.instance, this.renderer.instance.domElement, this.scene.instance);
        this.selection.gizmo = this.gizmo;
        this.camera.selectionManager = this.selection;

        this.selection.onSelectionChanged = (nodes) => {
            this.gizmo.attach(nodes);
        };

        this.selection.onElementSelected = (element) => {
            if (element) {
                this.properties.show(element);
            } else {
                this.properties.hide();
            }
        };

        this.bindEvents();
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    private bindEvents(): void {
        window.addEventListener('resize', () => {
            this.renderer.resize();
            this.camera.resize();
        });
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