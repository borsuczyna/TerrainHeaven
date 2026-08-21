import * as THREE from 'three';
import { inject, singleton } from 'tsyringe';
import SceneManager from './SceneManager';
import TextureLibrary from './TextureLibrary';
import {
    FoliageStore,
    resolveFoliageDimensions,
    type FoliageInstanceData,
    type FoliageProjectData,
    type FoliageTypeData,
    type FoliageVector3,
} from '../foliage/FoliageData';
import SurfaceHeightSampler from '../terrain/SurfaceHeightSampler';

export interface FoliageWindPreviewSettings {
    enabled: boolean;
    directionDegrees: number;
    strength: number;
    speed: number;
    turbulence: number;
}

interface FoliageWindUniforms {
    time: { value: number };
    direction: { value: THREE.Vector2 };
    strength: { value: number };
    speed: { value: number };
    turbulence: { value: number };
    effectiveness: { value: number };
    heightInfluence: { value: number };
    baseOffset: { value: number };
}

@singleton()
export default class FoliageManager {
    public readonly store = new FoliageStore();
    public readonly windPreview: FoliageWindPreviewSettings = {
        enabled: false,
        directionDegrees: 0,
        strength: 0.25,
        speed: 0.75,
        turbulence: 0.2,
    };
    public onChanged: (() => void) | null = null;

    private readonly root = new THREE.Group();
    private readonly meshes = new Map<number, THREE.InstancedMesh>();
    private readonly fallbackTextures = new Map<number, THREE.CanvasTexture>();
    private readonly textureCache = new Map<string, THREE.Texture>();
    private readonly textureLoads = new Map<string, Promise<THREE.Texture | null>>();
    private readonly textureVersions = new Map<string, number>();
    private readonly dirtyTypes = new Set<number>();
    private readonly windMaterials = new Set<THREE.MeshBasicMaterial>();
    private readonly geometry = this.createCrossQuadGeometry();
    private structureDirty = false;
    private windTime = 0;

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(TextureLibrary) private readonly textureLibrary: TextureLibrary,
    ) {
        this.root.name = 'Foliage';
        this.root.userData.foliageRoot = true;
        this.scene.instance.add(this.root);
        this.scene.onTerrainSurfaceChanged(() => this.updateSurfaceHeights());
    }

    public get types(): readonly FoliageTypeData[] { return this.store.types; }

    public getInstances(typeIndex: number): readonly FoliageInstanceData[] {
        return this.store.getInstances(typeIndex);
    }

    public addInstance(typeIndex: number, instance: FoliageInstanceData): void {
        this.store.addInstance(typeIndex, instance);
        this.dirtyTypes.add(typeIndex);
    }

    public addType(type?: FoliageTypeData): number {
        const index = this.store.addType(type);
        this.structureDirty = true;
        return index;
    }

    public duplicateType(typeIndex: number): number {
        const index = this.store.duplicateType(typeIndex);
        if (index >= 0) this.structureDirty = true;
        return index;
    }

    public updateType(typeIndex: number, patch: Partial<FoliageTypeData>): void {
        this.store.updateType(typeIndex, patch);
        this.dirtyTypes.add(typeIndex);
    }

    public removeType(typeIndex: number): boolean {
        const removed = this.store.removeType(typeIndex);
        if (removed) this.structureDirty = true;
        return removed;
    }

    public isTooClose(typeIndex: number, point: FoliageVector3, spacing: number): boolean {
        return this.store.isTooClose(typeIndex, point, spacing);
    }

    public removeInstancesNear(position: FoliageVector3, radius: number): number {
        const counts = this.types.map((_, index) => this.getInstances(index).length);
        const removed = this.store.removeInstancesNear(position, radius);
        counts.forEach((count, index) => {
            if (this.getInstances(index).length !== count) this.dirtyTypes.add(index);
        });
        return removed;
    }

    public commitChanges(): void {
        this.flushDirty();
        this.onChanged?.();
    }

    public previewChanges(): void {
        this.flushDirty();
    }

    /** Re-samples only Y; painted XZ coordinates and all random preset values stay intact. */
    public updateSurfaceHeights(): number {
        const sampler = new SurfaceHeightSampler(this.scene.getElements().map((element) => element.mesh));
        if (sampler.isEmpty) return 0;

        let changed = 0;
        for (let typeIndex = 0; typeIndex < this.types.length; typeIndex++) {
            const instances = this.getInstances(typeIndex);
            let typeChanged = false;
            for (const instance of instances) {
                const height = sampler.sample(instance.Position.x, instance.Position.z);
                if (height === null || Math.abs(height - instance.Position.y) <= 1e-5) continue;
                instance.Position.y = height;
                typeChanged = true;
                changed++;
            }
            if (typeChanged) this.updateInstanceTransforms(typeIndex);
        }
        return changed;
    }

    public setWindPreview(patch: Partial<FoliageWindPreviewSettings>): void {
        Object.assign(this.windPreview, patch);
        this.windPreview.directionDegrees = ((this.windPreview.directionDegrees % 360) + 360) % 360;
        this.windPreview.strength = THREE.MathUtils.clamp(this.windPreview.strength, 0, 3);
        this.windPreview.speed = THREE.MathUtils.clamp(this.windPreview.speed, 0, 10);
        this.windPreview.turbulence = THREE.MathUtils.clamp(this.windPreview.turbulence, 0, 2);
        this.syncWindUniforms();
    }

    public update(deltaSeconds: number): void {
        if (!this.windPreview.enabled) return;
        this.windTime += Math.max(0, deltaSeconds);
        for (const material of this.windMaterials) {
            const uniforms = material.userData.foliageWindUniforms as FoliageWindUniforms | undefined;
            if (uniforms) uniforms.time.value = this.windTime;
        }
    }

    public invalidateTexture(path: string): void {
        const key = this.textureKey(path);
        this.textureVersions.set(key, (this.textureVersions.get(key) ?? 0) + 1);
        this.textureLoads.delete(key);
        this.textureCache.get(key)?.dispose();
        this.textureCache.delete(key);
        this.types.forEach((type, index) => {
            if (this.textureKey(type.TexturePath) === key) this.dirtyTypes.add(index);
        });
    }

    public serialize(): FoliageProjectData {
        return this.store.serialize();
    }

    public load(data?: FoliageProjectData): void {
        this.store.load(data);
        this.rebuild();
        this.onChanged?.();
    }

    public clear(): void {
        this.store.clear();
        this.rebuild();
        this.onChanged?.();
    }

    public rebuild(): void {
        for (const typeIndex of [...this.meshes.keys()]) this.removeMesh(typeIndex);
        this.meshes.clear();
        for (const texture of this.fallbackTextures.values()) texture.dispose();
        this.fallbackTextures.clear();
        this.dirtyTypes.clear();
        this.structureDirty = false;

        for (let typeIndex = 0; typeIndex < this.types.length; typeIndex++) this.rebuildType(typeIndex);
    }

    private flushDirty(): void {
        if (this.structureDirty) {
            this.rebuild();
            return;
        }
        const dirty = [...this.dirtyTypes];
        this.dirtyTypes.clear();
        dirty.forEach((typeIndex) => this.rebuildType(typeIndex));
    }

    private rebuildType(typeIndex: number): void {
        this.removeMesh(typeIndex);
        const fallback = this.fallbackTextures.get(typeIndex);
        fallback?.dispose();
        this.fallbackTextures.delete(typeIndex);

        const type = this.types[typeIndex];
        const instances = this.getInstances(typeIndex);
        if (!type || instances.length === 0) return;

        const material = this.createMaterial(typeIndex, type);
        const mesh = new THREE.InstancedMesh(this.geometry, material, instances.length);
        mesh.name = `Foliage: ${type.DisplayName}`;
        mesh.castShadow = type.CastShadows;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;

        const matrix = new THREE.Matrix4();
        const quaternion = new THREE.Quaternion();
        const position = new THREE.Vector3();
        const scale = new THREE.Vector3();
        const instanceColor = new THREE.Color();
        const colorA = new THREE.Color(type.ColorA.r, type.ColorA.g, type.ColorA.b);
        const colorB = new THREE.Color(type.ColorB.r, type.ColorB.g, type.ColorB.b);

        instances.forEach((instance, index) => {
            const dimensions = resolveFoliageDimensions(type, instance.ScaleT);
            position.set(instance.Position.x, instance.Position.y, instance.Position.z);
            quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(instance.RotationY));
            scale.set(dimensions.width, dimensions.height, dimensions.width);
            matrix.compose(position, quaternion, scale);
            mesh.setMatrixAt(index, matrix);
            instanceColor.copy(colorA).lerp(colorB, instance.ColorT);
            mesh.setColorAt(index, instanceColor);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        this.root.add(mesh);
        this.meshes.set(typeIndex, mesh);

        if (!type.TexturePath) return;
        void this.getCachedTexture(type.TexturePath).then((texture) => {
            if (!texture || this.meshes.get(typeIndex) !== mesh) return;
            material.map = texture;
            material.alphaMap = null;
            material.color.setHex(0xffffff);
            material.alphaTest = type.AlphaCutoff;
            material.needsUpdate = true;
        });
    }

    private removeMesh(typeIndex: number): void {
        const mesh = this.meshes.get(typeIndex);
        if (!mesh) return;
        this.root.remove(mesh);
        mesh.dispose();
        const material = mesh.material as THREE.MeshBasicMaterial;
        this.windMaterials.delete(material);
        material.dispose();
        this.meshes.delete(typeIndex);
    }

    private updateInstanceTransforms(typeIndex: number): void {
        const mesh = this.meshes.get(typeIndex);
        const type = this.types[typeIndex];
        const instances = this.getInstances(typeIndex);
        if (!mesh || !type || mesh.count !== instances.length) {
            this.dirtyTypes.add(typeIndex);
            return;
        }

        const matrix = new THREE.Matrix4();
        const quaternion = new THREE.Quaternion();
        const position = new THREE.Vector3();
        const scale = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        for (let index = 0; index < instances.length; index++) {
            const instance = instances[index];
            const dimensions = resolveFoliageDimensions(type, instance.ScaleT);
            position.set(instance.Position.x, instance.Position.y, instance.Position.z);
            quaternion.setFromAxisAngle(up, THREE.MathUtils.degToRad(instance.RotationY));
            scale.set(dimensions.width, dimensions.height, dimensions.width);
            mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
    }

    private getCachedTexture(path: string): Promise<THREE.Texture | null> {
        const key = this.textureKey(path);
        const cached = this.textureCache.get(key);
        if (cached) return Promise.resolve(cached);
        const pending = this.textureLoads.get(key);
        if (pending) return pending;

        const version = this.textureVersions.get(key) ?? 0;
        let load: Promise<THREE.Texture | null>;
        load = this.textureLibrary.loadTexture(path)
            .then((texture) => {
                if (!texture) return null;
                if ((this.textureVersions.get(key) ?? 0) !== version) {
                    texture.dispose();
                    return null;
                }
                texture.wrapS = THREE.ClampToEdgeWrapping;
                texture.wrapT = THREE.ClampToEdgeWrapping;
                texture.flipY = true;
                this.textureCache.set(key, texture);
                return texture;
            })
            .finally(() => {
                if (this.textureLoads.get(key) === load) this.textureLoads.delete(key);
            });
        this.textureLoads.set(key, load);
        return load;
    }

    private textureKey(path: string): string {
        return path.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    }

    private createMaterial(typeIndex: number, type: FoliageTypeData): THREE.MeshBasicMaterial {
        const fallbackColor = new THREE.Color(type.ColorA.r, type.ColorA.g, type.ColorA.b)
            .lerp(new THREE.Color(type.ColorB.r, type.ColorB.g, type.ColorB.b), 0.5);
        const material = new THREE.MeshBasicMaterial({
            alphaMap: this.getFallbackTexture(typeIndex, type),
            color: fallbackColor,
            // Keep compatibility ColorT in data; the editor preview uses the type
            // tint directly because instanced vertex colors render black on some
            // WebGL drivers when combined with alpha-only fallback textures.
            vertexColors: false,
            alphaTest: 0.2,
            transparent: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        this.configureWindMaterial(material, type);
        return material;
    }

    private configureWindMaterial(material: THREE.MeshBasicMaterial, type: FoliageTypeData): void {
        const angle = THREE.MathUtils.degToRad(this.windPreview.directionDegrees);
        const uniforms: FoliageWindUniforms = {
            time: { value: this.windTime },
            direction: { value: new THREE.Vector2(Math.cos(angle), Math.sin(angle)) },
            strength: { value: this.windPreview.enabled ? this.windPreview.strength : 0 },
            speed: { value: this.windPreview.speed },
            turbulence: { value: this.windPreview.turbulence },
            effectiveness: { value: type.WindEffectiveness },
            heightInfluence: { value: type.WindHeightOffset },
            baseOffset: { value: type.WindBaseOffset },
        };
        material.userData.foliageWindUniforms = uniforms;
        material.onBeforeCompile = (shader) => {
            shader.uniforms.uFoliageTime = uniforms.time;
            shader.uniforms.uFoliageDirection = uniforms.direction;
            shader.uniforms.uFoliageStrength = uniforms.strength;
            shader.uniforms.uFoliageSpeed = uniforms.speed;
            shader.uniforms.uFoliageTurbulence = uniforms.turbulence;
            shader.uniforms.uFoliageEffectiveness = uniforms.effectiveness;
            shader.uniforms.uFoliageHeightInfluence = uniforms.heightInfluence;
            shader.uniforms.uFoliageBaseOffset = uniforms.baseOffset;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                `#include <common>
                uniform float uFoliageTime;
                uniform vec2 uFoliageDirection;
                uniform float uFoliageStrength;
                uniform float uFoliageSpeed;
                uniform float uFoliageTurbulence;
                uniform float uFoliageEffectiveness;
                uniform float uFoliageHeightInfluence;
                uniform float uFoliageBaseOffset;`,
            );
            shader.vertexShader = shader.vertexShader.replace(
                '#include <project_vertex>',
                `vec4 foliageLocalPosition = vec4(transformed, 1.0);
                #ifdef USE_INSTANCING
                    vec4 foliageWorldPosition = modelMatrix * instanceMatrix * foliageLocalPosition;
                    vec4 foliageWorldPivot = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                #else
                    vec4 foliageWorldPosition = modelMatrix * foliageLocalPosition;
                    vec4 foliageWorldPivot = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                #endif
                float foliageHeight = (foliageWorldPosition.y - foliageWorldPivot.y) + uFoliageBaseOffset;
                float foliageHeightFactor = clamp(foliageHeight * uFoliageHeightInfluence, 0.0, 1.0);
                foliageHeightFactor *= foliageHeightFactor;
                vec2 foliageDirection = normalize(uFoliageDirection + vec2(0.001));
                vec2 foliagePerpendicular = vec2(-foliageDirection.y, foliageDirection.x);
                float foliagePhase = uFoliageTime * uFoliageSpeed;
                float foliageWave1 = sin(foliagePhase + foliageWorldPosition.x * 0.5 + foliageWorldPosition.z * 0.3);
                float foliageWave2 = sin(foliagePhase * 1.3 + foliageWorldPosition.x * 0.8) * 0.45;
                float foliageTurbulenceWave = sin(foliagePhase * 2.1 + foliageWorldPosition.z * 1.5) * uFoliageTurbulence;
                float foliageSway = (foliageWave1 + foliageWave2 + foliageTurbulenceWave)
                    * uFoliageStrength * uFoliageEffectiveness * foliageHeightFactor;
                foliageWorldPosition.xz += foliageDirection * foliageSway
                    + foliagePerpendicular * (foliageSway * 0.3 * sin(foliagePhase * 0.7 + foliageWorldPosition.z));
                vec4 mvPosition = viewMatrix * foliageWorldPosition;
                gl_Position = projectionMatrix * mvPosition;`,
            );
        };
        material.customProgramCacheKey = () => 'foliage-wind-preview-v1';
        this.windMaterials.add(material);
    }

    private syncWindUniforms(): void {
        const angle = THREE.MathUtils.degToRad(this.windPreview.directionDegrees);
        for (const material of this.windMaterials) {
            const uniforms = material.userData.foliageWindUniforms as FoliageWindUniforms | undefined;
            if (!uniforms) continue;
            uniforms.direction.value.set(Math.cos(angle), Math.sin(angle));
            uniforms.strength.value = this.windPreview.enabled ? this.windPreview.strength : 0;
            uniforms.speed.value = this.windPreview.speed;
            uniforms.turbulence.value = this.windPreview.turbulence;
        }
    }

    private getFallbackTexture(typeIndex: number, type: FoliageTypeData): THREE.CanvasTexture {
        const existing = this.fallbackTextures.get(typeIndex);
        if (existing) return existing;

        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d')!;
        context.clearRect(0, 0, 64, 64);
        const primary = new THREE.Color(type.ColorA.r, type.ColorA.g, type.ColorA.b);
        const accent = new THREE.Color(type.ColorB.r, type.ColorB.g, type.ColorB.b);
        context.fillStyle = `#${primary.getHexString()}`;

        for (let leaf = 0; leaf < 14; leaf++) {
            const angle = leaf * 2.399;
            const radius = 5 + (leaf % 5) * 5;
            const x = 32 + Math.cos(angle) * radius;
            const y = 38 + Math.sin(angle) * radius * 0.75;
            context.beginPath();
            context.ellipse(x, y, 7, 11, angle, 0, Math.PI * 2);
            context.fillStyle = leaf % 2 ? `#${accent.getHexString()}` : `#${primary.getHexString()}`;
            context.fill();
        }
        context.fillStyle = `#${primary.getHexString()}`;
        context.fillRect(29, 35, 6, 29);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        this.fallbackTextures.set(typeIndex, texture);
        return texture;
    }

    private createCrossQuadGeometry(): THREE.BufferGeometry {
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        const appendQuad = (angle: number): void => {
            const base = positions.length / 3;
            const cosine = Math.cos(angle);
            const sine = Math.sin(angle);
            const vertices = [
                [-0.5, 0, 0], [0.5, 0, 0], [-0.5, 1, 0], [0.5, 1, 0],
            ];
            for (const [x, y, z] of vertices) {
                positions.push(x * cosine + z * sine, y, -x * sine + z * cosine);
                normals.push(sine, 0, cosine);
            }
            uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
            indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
        };
        appendQuad(0);
        appendQuad(Math.PI / 2);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        geometry.computeBoundingSphere();
        return geometry;
    }
}
