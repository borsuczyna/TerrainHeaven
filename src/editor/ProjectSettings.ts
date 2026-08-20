import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import Renderer from './Renderer';
import SceneManager from './SceneManager';

export interface ProjectSettingsData {
    skyColor: string;
    dayNightCycle: boolean;
    hour: number;
    enhancedVisuals?: boolean;
    dayLength?: number;
}

interface SkyKeyframe {
    hour: number;
    zenith: number;
    horizon: number;
    fog: number;
}

// Muted colors keep the viewport readable and avoid a cinematic/over-saturated look.
const SKY_KEYFRAMES: SkyKeyframe[] = [
    { hour: 0, zenith: 0x101624, horizon: 0x222838, fog: 0x121722 },
    { hour: 5, zenith: 0x30394e, horizon: 0x8a665e, fog: 0x4b4144 },
    { hour: 7, zenith: 0x6e91ad, horizon: 0xc4aba0, fog: 0xa99b91 },
    { hour: 10, zenith: 0x7298ba, horizon: 0xbec6c9, fog: 0xaeb5b6 },
    { hour: 16, zenith: 0x6d91ad, horizon: 0xbdb7ae, fog: 0xaaa49c },
    { hour: 18.5, zenith: 0x655f68, horizon: 0xc28e72, fog: 0x9b857c },
    { hour: 20.5, zenith: 0x293146, horizon: 0x5c4b52, fog: 0x34333d },
    { hour: 24, zenith: 0x101624, horizon: 0x222838, fog: 0x121722 },
];

@singleton()
export default class ProjectSettings {
    private readonly ambientLight: THREE.AmbientLight;
    private readonly directionalLight: THREE.DirectionalLight;
    private readonly hemisphereLight: THREE.HemisphereLight;
    private readonly lightTarget = new THREE.Object3D();
    private readonly visualGroup = new THREE.Group();
    private readonly skyDome: THREE.Mesh;
    private readonly sunMesh: THREE.Mesh;
    private readonly sunGlow: THREE.Sprite;
    private readonly moonMesh: THREE.Mesh;
    private readonly stars: THREE.Points;
    private readonly cloudGroup = new THREE.Group();
    private readonly cloudSprites: THREE.Sprite[] = [];
    private readonly palette = { zenith: new THREE.Color(), horizon: new THREE.Color(), fog: new THREE.Color() };
    private readonly paletteMix = new THREE.Color();
    private readonly backgroundColor = new THREE.Color();
    private readonly lightAnchor = new THREE.Vector3();
    private readonly lastShadowAnchor = new THREE.Vector3(Number.POSITIVE_INFINITY, 0, 0);
    private readonly lightDirection = new THREE.Vector3(1, 1, 0);
    private readonly warmSun = new THREE.Color(0xffb878);
    private readonly daylightSun = new THREE.Color(0xfff4e8);
    private readonly nightLight = new THREE.Color(0x91a6c8);
    private readonly daySkyFill = new THREE.Color(0xb9c9d3);
    private readonly dayGroundFill = new THREE.Color(0x62675d);
    private readonly nightSkyFill = new THREE.Color(0x48566e);
    private readonly nightGroundFill = new THREE.Color(0x262c31);
    private readonly cloudDay = new THREE.Color(0xd8d4c9);
    private readonly cloudNight = new THREE.Color(0x697385);
    private camera: THREE.PerspectiveCamera | null = null;
    private environmentAccumulator = 0;
    private readonly environmentUpdateInterval = 0.1;

    public skyColor = '#1e1e1e';
    public enhancedVisuals = true;
    public dayNightCycle = false;
    public hour = 12;
    public dayLength = 240;
    public onTimeChanged: ((hour: number) => void) | null = null;

    constructor(
        @inject(Renderer) private readonly renderer: Renderer,
        @inject(SceneManager) private readonly scene: SceneManager,
    ) {
        this.ambientLight = scene.instance.children.find((child) => child instanceof THREE.AmbientLight) as THREE.AmbientLight;
        this.directionalLight = scene.instance.children.find((child) => child instanceof THREE.DirectionalLight) as THREE.DirectionalLight;

        this.hemisphereLight = new THREE.HemisphereLight(0xbfd1d4, 0x6d705a, 0.55);
        this.hemisphereLight.visible = false;
        scene.instance.add(this.hemisphereLight);

        this.directionalLight.target = this.lightTarget;
        scene.instance.add(this.lightTarget);
        this.configureSunShadows();

        this.skyDome = this.createSkyDome();
        this.sunMesh = new THREE.Mesh(
            new THREE.SphereGeometry(4, 10, 8),
            new THREE.MeshBasicMaterial({ color: 0xffd2a0, fog: false }),
        );
        this.moonMesh = new THREE.Mesh(
            new THREE.SphereGeometry(3, 10, 8),
            new THREE.MeshBasicMaterial({ color: 0xcbd5e5, fog: false }),
        );
        this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: this.createGlowTexture(),
            color: 0xffcf94,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            fog: false,
            blending: THREE.AdditiveBlending,
        }));
        this.sunGlow.renderOrder = -900;
        this.stars = this.createStars();
        this.createClouds();
        this.visualGroup.add(this.skyDome, this.stars, this.sunGlow, this.sunMesh, this.moonMesh, this.cloudGroup);
        this.visualGroup.visible = false;
        this.visualGroup.frustumCulled = false;
        scene.instance.add(this.visualGroup);

        this.scene.onSceneGeometryChanged = () => this.renderer.requestShadowUpdate();
        this.apply();
    }

    public setCamera(camera: THREE.PerspectiveCamera): void {
        this.camera = camera;
        this.apply();
    }

    public apply(): void {
        this.renderer.setEnhancedVisuals(this.enhancedVisuals && this.camera !== null);
        if (this.enhancedVisuals && this.camera) {
            this.environmentAccumulator = 0;
            this.lastShadowAnchor.set(Number.POSITIVE_INFINITY, 0, 0);
            this.applyEnhancedEnvironment(0, true);
            return;
        }

        this.disableEnhancedObjects();
        if (this.dayNightCycle) this.applyBasicDayNight();
        else this.applyBasicRendering();
    }

    public update(delta: number): void {
        if (this.enhancedVisuals && this.camera) {
            this.visualGroup.position.copy(this.camera.position);
            this.updateShadowAnchor();

            if (!this.dayNightCycle) return;
            this.environmentAccumulator += Math.min(delta, 0.25);
            if (this.environmentAccumulator < this.environmentUpdateInterval) return;

            const elapsed = this.environmentAccumulator;
            this.environmentAccumulator = 0;
            this.hour = (this.hour + elapsed * 24 / Math.max(30, this.dayLength)) % 24;
            this.applyEnhancedEnvironment(elapsed, false);
            this.onTimeChanged?.(this.hour);
            return;
        }

        if (this.dayNightCycle) this.positionBasicCelestials();
    }

    private applyBasicRendering(): void {
        const color = new THREE.Color(this.skyColor);
        this.renderer.instance.setClearColor(color);
        this.scene.instance.background = color;
        this.scene.instance.fog = null;
        this.ambientLight.intensity = 1.1;
        this.ambientLight.color.setHex(0xffffff);
        this.directionalLight.intensity = 1.5;
        this.directionalLight.position.set(10, 20, 10);
        this.directionalLight.color.setHex(0xffffff);
        this.directionalLight.castShadow = false;
        this.visualGroup.visible = false;
    }

    private applyBasicDayNight(): void {
        const angle = ((this.hour - 6) / 12) * Math.PI;
        const elevation = Math.sin(angle);
        const palette = this.getSkyPalette(this.hour);
        this.backgroundColor.copy(palette.zenith);
        this.scene.instance.background = this.backgroundColor;
        this.renderer.instance.setClearColor(this.backgroundColor);
        this.scene.instance.fog = null;
        this.directionalLight.position.set(Math.cos(angle) * 20, Math.max(elevation * 20, 0.5), 10);
        this.directionalLight.intensity = Math.max(0, elevation) * 1.1;
        this.directionalLight.color.set(elevation < 0.3 ? 0xffb47c : 0xffffff);
        this.directionalLight.castShadow = false;
        this.ambientLight.intensity = 0.35 + Math.max(0, elevation) * 0.5;
        this.ambientLight.color.copy(palette.horizon);
        this.visualGroup.visible = true;
        this.skyDome.visible = false;
        this.stars.visible = false;
        this.cloudGroup.visible = false;
        this.sunMesh.visible = elevation > -0.1;
        this.moonMesh.visible = elevation < 0.1;
        this.positionBasicCelestials();
    }

    private applyEnhancedEnvironment(elapsed: number, forceShadow: boolean): void {
        if (!this.camera) return;

        const angle = ((this.hour - 6) / 24) * Math.PI * 2;
        const elevation = Math.sin(angle);
        const daylight = this.smoothstep(-0.12, 0.18, elevation);
        const palette = this.getSkyPalette(this.hour);

        this.visualGroup.visible = true;
        this.skyDome.visible = true;
        this.visualGroup.position.copy(this.camera.position);
        this.updateSkyDome(palette);
        this.backgroundColor.copy(palette.zenith);
        this.scene.instance.background = this.backgroundColor;
        this.renderer.instance.setClearColor(this.backgroundColor);

        let fog = this.scene.instance.fog;
        if (!(fog instanceof THREE.Fog)) {
            fog = new THREE.Fog(palette.fog, 130, 520);
            this.scene.instance.fog = fog;
        }
        fog.color.copy(palette.fog);
        fog.near = 130;
        fog.far = 520;

        const celestialDistance = 260;
        this.sunMesh.position.set(Math.cos(angle) * celestialDistance, elevation * celestialDistance, -70);
        this.moonMesh.position.copy(this.sunMesh.position).multiplyScalar(-1);
        this.sunMesh.visible = elevation > -0.08;
        this.moonMesh.visible = elevation < 0.12;

        this.sunGlow.position.copy(this.sunMesh.position);
        this.sunGlow.visible = this.sunMesh.visible;
        // Glow peaks near the horizon (low sun) and fades at high noon, matching a hazy golden-hour look.
        const horizonGlow = 1 - this.smoothstep(0.15, 0.55, Math.abs(elevation));
        this.sunGlow.material.opacity = THREE.MathUtils.clamp(0.35 + horizonGlow * 0.55, 0, 0.9) * this.smoothstep(-0.1, 0.05, elevation);
        this.sunGlow.material.color.copy(this.warmSun).lerp(this.daylightSun, daylight * 0.5);
        const glowScale = 130 + horizonGlow * 90;
        this.sunGlow.scale.set(glowScale, glowScale, 1);

        const starMaterial = this.stars.material as THREE.PointsMaterial;
        starMaterial.opacity = THREE.MathUtils.clamp(0.75 - daylight, 0, 0.75);
        this.stars.visible = starMaterial.opacity > 0.01;

        this.lightDirection.set(Math.cos(angle), elevation, -0.28).normalize();
        if (elevation < 0) this.lightDirection.multiplyScalar(-1);
        this.updateDirectionalLightPosition();
        this.directionalLight.castShadow = true;
        this.directionalLight.intensity = THREE.MathUtils.lerp(0.35, 1.1, daylight);
        this.directionalLight.color.copy(elevation < 0
            ? this.nightLight
            : this.warmSun).lerp(this.daylightSun, daylight);

        this.ambientLight.intensity = THREE.MathUtils.lerp(0.4, 0.55, daylight);
        this.ambientLight.color.copy(palette.horizon);
        this.hemisphereLight.visible = true;
        this.hemisphereLight.intensity = THREE.MathUtils.lerp(0.65, 0.85, daylight);
        this.hemisphereLight.color.copy(this.nightSkyFill).lerp(this.daySkyFill, daylight);
        this.hemisphereLight.groundColor.copy(this.nightGroundFill).lerp(this.dayGroundFill, daylight);

        this.updateClouds(elapsed, daylight);
        if (forceShadow || elapsed > 0) this.renderer.requestShadowUpdate();
    }

    private updateShadowAnchor(): void {
        if (!this.camera) return;
        this.lightAnchor.set(this.camera.position.x, 0, this.camera.position.z);
        if (this.lightAnchor.distanceToSquared(this.lastShadowAnchor) < 64) return;
        this.lastShadowAnchor.copy(this.lightAnchor);
        this.lightTarget.position.copy(this.lightAnchor);
        this.updateDirectionalLightPosition();
        this.renderer.requestShadowUpdate();
    }

    private updateDirectionalLightPosition(): void {
        this.directionalLight.position.copy(this.lightDirection).multiplyScalar(95).add(this.lightAnchor);
        this.directionalLight.target.updateMatrixWorld();
    }

    private disableEnhancedObjects(): void {
        this.hemisphereLight.visible = false;
        this.scene.instance.fog = null;
        this.skyDome.visible = false;
        this.stars.visible = false;
        this.cloudGroup.visible = false;
        this.sunGlow.visible = false;
    }

    private configureSunShadows(): void {
        this.directionalLight.castShadow = false;
        this.directionalLight.shadow.mapSize.set(1024, 1024);
        const camera = this.directionalLight.shadow.camera;
        camera.left = -55;
        camera.right = 55;
        camera.top = 55;
        camera.bottom = -55;
        camera.near = 1;
        camera.far = 190;
        camera.updateProjectionMatrix();
        this.directionalLight.shadow.bias = -0.00012;
        this.directionalLight.shadow.normalBias = 0.045;
        this.directionalLight.shadow.radius = 2;
    }

    private createSkyDome(): THREE.Mesh {
        const material = new THREE.ShaderMaterial({
            uniforms: {
                zenithColor: { value: new THREE.Color(0x7298ba) },
                horizonColor: { value: new THREE.Color(0xbec6c9) },
            },
            side: THREE.BackSide,
            depthWrite: false,
            depthTest: false,
            fog: false,
            vertexShader: `
                varying float vHeight;
                void main() {
                    vHeight = normalize(position).y;
                    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    gl_Position = clip.xyww;
                }
            `,
            fragmentShader: `
                uniform vec3 zenithColor;
                uniform vec3 horizonColor;
                varying float vHeight;
                void main() {
                    float blend = smoothstep(-0.04, 0.72, vHeight);
                    gl_FragColor = vec4(mix(horizonColor, zenithColor, blend), 1.0);
                }
            `,
        });
        const dome = new THREE.Mesh(new THREE.SphereGeometry(360, 16, 8), material);
        dome.frustumCulled = false;
        dome.renderOrder = -1000;
        return dome;
    }

    private updateSkyDome(palette: { zenith: THREE.Color; horizon: THREE.Color; fog: THREE.Color }): void {
        const uniforms = (this.skyDome.material as THREE.ShaderMaterial).uniforms;
        (uniforms.zenithColor.value as THREE.Color).copy(palette.zenith);
        (uniforms.horizonColor.value as THREE.Color).copy(palette.horizon);
    }

    private createStars(): THREE.Points {
        const count = 180;
        const positions = new Float32Array(count * 3);
        let seed = 73421;
        const random = (): number => {
            seed = (seed * 16807) % 2147483647;
            return (seed - 1) / 2147483646;
        };
        for (let index = 0; index < count; index++) {
            const y = random() * 0.88 + 0.1;
            const angle = random() * Math.PI * 2;
            const radius = Math.sqrt(Math.max(0, 1 - y * y)) * 330;
            positions[index * 3] = Math.cos(angle) * radius;
            positions[index * 3 + 1] = y * 330;
            positions[index * 3 + 2] = Math.sin(angle) * radius;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.PointsMaterial({
            color: 0xdce5f2,
            size: 1,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            fog: false,
        });
        const stars = new THREE.Points(geometry, material);
        stars.frustumCulled = false;
        return stars;
    }

    private createClouds(): void {
        const material = new THREE.SpriteMaterial({
            map: this.createCloudTexture(),
            color: this.cloudDay,
            transparent: true,
            opacity: 0.2,
            depthWrite: false,
            fog: true,
        });
        for (let index = 0; index < 6; index++) {
            const sprite = new THREE.Sprite(material);
            const angle = index / 6 * Math.PI * 2;
            const radius = 125 + (index % 2) * 42;
            sprite.position.set(Math.cos(angle) * radius, 62 + (index % 3) * 8, Math.sin(angle) * radius);
            sprite.scale.set(70 + (index % 2) * 18, 16 + (index % 3) * 3, 1);
            this.cloudSprites.push(sprite);
            this.cloudGroup.add(sprite);
        }
    }

    private createCloudTexture(): THREE.CanvasTexture {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 96;
        const context = canvas.getContext('2d')!;
        const puffs = [
            [55, 56, 42], [98, 42, 48], [142, 48, 55], [190, 53, 45], [126, 66, 74],
        ];
        context.save();
        context.scale(1.7, 1);
        for (const [x, y, radius] of puffs) {
            const px = x / 1.7;
            const gradient = context.createRadialGradient(px, y, 3, px, y, radius / 1.7);
            gradient.addColorStop(0, 'rgba(255,255,255,0.58)');
            gradient.addColorStop(0.55, 'rgba(255,255,255,0.22)');
            gradient.addColorStop(1, 'rgba(255,255,255,0)');
            context.fillStyle = gradient;
            context.fillRect(0, 0, 256 / 1.7, 96);
        }
        context.restore();
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
    }

    private createGlowTexture(): THREE.CanvasTexture {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d')!;
        const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
        gradient.addColorStop(0.35, 'rgba(255,255,255,0.35)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        context.fillStyle = gradient;
        context.fillRect(0, 0, size, size);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
    }

    private updateClouds(elapsed: number, daylight: number): void {
        const material = this.cloudSprites[0]?.material as THREE.SpriteMaterial | undefined;
        if (material) {
            material.opacity = THREE.MathUtils.lerp(0.08, 0.22, daylight);
            material.color.copy(this.cloudNight).lerp(this.cloudDay, daylight);
        }
        for (let index = 0; index < this.cloudSprites.length; index++) {
            const cloud = this.cloudSprites[index];
            cloud.position.x += elapsed * (0.35 + index * 0.025);
            if (cloud.position.x > 180) cloud.position.x = -180;
        }
    }

    private positionBasicCelestials(): void {
        if (!this.camera) return;
        const angle = ((this.hour - 6) / 12) * Math.PI;
        this.visualGroup.position.copy(this.camera.position);
        this.sunMesh.position.set(Math.cos(angle) * 200, Math.sin(angle) * 200, 0);
        this.moonMesh.position.copy(this.sunMesh.position).multiplyScalar(-1);
    }

    private getSkyPalette(hour: number): { zenith: THREE.Color; horizon: THREE.Color; fog: THREE.Color } {
        const wrapped = ((hour % 24) + 24) % 24;
        let left = SKY_KEYFRAMES[0];
        let right = SKY_KEYFRAMES[SKY_KEYFRAMES.length - 1];
        for (let index = 0; index < SKY_KEYFRAMES.length - 1; index++) {
            if (wrapped >= SKY_KEYFRAMES[index].hour && wrapped <= SKY_KEYFRAMES[index + 1].hour) {
                left = SKY_KEYFRAMES[index];
                right = SKY_KEYFRAMES[index + 1];
                break;
            }
        }
        const rawT = (wrapped - left.hour) / Math.max(0.001, right.hour - left.hour);
        const t = rawT * rawT * (3 - 2 * rawT);
        this.palette.zenith.set(left.zenith).lerp(this.paletteMix.set(right.zenith), t);
        this.palette.horizon.set(left.horizon).lerp(this.paletteMix.set(right.horizon), t);
        this.palette.fog.set(left.fog).lerp(this.paletteMix.set(right.fog), t);
        return this.palette;
    }

    private smoothstep(min: number, max: number, value: number): number {
        const t = THREE.MathUtils.clamp((value - min) / (max - min), 0, 1);
        return t * t * (3 - 2 * t);
    }

    public getData(): ProjectSettingsData {
        return {
            skyColor: this.skyColor,
            enhancedVisuals: this.enhancedVisuals,
            dayNightCycle: this.dayNightCycle,
            hour: this.hour,
            dayLength: this.dayLength,
        };
    }

    public loadData(data: ProjectSettingsData): void {
        this.skyColor = data.skyColor ?? '#1e1e1e';
        this.enhancedVisuals = data.enhancedVisuals ?? false;
        this.dayNightCycle = data.dayNightCycle ?? false;
        this.hour = THREE.MathUtils.clamp(data.hour ?? 12, 0, 24);
        this.dayLength = THREE.MathUtils.clamp(data.dayLength ?? 240, 30, 1200);
        this.apply();
    }
}
