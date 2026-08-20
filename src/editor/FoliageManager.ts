import * as THREE from 'three';
import { inject, singleton } from 'tsyringe';
import SceneManager from './SceneManager';
import TextureLibrary from './TextureLibrary';
import {
    FoliageStore,
    type FoliageInstanceData,
    type FoliageProjectData,
    type FoliageTypeData,
    type FoliageVector3,
} from '../foliage/FoliageData';

@singleton()
export default class FoliageManager {
    public readonly store = new FoliageStore();
    public onChanged: (() => void) | null = null;

    private readonly root = new THREE.Group();
    private readonly meshes = new Map<number, THREE.InstancedMesh>();
    private readonly fallbackTextures = new Map<number, THREE.CanvasTexture>();
    private readonly geometry = this.createCrossQuadGeometry();

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(TextureLibrary) private readonly textureLibrary: TextureLibrary,
    ) {
        this.root.name = 'Foliage';
        this.root.userData.foliageRoot = true;
        this.scene.instance.add(this.root);
    }

    public get types(): readonly FoliageTypeData[] { return this.store.types; }

    public getInstances(typeIndex: number): readonly FoliageInstanceData[] {
        return this.store.getInstances(typeIndex);
    }

    public addInstance(typeIndex: number, instance: FoliageInstanceData): void {
        this.store.addInstance(typeIndex, instance);
    }

    public addType(type?: FoliageTypeData): number {
        return this.store.addType(type);
    }

    public duplicateType(typeIndex: number): number {
        return this.store.duplicateType(typeIndex);
    }

    public updateType(typeIndex: number, patch: Partial<FoliageTypeData>): void {
        this.store.updateType(typeIndex, patch);
    }

    public removeType(typeIndex: number): boolean {
        return this.store.removeType(typeIndex);
    }

    public isTooClose(typeIndex: number, point: FoliageVector3, spacing: number): boolean {
        return this.store.isTooClose(typeIndex, point, spacing);
    }

    public removeInstancesNear(position: FoliageVector3, radius: number): number {
        return this.store.removeInstancesNear(position, radius);
    }

    public commitChanges(): void {
        this.rebuild();
        this.onChanged?.();
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
        for (const mesh of this.meshes.values()) {
            this.root.remove(mesh);
            mesh.dispose();
            (mesh.material as THREE.Material).dispose();
        }
        this.meshes.clear();
        for (const texture of this.fallbackTextures.values()) texture.dispose();
        this.fallbackTextures.clear();

        for (let typeIndex = 0; typeIndex < this.types.length; typeIndex++) {
            const instances = this.getInstances(typeIndex);
            if (instances.length === 0) continue;

            const type = this.types[typeIndex];
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
                const height = THREE.MathUtils.lerp(type.MinSize, type.MaxSize, instance.ScaleT);
                const width = height * type.LengthFactor;
                position.set(instance.Position.x, instance.Position.y, instance.Position.z);
                quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(instance.RotationY));
                scale.set(width, height, width);
                matrix.compose(position, quaternion, scale);
                mesh.setMatrixAt(index, matrix);
                instanceColor.copy(colorA).lerp(colorB, instance.ColorT);
                mesh.setColorAt(index, instanceColor);
            });
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            this.root.add(mesh);
            this.meshes.set(typeIndex, mesh);

            if (!type.TexturePath) continue;
            void this.textureLibrary.loadTexture(type.TexturePath).then((texture) => {
                if (!texture || this.meshes.get(typeIndex) !== mesh) return;
                texture.wrapS = THREE.ClampToEdgeWrapping;
                texture.wrapT = THREE.ClampToEdgeWrapping;
                texture.flipY = true;
                material.map = texture;
                material.alphaMap = null;
                material.color.setHex(0xffffff);
                material.vertexColors = true;
                material.alphaTest = type.AlphaCutoff;
                material.needsUpdate = true;
            });
        }
    }

    private createMaterial(typeIndex: number, type: FoliageTypeData): THREE.MeshBasicMaterial {
        const fallbackColor = new THREE.Color(type.ColorA.r, type.ColorA.g, type.ColorA.b)
            .lerp(new THREE.Color(type.ColorB.r, type.ColorB.g, type.ColorB.b), 0.5);
        return new THREE.MeshBasicMaterial({
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
