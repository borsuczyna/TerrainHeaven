import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import Renderer from './Renderer';
import SceneManager from './SceneManager';

export interface ProjectSettingsData {
    skyColor: string;
    dayNightCycle: boolean;
    hour: number;
}

@singleton()
export default class ProjectSettings {
    private renderer: Renderer;
    private scene: SceneManager;
    private ambientLight: THREE.AmbientLight;
    private directionalLight: THREE.DirectionalLight;
    private sunMesh: THREE.Mesh;
    private moonMesh: THREE.Mesh;
    private camera: THREE.PerspectiveCamera | null = null;

    public skyColor: string = '#1e1e1e';
    public dayNightCycle: boolean = false;
    public hour: number = 12;

    constructor(
        @inject(Renderer) renderer: Renderer,
        @inject(SceneManager) scene: SceneManager,
    ) {
        this.renderer = renderer;
        this.scene = scene;

        // Find existing lights in scene
        this.ambientLight = scene.instance.children.find(c => c instanceof THREE.AmbientLight) as THREE.AmbientLight;
        this.directionalLight = scene.instance.children.find(c => c instanceof THREE.DirectionalLight) as THREE.DirectionalLight;

        // Create sun mesh
        const sunGeo = new THREE.SphereGeometry(3, 32, 32);
        const sunMat = new THREE.MeshBasicMaterial({ color: 0xffdd44 });
        this.sunMesh = new THREE.Mesh(sunGeo, sunMat);
        this.sunMesh.visible = false;
        scene.instance.add(this.sunMesh);

        // Create moon mesh
        const moonGeo = new THREE.SphereGeometry(2, 32, 32);
        const moonMat = new THREE.MeshBasicMaterial({ color: 0xccccdd });
        this.moonMesh = new THREE.Mesh(moonGeo, moonMat);
        this.moonMesh.visible = false;
        scene.instance.add(this.moonMesh);

        this.apply();
    }

    public setCamera(camera: THREE.PerspectiveCamera): void {
        this.camera = camera;
    }

    public apply(): void {
        if (this.dayNightCycle) {
            this.applyDayNight();
        } else {
            const color = new THREE.Color(this.skyColor);
            this.renderer.instance.setClearColor(color);
            this.scene.instance.background = color;

            this.ambientLight.intensity = 0.5;
            this.ambientLight.color.setHex(0xffffff);
            this.directionalLight.intensity = 1;
            this.directionalLight.position.set(10, 20, 10);
            this.directionalLight.color.setHex(0xffffff);

            this.sunMesh.visible = false;
            this.moonMesh.visible = false;
        }
    }

    /** Called every frame to keep sun/moon following camera */
    public update(): void {
        if (!this.dayNightCycle || !this.camera) return;
        this.positionCelestials();
    }

    private applyDayNight(): void {
        // hour 0-24: 0/24 = midnight, 6 = sunrise, 12 = noon, 18 = sunset
        const t = this.hour;

        // Sun angle: at hour 12, sun is directly above; at 0/24, below horizon
        const sunAngle = ((t - 6) / 12) * Math.PI; // 0 at sunrise (6), PI at sunset (18)
        const elevation = Math.sin(sunAngle);

        // Directional light follows sun
        const sunY = Math.sin(sunAngle) * 20;
        const sunXZ = Math.cos(sunAngle) * 20;
        this.directionalLight.position.set(sunXZ, Math.max(sunY, 0.5), 10);

        // Sun intensity based on elevation
        const sunIntensity = Math.max(0, elevation) * 1.2;
        this.directionalLight.intensity = sunIntensity;

        // Ambient: brighter at day, dim at night
        const ambientIntensity = 0.05 + Math.max(0, elevation) * 0.5;
        this.ambientLight.intensity = ambientIntensity;

        // Sun color: warm at sunrise/sunset, white at noon
        const warmth = 1 - Math.abs(elevation);
        const sunColor = new THREE.Color().setHSL(
            0.1 * warmth,
            0.3 * warmth,
            0.5 + 0.5 * Math.max(0, elevation),
        );
        this.directionalLight.color.copy(sunColor);

        // Ambient color matches sky
        const skyColor = this.computeSkyColor(elevation, warmth);
        this.ambientLight.color.copy(skyColor);

        // Sky color based on time of day
        const bgColor = this.computeSkyColor(elevation, warmth);
        this.renderer.instance.setClearColor(bgColor);
        this.scene.instance.background = bgColor;

        // Show/hide sun and moon
        this.sunMesh.visible = elevation > -0.1;
        this.moonMesh.visible = elevation < 0.1;

        // Sun brightness
        const sunMat = this.sunMesh.material as THREE.MeshBasicMaterial;
        const sunBright = Math.max(0, elevation + 0.1);
        sunMat.color.setHSL(0.12, 0.8, 0.5 + 0.5 * sunBright);

        this.positionCelestials();
    }

    private computeSkyColor(elevation: number, warmth: number): THREE.Color {
        if (elevation > 0.15) {
            // Daytime: blue sky, lighter near horizon
            const dayBlue = new THREE.Color().setHSL(0.58, 0.6, 0.55 + 0.15 * elevation);
            return dayBlue;
        } else if (elevation > -0.05) {
            // Sunrise/sunset transition
            const tween = (elevation + 0.05) / 0.2; // 0 at -0.05, 1 at 0.15
            const dusk = new THREE.Color().setHSL(0.06, 0.7, 0.35);
            const day = new THREE.Color().setHSL(0.58, 0.6, 0.55);
            return dusk.lerp(day, Math.max(0, Math.min(1, tween)));
        } else {
            // Night
            const nightDepth = Math.min(1, (-elevation - 0.05) / 0.3);
            const nightColor = new THREE.Color().setHSL(0.63, 0.3, 0.08 - 0.04 * nightDepth);
            return nightColor;
        }
    }

    private positionCelestials(): void {
        if (!this.camera) return;
        const camPos = this.camera.position;
        const skyDist = 200;
        const t = this.hour;

        // Sun position on sky dome
        const sunAngle = ((t - 6) / 12) * Math.PI;
        this.sunMesh.position.set(
            camPos.x + Math.cos(sunAngle) * skyDist,
            camPos.y + Math.sin(sunAngle) * skyDist,
            camPos.z,
        );

        // Moon is opposite the sun
        this.moonMesh.position.set(
            camPos.x - Math.cos(sunAngle) * skyDist,
            camPos.y - Math.sin(sunAngle) * skyDist,
            camPos.z,
        );
    }

    public getData(): ProjectSettingsData {
        return {
            skyColor: this.skyColor,
            dayNightCycle: this.dayNightCycle,
            hour: this.hour,
        };
    }

    public loadData(data: ProjectSettingsData): void {
        this.skyColor = data.skyColor;
        this.dayNightCycle = data.dayNightCycle;
        this.hour = data.hour;
        this.apply();
    }
}
