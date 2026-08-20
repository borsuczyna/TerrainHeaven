import * as THREE from 'three';
import { singleton } from 'tsyringe';

@singleton()
export default class Renderer {
    public readonly instance: THREE.WebGLRenderer;
    private enhancedVisuals = false;
    private shadowUpdateRequested = false;
    private lastShadowUpdate = 0;
    // Shadow maps are the expensive part of this mode; four updates per second
    // are enough for an editor while keeping navigation responsive.
    private readonly shadowUpdateInterval = 250;

    constructor() {
        const canvas = document.querySelector<HTMLCanvasElement>('#editor');
        if (!canvas) throw new Error('Canvas #editor not found');

        this.instance = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.instance.setSize(window.innerWidth, window.innerHeight);
        this.updatePixelRatio();
        this.instance.setClearColor(0x1e1e1e);
        this.instance.outputColorSpace = THREE.SRGBColorSpace;
        this.instance.toneMapping = THREE.NeutralToneMapping;
        this.instance.toneMappingExposure = 1.2;
        this.instance.shadowMap.enabled = true;
        this.instance.shadowMap.type = THREE.PCFSoftShadowMap;
        this.instance.shadowMap.autoUpdate = true;

        document.body.appendChild(this.instance.domElement);
    }

    public resize(): void {
        this.instance.setSize(window.innerWidth, window.innerHeight);
        this.updatePixelRatio();
    }

    public render(scene: THREE.Scene, camera: THREE.Camera): void {
        if (this.enhancedVisuals && this.shadowUpdateRequested) {
            const now = performance.now();
            if (now - this.lastShadowUpdate >= this.shadowUpdateInterval) {
                this.instance.shadowMap.needsUpdate = true;
                this.shadowUpdateRequested = false;
                this.lastShadowUpdate = now;
            }
        }
        this.instance.render(scene, camera);
    }

    public setEnhancedVisuals(enabled: boolean): void {
        this.enhancedVisuals = enabled;
        // Neutral tone mapping preserves editor colors better than ACES and avoids blown whites.
        this.instance.toneMapping = THREE.NeutralToneMapping;
        this.instance.toneMappingExposure = enabled ? 1.4 : 1.2;
        this.instance.shadowMap.enabled = true;
        this.instance.shadowMap.type = THREE.PCFSoftShadowMap;
        this.instance.shadowMap.autoUpdate = !enabled;
        this.updatePixelRatio();
        if (enabled) this.requestShadowUpdate();
    }

    public requestShadowUpdate(): void {
        if (this.enhancedVisuals) this.shadowUpdateRequested = true;
    }

    private updatePixelRatio(): void {
        const limit = this.enhancedVisuals ? 1.5 : 2;
        this.instance.setPixelRatio(Math.min(window.devicePixelRatio, limit));
    }

    public get domElement(): HTMLCanvasElement {
        return this.instance.domElement;
    }
}
