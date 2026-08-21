import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { inject, singleton } from 'tsyringe';
import SceneManager from './SceneManager';
import MeshLibrary from './MeshLibrary';
import LODPreviewManager from './LODPreviewManager';
import {
    MeshStore,
    type MeshAssetData,
    type MeshInstanceData,
    type MeshProjectData,
    type MeshVector3,
} from '../mesh/MeshData';
import { invalidateMeshAsset, loadMeshAsset, type LoadedMeshAsset, type LoadedMeshGroup } from '../mesh/MeshLoader';
import { getLODGroups, invalidateAssetLODs } from '../mesh/MeshLODGenerator';
import { calibrateGroups } from '../mesh/MeshCalibration';
import SurfaceHeightSampler from '../terrain/SurfaceHeightSampler';

// Places real 3D prop meshes in the scene, the same top-level "instanced group, not a
// WorldElement" shape as FoliageManager - except each asset is a loaded file (see
// src/mesh/MeshLoader.ts) rather than a procedural cross-quad, so instancing happens per
// (asset, material submesh) InstancedMesh instead of one per foliage type.
@singleton()
export default class MeshManager {
    public readonly store = new MeshStore();
    public onChanged: (() => void) | null = null;

    private readonly root = new THREE.Group();
    private readonly assetGroups = new Map<number, THREE.Group>();
    private readonly loadedByPath = new Map<string, LoadedMeshAsset>();
    private readonly loadingPaths = new Set<string>();
    private readonly dirtyAssets = new Set<number>();
    private structureDirty = false;

    constructor(
        @inject(SceneManager) private readonly scene: SceneManager,
        @inject(MeshLibrary) private readonly library: MeshLibrary,
        @inject(LODPreviewManager) private readonly lodPreview: LODPreviewManager,
    ) {
        this.root.name = 'Meshes';
        this.root.userData.meshRoot = true;
        this.scene.instance.add(this.root);
        this.scene.onTerrainSurfaceChanged(() => this.updateSurfaceHeights());
        // WorldElements pull LODPreviewManager.level themselves inside scene.update();
        // this group sits outside that update loop, so it needs the explicit hook.
        this.lodPreview.onLevelChanged(() => this.rebuild());
    }

    public get assets(): readonly MeshAssetData[] { return this.store.assets; }

    public getInstances(assetIndex: number): readonly MeshInstanceData[] {
        return this.store.getInstances(assetIndex);
    }

    public addInstance(assetIndex: number, instance: MeshInstanceData): void {
        this.store.addInstance(assetIndex, instance);
        this.dirtyAssets.add(assetIndex);
    }

    public addAsset(asset: MeshAssetData): number {
        const index = this.store.addAsset(asset);
        this.structureDirty = true;
        return index;
    }

    public renameAsset(assetIndex: number, displayName: string): void {
        this.store.renameAsset(assetIndex, displayName);
        this.onChanged?.();
    }

    public updateCalibration(assetIndex: number, patch: { BaseScale?: number; PositionOffset?: MeshVector3 }): void {
        this.store.updateAsset(assetIndex, patch);
        this.dirtyAssets.add(assetIndex);
        this.commitChanges();
    }

    public removeAsset(assetIndex: number): boolean {
        const removed = this.store.removeAsset(assetIndex);
        if (removed) this.structureDirty = true;
        return removed;
    }

    // Called once a missing library asset gets re-uploaded/relinked (see MeshLibrary's
    // onAssetAvailable and ProjectSerializer wiring it up) so props painted before the
    // browser lost the blob (a fresh session, a cleared cache) start rendering again
    // without the user having to re-place them.
    public notifyAssetAvailable(libraryPath: string): void {
        this.loadedByPath.delete(libraryPath);
        invalidateMeshAsset(libraryPath);
        invalidateAssetLODs(libraryPath);
        let affected = false;
        this.assets.forEach((asset, index) => {
            if (asset.LibraryPath !== libraryPath) return;
            this.dirtyAssets.add(index);
            affected = true;
        });
        if (affected) this.commitChanges();
    }

    public isTooClose(assetIndex: number, point: MeshVector3, spacing: number): boolean {
        return this.store.isTooClose(assetIndex, point, spacing);
    }

    public getInstance(assetIndex: number, instanceIndex: number): MeshInstanceData | null {
        return this.getInstances(assetIndex)[instanceIndex] ?? null;
    }

    // Used by MeshInstanceSelector's gizmo/property edits on a single already-placed
    // instance - cheap in-place matrix update instead of rebuilding the whole asset.
    public updateInstanceTransform(
        assetIndex: number,
        instanceIndex: number,
        patch: Partial<Pick<MeshInstanceData, 'Position' | 'RotationX' | 'RotationY' | 'RotationZ' | 'Scale'>>,
    ): void {
        const instance = this.getInstances(assetIndex)[instanceIndex];
        if (!instance) return;
        if (patch.Position) instance.Position = { ...patch.Position };
        if (patch.RotationX !== undefined) instance.RotationX = patch.RotationX;
        if (patch.RotationY !== undefined) instance.RotationY = patch.RotationY;
        if (patch.RotationZ !== undefined) instance.RotationZ = patch.RotationZ;
        if (patch.Scale !== undefined) instance.Scale = patch.Scale;
        this.refreshSingleInstance(assetIndex, instanceIndex);
    }

    public removeInstanceAt(assetIndex: number, instanceIndex: number): boolean {
        const removed = this.store.removeInstanceAt(assetIndex, instanceIndex);
        if (removed) {
            this.dirtyAssets.add(assetIndex);
            this.commitChanges();
        }
        return removed;
    }

    public removeInstancesNear(position: MeshVector3, radius: number): number {
        const counts = this.assets.map((_, index) => this.getInstances(index).length);
        const removed = this.store.removeInstancesNear(position, radius);
        counts.forEach((count, index) => {
            if (this.getInstances(index).length !== count) this.dirtyAssets.add(index);
        });
        return removed;
    }

    public commitChanges(): void {
        this.flushDirty();
        this.onChanged?.();
    }

    /** Re-samples only Y; painted XZ coordinates and per-instance rotation/scale stay intact. */
    public updateSurfaceHeights(): number {
        const sampler = new SurfaceHeightSampler(this.scene.getElements().map((element) => element.mesh));
        if (sampler.isEmpty) return 0;

        let changed = 0;
        for (let assetIndex = 0; assetIndex < this.assets.length; assetIndex++) {
            const instances = this.getInstances(assetIndex);
            let assetChanged = false;
            for (const instance of instances) {
                const height = sampler.sample(instance.Position.x, instance.Position.z);
                if (height === null || Math.abs(height - instance.Position.y) <= 1e-5) continue;
                instance.Position.y = height;
                assetChanged = true;
                changed++;
            }
            if (assetChanged) this.updateInstanceTransforms(assetIndex);
        }
        return changed;
    }

    public serialize(): MeshProjectData {
        return this.store.serialize();
    }

    public load(data?: MeshProjectData): void {
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
        for (const group of this.assetGroups.values()) this.disposeAssetGroup(group);
        this.assetGroups.clear();
        this.dirtyAssets.clear();
        this.structureDirty = false;
        for (let assetIndex = 0; assetIndex < this.assets.length; assetIndex++) this.rebuildAsset(assetIndex);
    }

    private flushDirty(): void {
        if (this.structureDirty) {
            this.rebuild();
            return;
        }
        const dirty = [...this.dirtyAssets];
        this.dirtyAssets.clear();
        dirty.forEach((assetIndex) => this.rebuildAsset(assetIndex));
    }

    private rebuildAsset(assetIndex: number): void {
        const existing = this.assetGroups.get(assetIndex);
        if (existing) {
            this.disposeAssetGroup(existing);
            this.assetGroups.delete(assetIndex);
        }

        const asset = this.assets[assetIndex];
        const instances = this.getInstances(assetIndex);
        if (!asset || instances.length === 0) return;

        const loaded = this.loadedByPath.get(asset.LibraryPath);
        if (!loaded) {
            this.ensureLoaded(asset.LibraryPath, assetIndex);
            return;
        }

        this.buildAssetGroup(assetIndex, loaded, instances);
    }

    // Loading is async (three.js file parsing); until it resolves this asset simply
    // renders nothing, then the completion callback marks it dirty and flushes so any
    // instances painted while loading appear as soon as the geometry is ready.
    private ensureLoaded(libraryPath: string, assetIndex: number): void {
        if (this.loadingPaths.has(libraryPath)) return;
        const libraryAsset = this.library.getAsset(libraryPath);
        if (!libraryAsset) return; // relinked like a missing texture once the user re-uploads it

        this.loadingPaths.add(libraryPath);
        void loadMeshAsset(libraryAsset)
            .then((loaded) => {
                this.loadedByPath.set(libraryPath, loaded);
                this.dirtyAssets.add(assetIndex);
                this.flushDirty();
                this.onChanged?.();
            })
            .catch((error) => {
                console.warn(`Could not load mesh asset "${libraryPath}":`, error);
            })
            .finally(() => {
                this.loadingPaths.delete(libraryPath);
            });
    }

    private buildAssetGroup(assetIndex: number, loaded: LoadedMeshAsset, instances: readonly MeshInstanceData[]): void {
        const asset = this.assets[assetIndex];
        const rawLodGroups = getLODGroups(asset.LibraryPath, this.lodPreview.level, loaded);
        const lodGroups = calibrateGroups(rawLodGroups, asset.BaseScale, asset.PositionOffset);

        const group = new THREE.Group();
        group.name = `Mesh: ${asset.DisplayName}`;

        for (const meshGroup of lodGroups) {
            if (meshGroup.positions.length === 0) continue;
            const geometry = this.buildGeometry(meshGroup);
            const material = this.buildMaterial(meshGroup);
            const instancedMesh = new THREE.InstancedMesh(geometry, material, instances.length);
            instancedMesh.name = meshGroup.name;
            instancedMesh.castShadow = true;
            instancedMesh.receiveShadow = true;
            // Read directly off the hit object by SelectionManager's raycast, the same way
            // it already reads userData.worldElement/worldNode - lets a prop hit take
            // priority over whatever WorldElement (e.g. the terrain right underneath it)
            // happens to sit further along the same ray, instead of being silently skipped.
            instancedMesh.userData.meshAssetIndex = assetIndex;
            this.writeInstanceMatrices(instancedMesh, instances);
            group.add(instancedMesh);
        }

        this.root.add(group);
        this.assetGroups.set(assetIndex, group);
    }

    private buildGeometry(group: LoadedMeshGroup): THREE.BufferGeometry {
        const raw = new THREE.BufferGeometry();
        raw.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
        raw.setAttribute('uv', new THREE.Float32BufferAttribute(group.uvs, 2));
        const merged = mergeVertices(raw) as THREE.BufferGeometry;
        merged.computeVertexNormals();
        raw.dispose();
        return merged;
    }

    private buildMaterial(group: LoadedMeshGroup): THREE.MeshStandardMaterial {
        return new THREE.MeshStandardMaterial({
            map: group.texture,
            color: group.texture ? 0xffffff : new THREE.Color(group.color.r, group.color.g, group.color.b),
            roughness: 0.9,
            metalness: 0,
            // MeshStandardMaterial ignores a texture's alpha channel entirely unless told
            // otherwise - without this, a fence/leaf texture's transparent pixels just
            // render as solid opaque color instead of see-through. Alpha-tested cutout
            // (not blended `transparent: true`) matches how FoliageManager already
            // handles the same problem, and avoids InstancedMesh's lack of per-instance
            // depth sorting breaking blended transparency.
            alphaTest: group.texture ? 0.5 : 0,
        });
    }

    private writeInstanceMatrices(instancedMesh: THREE.InstancedMesh, instances: readonly MeshInstanceData[]): void {
        const matrix = new THREE.Matrix4();
        const quaternion = new THREE.Quaternion();
        const euler = new THREE.Euler();
        const position = new THREE.Vector3();
        const scale = new THREE.Vector3();

        instances.forEach((instance, index) => {
            position.set(instance.Position.x, instance.Position.y, instance.Position.z);
            euler.set(
                THREE.MathUtils.degToRad(instance.RotationX),
                THREE.MathUtils.degToRad(instance.RotationY),
                THREE.MathUtils.degToRad(instance.RotationZ),
            );
            quaternion.setFromEuler(euler);
            scale.setScalar(instance.Scale);
            instancedMesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
        });
        instancedMesh.instanceMatrix.needsUpdate = true;
        instancedMesh.computeBoundingSphere();
    }

    private updateInstanceTransforms(assetIndex: number): void {
        const group = this.assetGroups.get(assetIndex);
        const instances = this.getInstances(assetIndex);
        if (!group || group.children.some((child) => !(child instanceof THREE.InstancedMesh) || child.count !== instances.length)) {
            this.dirtyAssets.add(assetIndex);
            return;
        }
        for (const child of group.children) this.writeInstanceMatrices(child as THREE.InstancedMesh, instances);
    }

    private refreshSingleInstance(assetIndex: number, instanceIndex: number): void {
        const group = this.assetGroups.get(assetIndex);
        const instance = this.getInstances(assetIndex)[instanceIndex];
        if (!group || !instance) return;

        const euler = new THREE.Euler(
            THREE.MathUtils.degToRad(instance.RotationX),
            THREE.MathUtils.degToRad(instance.RotationY),
            THREE.MathUtils.degToRad(instance.RotationZ),
        );
        const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(instance.Position.x, instance.Position.y, instance.Position.z),
            new THREE.Quaternion().setFromEuler(euler),
            new THREE.Vector3().setScalar(instance.Scale),
        );
        for (const child of group.children) {
            if (!(child instanceof THREE.InstancedMesh)) continue;
            child.setMatrixAt(instanceIndex, matrix);
            child.instanceMatrix.needsUpdate = true;
            child.computeBoundingSphere();
        }
    }

    private disposeAssetGroup(group: THREE.Group): void {
        this.root.remove(group);
        for (const child of group.children) {
            if (!(child instanceof THREE.InstancedMesh)) continue;
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
        }
    }
}
