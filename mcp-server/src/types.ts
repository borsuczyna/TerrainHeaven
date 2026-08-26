export type Vec3 = { x: number; y: number; z: number };

export type ElementType =
    | 'road' | 'intersection' | 'terrain' | 'terrainCutSpline'
    | 'river' | 'fence' | 'terrainPolygon' | 'building';

export type ElementData = {
    type: ElementType;
    id: number;
    nodes: Vec3[];
    textures: Record<string, string>;
    textureRotations: Record<string, number>;
    [key: string]: unknown;
};

export type ConnectionData = {
    elementA: number;
    nodeA: number;
    elementB: number;
    nodeB: number;
};

export type FoliageTypeData = {
    DisplayName: string;
    TexturePath: string;
    MinSize: number;
    MaxSize: number;
    LengthFactor: number;
    ColorA: { r: number; g: number; b: number; a: number };
    ColorB: { r: number; g: number; b: number; a: number };
    WindEffectiveness: number;
    WindHeightOffset: number;
    WindBaseOffset: number;
    MaxDrawDistance: number;
    AlphaCutoff: number;
    CastShadows: boolean;
};

export type FoliageInstanceData = {
    Position: Vec3;
    RotationY: number;
    ScaleT: number;
    ColorT: number;
    TypeIndex: number;
};

export type ProjectData = {
    version: 1;
    settings: Record<string, unknown>;
    elements: ElementData[];
    connections: ConnectionData[];
    terrainCutPoints?: Array<Vec3 & { radius?: number }>;
    texturePaths?: string[];
    foliage?: {
        Version: 1;
        Types: FoliageTypeData[];
        Layers: Array<{ Instances: FoliageInstanceData[] }>;
    };
    meshes?: Record<string, unknown>;
};

export type Bounds2 = { minX: number; maxX: number; minZ: number; maxZ: number };

export type ElementSummary = {
    id: number;
    type: ElementType;
    nodeCount: number;
    bounds: Bounds2 | null;
};
