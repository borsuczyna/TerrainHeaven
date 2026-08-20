export interface FoliageVector3 {
    x: number;
    y: number;
    z: number;
}

export interface FoliageColor {
    r: number;
    g: number;
    b: number;
    a: number;
}

// Export-ready Unity contract: records can be copied without translating their meaning.
export interface FoliageInstanceData {
    Position: FoliageVector3;
    RotationY: number;
    ScaleT: number;
    ColorT: number;
    TypeIndex: number;
}

// TexturePath is the portable asset reference that a future Unity exporter
// will resolve to a Texture2D.
export interface FoliageTypeData {
    DisplayName: string;
    TexturePath: string;
    MinSize: number;
    MaxSize: number;
    LengthFactor: number;
    ColorA: FoliageColor;
    ColorB: FoliageColor;
    WindEffectiveness: number;
    WindHeightOffset: number;
    WindBaseOffset: number;
    MaxDrawDistance: number;
    AlphaCutoff: number;
    CastShadows: boolean;
}

export interface FoliageTypeLayerData {
    Instances: FoliageInstanceData[];
}

export interface FoliageProjectData {
    Version: 1;
    Types: FoliageTypeData[];
    Layers: FoliageTypeLayerData[];
}

const color = (value: number): FoliageColor => ({ r: value, g: value, b: value, a: 1 });

export const createDefaultFoliageType = (displayName = 'New Foliage'): FoliageTypeData => ({
    DisplayName: displayName,
    TexturePath: '',
    MinSize: 0.5,
    MaxSize: 1,
    LengthFactor: 1,
    ColorA: color(1),
    ColorB: color(1),
    WindEffectiveness: 0.1,
    WindHeightOffset: 1,
    WindBaseOffset: 0,
    MaxDrawDistance: 40,
    AlphaCutoff: 0.5,
    CastShadows: false,
});

export const cloneFoliageTypes = (types: FoliageTypeData[]): FoliageTypeData[] => (
    types.map((type) => ({
        ...type,
        ColorA: { ...type.ColorA },
        ColorB: { ...type.ColorB },
    }))
);

export class FoliageStore {
    public types: FoliageTypeData[];
    private layers: FoliageTypeLayerData[];

    constructor(types: FoliageTypeData[] = []) {
        this.types = cloneFoliageTypes(types);
        this.layers = this.types.map(() => ({ Instances: [] }));
    }

    public addType(type = createDefaultFoliageType()): number {
        this.types.push(cloneFoliageTypes([type])[0]);
        this.layers.push({ Instances: [] });
        return this.types.length - 1;
    }

    public duplicateType(typeIndex: number): number {
        const source = this.types[typeIndex];
        if (!source) return -1;
        return this.addType({ ...source, DisplayName: `${source.DisplayName} Copy` });
    }

    public updateType(typeIndex: number, patch: Partial<FoliageTypeData>): void {
        const type = this.types[typeIndex];
        if (!type) return;
        this.types[typeIndex] = {
            ...type,
            ...patch,
            ColorA: patch.ColorA ? { ...patch.ColorA } : type.ColorA,
            ColorB: patch.ColorB ? { ...patch.ColorB } : type.ColorB,
        };
    }

    public removeType(typeIndex: number): boolean {
        if (!this.types[typeIndex]) return false;
        this.types.splice(typeIndex, 1);
        this.layers.splice(typeIndex, 1);
        for (let index = typeIndex; index < this.layers.length; index++) {
            for (const instance of this.layers[index].Instances) instance.TypeIndex = index;
        }
        return true;
    }

    public getInstances(typeIndex: number): readonly FoliageInstanceData[] {
        this.ensureLayer(typeIndex);
        return this.layers[typeIndex].Instances;
    }

    public addInstance(typeIndex: number, instance: FoliageInstanceData): void {
        this.ensureLayer(typeIndex);
        this.layers[typeIndex].Instances.push(instance);
    }

    public isTooClose(typeIndex: number, point: FoliageVector3, spacing: number): boolean {
        const distanceSq = spacing * spacing;
        return this.getInstances(typeIndex).some((instance) => {
            const dx = instance.Position.x - point.x;
            const dy = instance.Position.y - point.y;
            const dz = instance.Position.z - point.z;
            return dx * dx + dy * dy + dz * dz < distanceSq;
        });
    }

    public removeInstancesNear(position: FoliageVector3, radius: number): number {
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
        this.layers = this.types.map(() => ({ Instances: [] }));
    }

    public serialize(): FoliageProjectData {
        return {
            Version: 1,
            Types: cloneFoliageTypes(this.types),
            Layers: this.layers.map((layer) => ({
                Instances: layer.Instances.map((instance) => ({
                    ...instance,
                    Position: { ...instance.Position },
                })),
            })),
        };
    }

    public load(data?: FoliageProjectData): void {
        if (!data) {
            this.types = [];
            this.clear();
            return;
        }
        this.types = cloneFoliageTypes(data.Types ?? []);
        this.layers = this.types.map((_, index) => ({
            Instances: (data.Layers?.[index]?.Instances ?? []).map((instance) => ({
                Position: { ...instance.Position },
                RotationY: instance.RotationY,
                ScaleT: instance.ScaleT,
                ColorT: instance.ColorT,
                TypeIndex: instance.TypeIndex,
            })),
        }));
    }

    private ensureLayer(typeIndex: number): void {
        while (this.layers.length <= typeIndex) this.layers.push({ Instances: [] });
    }
}
