import * as THREE from 'three';
import { singleton } from 'tsyringe';

@singleton()
export default class Renderer {
    public readonly instance: THREE.WebGLRenderer;

    constructor() {
        const canvas = document.querySelector<HTMLCanvasElement>('#editor');

        if (!canvas) {
            throw new Error('Canvas #editor not found');
        }

        this.instance = new THREE.WebGLRenderer({ canvas, antialias: true });

        const width = window.innerWidth;
        const height = window.innerHeight;

        this.instance.setSize(width, height);
        this.instance.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        this.instance.setClearColor(0x1e1e1e);

        this.instance.shadowMap.enabled = true;
        this.instance.shadowMap.type = THREE.PCFSoftShadowMap;

        document.body.appendChild(this.instance.domElement);
    }

    public resize(): void {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.instance.setSize(width, height);
        this.instance.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    }

    public render(scene: THREE.Scene, camera: THREE.Camera): void {
        this.instance.render(scene, camera);
    }

    public get domElement(): HTMLCanvasElement {
        return this.instance.domElement;
    }
}