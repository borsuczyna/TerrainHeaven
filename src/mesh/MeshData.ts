export interface MeshVector3 {
    x: number;
    y: number;
    z: number;
}

export type MeshSourceFormat = 'obj' | 'fbx' | 'glb';

// A placed-prop asset is a thin, project-serializable reference into MeshLibrary's
// browser-local blob storage - the same split as FoliageTypeData.TexturePath pointing
// into TextureLibrary. LibraryPath is MeshLibrary's stable bundle key (its main file's
// relative path), used to relink/mark-missing on project reload exactly like textures
// do; Id is a short, filename-safe identity used when naming exported OBJ/MTL files
// (LibraryPath may contain folder separators or spaces uploaded folder structure).
export interface MeshAssetData {
    Id: string;
    DisplayName: string;
    LibraryPath: string;
    // Calibration baked into the exported/rendered geometry once, at load time, so every
    // placed instance and the exported OBJ are already correctly sized/pivoted - fixes
    // uploaded files authored in the wrong unit (e.g. centimeters) or with a pivot that
    // isn't at the model's base. See src/mesh/MeshCalibration.ts.
    BaseScale: number;
    PositionOffset: MeshVector3;
}

// Export-ready Unity contract: records can be copied without translating their meaning.
// Unlike foliage's Y-only billboard rotation, placed props are real 3D meshes and need a
// full Euler so a placed rock or crate can rest at an arbitrary orientation.
export interface MeshInstanceData {
    Position: MeshVector3;
    RotationX: number;
    RotationY: number;
    RotationZ: number;
    Scale: number;
    AssetIndex: number;
}

export interface MeshAssetLayerData {
    Instances: MeshInstanceData[];
}

export interface MeshProjectData {
    Version: 1;
    Assets: MeshAssetData[];
    Layers: MeshAssetLayerData[];
}

export const createMeshAsset = (displayName: string, libraryPath: string): MeshAssetData => ({
    Id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    DisplayName: displayName,
    LibraryPath: libraryPath,
    BaseScale: 1,
    PositionOffset: { x: 0, y: 0, z: 0 },
});

export const cloneMeshAssets = (assets: MeshAssetData[]): MeshAssetData[] => (
    assets.map((asset) => ({ ...asset, PositionOffset: { ...asset.PositionOffset } }))
);

export class MeshStore {
    public assets: MeshAssetData[];
    private layers: MeshAssetLayerData[];

    constructor(assets: MeshAssetData[] = []) {
        this.assets = cloneMeshAssets(assets);
        this.layers = this.assets.map(() => ({ Instances: [] }));
    }

    public addAsset(asset: MeshAssetData): number {
        this.assets.push(cloneMeshAssets([asset])[0]);
        this.layers.push({ Instances: [] });
        return this.assets.length - 1;
    }

    public renameAsset(assetIndex: number, displayName: string): void {
        const asset = this.assets[assetIndex];
        if (!asset) return;
        asset.DisplayName = displayName;
    }

    public updateAsset(assetIndex: number, patch: Partial<Pick<MeshAssetData, 'BaseScale' | 'PositionOffset'>>): void {
        const asset = this.assets[assetIndex];
        if (!asset) return;
        if (patch.BaseScale !== undefined) asset.BaseScale = patch.BaseScale > 0 ? patch.BaseScale : asset.BaseScale;
        if (patch.PositionOffset !== undefined) asset.PositionOffset = { ...patch.PositionOffset };
    }

    public removeAsset(assetIndex: number): boolean {
        if (!this.assets[assetIndex]) return false;
        this.assets.splice(assetIndex, 1);
        this.layers.splice(assetIndex, 1);
        for (let index = assetIndex; index < this.layers.length; index++) {
            for (const instance of this.layers[index].Instances) instance.AssetIndex = index;
        }
        return true;
    }

    public getInstances(assetIndex: number): readonly MeshInstanceData[] {
        this.ensureLayer(assetIndex);
        return this.layers[assetIndex].Instances;
    }

    public addInstance(assetIndex: number, instance: MeshInstanceData): void {
        this.ensureLayer(assetIndex);
        this.layers[assetIndex].Instances.push({
            ...instance,
            Position: { ...instance.Position },
            AssetIndex: assetIndex,
        });
    }

    public isTooClose(assetIndex: number, point: MeshVector3, spacing: number): boolean {
        const distanceSq = spacing * spacing;
        return this.getInstances(assetIndex).some((instance) => {
            const dx = instance.Position.x - point.x;
            const dy = instance.Position.y - point.y;
            const dz = instance.Position.z - point.z;
            return dx * dx + dy * dy + dz * dz < distanceSq;
        });
    }

    public removeInstanceAt(assetIndex: number, instanceIndex: number): boolean {
        const layer = this.layers[assetIndex];
        if (!layer || !layer.Instances[instanceIndex]) return false;
        layer.Instances.splice(instanceIndex, 1);
        return true;
    }

    public removeInstancesNear(position: MeshVector3, radius: number): number {
        const radiusSq = radius * radius;
        let removed = 0;
        for (const layer of this.layers) {
            const before = layer.Instances.length;
            layer.Instances = layer.Instances.filter((instance) => {
                const dx = instance.Position.x - position.x;
                const dy = instance.Position.y - position.y;
                const dz = instance.Position.z - position.z;
                return dx * dx + dy * dy + dz * dz > radiusSq;
            });
            removed += before - layer.Instances.length;
        }
        return removed;
    }

    public clear(): void {
        this.layers = this.assets.map(() => ({ Instances: [] }));
    }

    public serialize(): MeshProjectData {
        return {
            Version: 1,
            Assets: cloneMeshAssets(this.assets),
            Layers: this.layers.map((layer) => ({
                Instances: layer.Instances.map((instance) => ({
                    ...instance,
                    Position: { ...instance.Position },
                })),
            })),
        };
    }

    public load(data?: MeshProjectData): void {
        if (!data) {
            this.assets = [];
            this.clear();
            return;
        }
        this.assets = cloneMeshAssets((data.Assets ?? []).map((asset) => ({
            ...asset,
            BaseScale: asset.BaseScale && asset.BaseScale > 0 ? asset.BaseScale : 1,
            PositionOffset: asset.PositionOffset ?? { x: 0, y: 0, z: 0 },
        })));
        this.layers = this.assets.map((_, index) => ({
            Instances: (data.Layers?.[index]?.Instances ?? []).map((instance) => ({
                Position: { ...instance.Position },
                RotationX: instance.RotationX,
                RotationY: instance.RotationY,
                RotationZ: instance.RotationZ,
                Scale: instance.Scale,
                AssetIndex: index,
            })),
        }));
    }

    private ensureLayer(assetIndex: number): void {
        while (this.layers.length <= assetIndex) this.layers.push({ Instances: [] });
    }
}
