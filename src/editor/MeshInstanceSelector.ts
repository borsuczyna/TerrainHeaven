import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { inject, singleton } from 'tsyringe';
import SceneManager from './SceneManager';
import Camera from './Camera';
import Renderer from './Renderer';
import HistoryManager from './HistoryManager';
import MeshManager from './MeshManager';
import type { MeshInstanceData } from '../mesh/MeshData';

// A parallel, much smaller selection+gizmo system just for placed mesh-prop instances.
// They aren't WorldElements (there's no per-instance Object3D to hang userData off - an
// InstancedMesh is one draw call for every copy of one asset), so they can't go through
// SelectionManager/GizmoManager's WorldNode-oriented pipeline; instead this attaches a
// plain proxy Object3D to its own TransformControls and writes the result back into that
// one instance's transform (MeshManager.updateInstanceTransform) on every change.
@singleton()
export default class MeshInstanceSelector {
    private readonly proxy = new THREE.Object3D();
    private readonly controls: TransformControls;
    private readonly label: HTMLElement;
    private mode: 'translate' | 'rotate' = 'translate';
    private selection: { assetIndex: number; instanceIndex: number } | null = null;

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(Camera) camera: Camera,
        @inject(Renderer) renderer: Renderer,
        @inject(HistoryManager) private readonly history: HistoryManager,
        @inject(MeshManager) private readonly meshes: MeshManager,
    ) {
        this.controls = new TransformControls(camera.instance, renderer.domElement);
        camera.onChanged(() => { this.controls.camera = camera.instance; });
        this.controls.setMode('translate');
        this.controls.setSize(0.8);
        this.controls.enabled = false;
        this.controls.getHelper().visible = false;

        this.scene.instance.add(this.proxy);
        this.scene.instance.add(this.controls.getHelper());

        this.controls.addEventListener('dragging-changed', (event) => {
            if (!this.selection) return;
            if (event.value) {
                this.history.beginAction(this.mode === 'translate' ? 'Move Mesh Prop' : 'Rotate Mesh Prop');
            } else {
                this.commit();
                this.history.endAction();
            }
        });
        this.controls.addEventListener('objectChange', () => this.commit());

        this.label = document.createElement('div');
        this.label.id = 'mesh-instance-label';
        document.body.appendChild(this.label);

        window.addEventListener('keydown', this.onKeyDown);
    }

    public get isDragging(): boolean {
        return this.controls.dragging;
    }

    public get hasSelection(): boolean {
        return this.selection !== null;
    }

    public select(assetIndex: number, instanceIndex: number): void {
        const instance = this.meshes.getInstance(assetIndex, instanceIndex);
        if (!instance) return;
        this.selection = { assetIndex, instanceIndex };
        this.syncProxyFromInstance(instance);
        this.controls.attach(this.proxy);
        this.controls.getHelper().visible = true;
        this.controls.enabled = true;
        this.updateLabel();
    }

    public deselect(): void {
        if (!this.selection) return;
        this.selection = null;
        this.controls.detach();
        this.controls.getHelper().visible = false;
        this.controls.enabled = false;
        this.label.classList.remove('visible');
    }

    private syncProxyFromInstance(instance: MeshInstanceData): void {
        this.proxy.position.set(instance.Position.x, instance.Position.y, instance.Position.z);
        this.proxy.rotation.set(
            THREE.MathUtils.degToRad(instance.RotationX),
            THREE.MathUtils.degToRad(instance.RotationY),
            THREE.MathUtils.degToRad(instance.RotationZ),
        );
        this.proxy.scale.setScalar(instance.Scale);
    }

    private commit(): void {
        if (!this.selection) return;
        const { assetIndex, instanceIndex } = this.selection;
        if (!this.meshes.getInstance(assetIndex, instanceIndex)) {
            // The instance vanished from under us (e.g. erased by the brush tool
            // elsewhere) - drop the stale selection instead of writing into the wrong slot.
            this.deselect();
            return;
        }
        this.meshes.updateInstanceTransform(assetIndex, instanceIndex, {
            Position: { x: this.proxy.position.x, y: this.proxy.position.y, z: this.proxy.position.z },
            RotationX: THREE.MathUtils.radToDeg(this.proxy.rotation.x),
            RotationY: THREE.MathUtils.radToDeg(this.proxy.rotation.y),
            RotationZ: THREE.MathUtils.radToDeg(this.proxy.rotation.z),
        });
    }

    private onKeyDown = (event: KeyboardEvent): void => {
        if (!this.selection) return;
        const tagName = (event.target as HTMLElement | null)?.tagName;
        if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') return;
        if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;

        const key = event.key.toLowerCase();
        if (key === 'w' || key === 'e') {
            this.mode = key === 'w' ? 'translate' : 'rotate';
            this.controls.setMode(this.mode);
            return;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            const { assetIndex, instanceIndex } = this.selection;
            this.history.beginAction('Delete Mesh Prop');
            this.meshes.removeInstanceAt(assetIndex, instanceIndex);
            this.history.endAction();
            this.deselect();
        }
    };

    private updateLabel(): void {
        if (!this.selection) return;
        const asset = this.meshes.assets[this.selection.assetIndex];
        if (!asset) return;
        this.label.textContent = `${asset.DisplayName} — W move / E rotate, drag to edit, Del to remove`;
        this.label.classList.add('visible');
    }
}
