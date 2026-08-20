import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import Camera, { type ViewName } from '../Camera';

interface AxisEnd {
    axis: 'x' | 'y' | 'z';
    sign: 1 | -1;
    view: ViewName;
    label: string;
    vector: THREE.Vector3;
}

const AXES: AxisEnd[] = [
    { axis: 'x', sign: 1, view: 'right', label: 'X', vector: new THREE.Vector3(1, 0, 0) },
    { axis: 'x', sign: -1, view: 'left', label: '', vector: new THREE.Vector3(-1, 0, 0) },
    { axis: 'y', sign: 1, view: 'top', label: 'Y', vector: new THREE.Vector3(0, 1, 0) },
    { axis: 'y', sign: -1, view: 'bottom', label: '', vector: new THREE.Vector3(0, -1, 0) },
    { axis: 'z', sign: 1, view: 'front', label: 'Z', vector: new THREE.Vector3(0, 0, 1) },
    { axis: 'z', sign: -1, view: 'back', label: '', vector: new THREE.Vector3(0, 0, -1) },
];

@singleton()
export default class ViewGizmoMenu {
    private readonly root: HTMLDivElement;
    private readonly projectionButton: HTMLButtonElement;
    private readonly ends: HTMLButtonElement[] = [];

    constructor(@inject(Camera) private readonly camera: Camera) {
        this.root = document.createElement('div');
        this.root.id = 'view-gizmo';
        this.root.setAttribute('aria-label', 'Camera orientation');
        this.root.innerHTML = `
            <div class="view-axis-stage">
                <span class="view-axis-line axis-x"></span>
                <span class="view-axis-line axis-y"></span>
                <span class="view-axis-line axis-z"></span>
            </div>
            <button type="button" class="view-projection-btn"></button>
        `;
        document.body.appendChild(this.root);
        const stage = this.root.querySelector<HTMLDivElement>('.view-axis-stage')!;
        for (const end of AXES) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `view-axis-end axis-${end.axis} ${end.sign < 0 ? 'negative' : ''}`;
            button.textContent = end.label;
            button.title = `${end.view[0].toUpperCase()}${end.view.slice(1)} view`;
            button.addEventListener('click', () => this.camera.setView(end.view));
            stage.appendChild(button);
            this.ends.push(button);
        }
        this.projectionButton = this.root.querySelector<HTMLButtonElement>('.view-projection-btn')!;
        this.projectionButton.addEventListener('click', () => this.camera.toggleProjection());
        this.camera.onChanged(() => this.update());
        this.update();
    }

    public init(): void {
        this.update();
    }

    private update(): void {
        const inverseCamera = this.camera.instance.quaternion.clone().invert();
        const projected = AXES.map((end, index) => {
            const cameraSpace = end.vector.clone().applyQuaternion(inverseCamera);
            const x = 50 + cameraSpace.x * 32;
            const y = 50 - cameraSpace.y * 32;
            const button = this.ends[index];
            button.style.left = `${x}%`;
            button.style.top = `${y}%`;
            button.style.zIndex = `${Math.round((1 - cameraSpace.z) * 10)}`;
            button.style.opacity = `${THREE.MathUtils.lerp(0.38, 1, (1 - cameraSpace.z) / 2)}`;
            button.classList.toggle('facing', cameraSpace.z < -0.85);
            return { end, x, y };
        });

        for (const axis of ['x', 'y', 'z'] as const) {
            const pair = projected.filter((item) => item.end.axis === axis);
            const line = this.root.querySelector<HTMLElement>(`.view-axis-line.axis-${axis}`)!;
            const dx = pair[1].x - pair[0].x;
            const dy = pair[1].y - pair[0].y;
            line.style.left = `${pair[0].x}%`;
            line.style.top = `${pair[0].y}%`;
            line.style.width = `${Math.hypot(dx, dy)}%`;
            line.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
        }

        const orthographic = this.camera.projectionMode === 'orthographic';
        this.projectionButton.textContent = orthographic ? 'Orthographic' : 'Perspective';
        this.projectionButton.classList.toggle('active', orthographic);
        this.projectionButton.title = 'Toggle projection (Numpad 5)';
    }
}
