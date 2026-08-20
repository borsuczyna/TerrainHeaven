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

// Field names intentionally mirror SummerHideout.Foliage.FoliageInstanceData.
// An exporter can copy these records without translating their meaning.
export interface FoliageInstanceData {
    Position: FoliageVector3;
    RotationY: number;
    ScaleT: number;
    ColorT: number;
    TypeIndex: number;
}

// Mirrors SummerHideout.Foliage.FoliageType. TexturePath is the portable asset
// reference that a future Unity exporter will resolve to a Texture2D.
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

const color = (r: number, g: number, b: number): FoliageColor => ({ r, g, b, a: 1 });

// Values copied from Summer Hideout/Assets/Definitions/Foliage*.asset in database order.
export const SUMMER_HIDEOUT_FOLIAGE_TYPES: FoliageTypeData[] = [
    {
        DisplayName: 'Grass Yellow',
        TexturePath: 'grass-plant-yellow.png',
        MinSize: 0.44,
        MaxSize: 1.08,
        LengthFactor: 1,
        ColorA: color(1, 1, 1),
        ColorB: color(1, 0.83631414, 0.5803922),
        WindEffectiveness: 0.1,
        WindHeightOffset: 1,
        WindBaseOffset: 0,
        MaxDrawDistance: 40,
        AlphaCutoff: 0.5,
        CastShadows: false,
    },
    {
        DisplayName: 'Bush',
        TexturePath: 'bush.png',
        MinSize: 0.67,
        MaxSize: 2.04,
        LengthFactor: 1,
        ColorA: color(1, 0.7821041, 0.514151),
        ColorB: color(1, 1, 1),
        WindEffectiveness: 0.1,
        WindHeightOffset: 1,
        WindBaseOffset: 0,
        MaxDrawDistance: 40,
        AlphaCutoff: 0.5,
        CastShadows: false,
    },
    {
        DisplayName: 'Blue Flowers',
        TexturePath: 'blue-flowers.png',
        MinSize: 0.58,
        MaxSize: 0.8,
        LengthFactor: 2.43,
        ColorA: color(1, 0.71863925, 0.3726415),
        ColorB: color(1, 0.7208102, 0.3915094),
        WindEffectiveness: 0.1,
        WindHeightOffset: 1,
        WindBaseOffset: 0,
        MaxDrawDistance: 40,
        AlphaCutoff: 0.5,
        CastShadows: false,
    },
    {
        DisplayName: 'Wild Daisy',
        TexturePath: 'wild_daisy_bush.png',
        MinSize: 0.04,
        MaxSize: 1.05,
        LengthFactor: 1.16,
        ColorA: color(0.5754717, 0.44303754, 0.26330546),
        ColorB: color(0.7924528, 0.71686244, 0.55695975),
        WindEffectiveness: 0.5,
        WindHeightOffset: 1,
        WindBaseOffset: 0,
        MaxDrawDistance: 40,
        AlphaCutoff: 0.5,
        CastShadows: false,
    },
];

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

    constructor(types = SUMMER_HIDEOUT_FOLIAGE_TYPES) {
        this.types = cloneFoliageTypes(types);
        this.layers = this.types.map(() => ({ Instances: [] }));
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
            this.types = cloneFoliageTypes(SUMMER_HIDEOUT_FOLIAGE_TYPES);
            this.clear();
            return;
        }
        this.types = cloneFoliageTypes(data.Types ?? SUMMER_HIDEOUT_FOLIAGE_TYPES);
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
