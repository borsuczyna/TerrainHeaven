import type {
    Bounds2, ConnectionData, ElementData, ElementSummary, FoliageTypeData,
    ProjectData, Vec3,
} from './types.js';

export type RoadOptions = {
    width?: number;
    lanes?: number;
    sidewalk?: boolean;
    divisions?: number;
    bridge?: boolean;
};

export type HouseOptions = {
    center: Vec3;
    width?: number;
    depth?: number;
    wallHeight?: number;
    roofType?: 'flat' | 'gable' | 'hip' | 'tented' | 'gambrel';
    roofRidgeHeight?: number;
    windowsPerSide?: number;
    doorSide?: 'north' | 'south' | 'east' | 'west';
    wing?: boolean;
};

const emptyTextures = (): Record<string, string> => ({});
const emptyRotations = (): Record<string, number> => ({});
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const copy = <T>(value: T): T => structuredClone(value);

export class ProjectDocument {
    public readonly data: ProjectData;

    public constructor(project: ProjectData) {
        if (project.version !== 1) throw new Error(`Unsupported TerrainHeaven project version: ${String(project.version)}`);
        this.data = copy(project);
        this.data.elements ??= [];
        this.data.connections ??= [];
        this.reindex();
    }

    public summary(): {
        elementCount: number;
        counts: Record<string, number>;
        bounds: Bounds2 | null;
        foliageTypes: number;
        foliageInstances: number;
        elements: ElementSummary[];
    } {
        const elements = this.data.elements.map((element) => this.elementSummary(element));
        const counts: Record<string, number> = {};
        for (const element of elements) counts[element.type] = (counts[element.type] ?? 0) + 1;
        const bounds = combineBounds(elements.map((element) => element.bounds).filter((value): value is Bounds2 => value !== null));
        return {
            elementCount: elements.length,
            counts,
            bounds,
            foliageTypes: this.data.foliage?.Types.length ?? 0,
            foliageInstances: this.data.foliage?.Layers.reduce((sum, layer) => sum + layer.Instances.length, 0) ?? 0,
            elements,
        };
    }

    public query(type?: string, bounds?: Bounds2): ElementData[] {
        return this.data.elements.filter((element) => {
            if (type && element.type !== type) return false;
            if (bounds) {
                const elementBounds = boundsOf(element.nodes);
                if (!elementBounds || !overlaps(elementBounds, bounds)) return false;
            }
            return true;
        }).map(copy);
    }

    public get(id: number): ElementData {
        const element = this.data.elements[id];
        if (!element) throw new Error(`Element ${id} does not exist`);
        return copy(element);
    }

    public addTerrain(center: Vec3, width: number, length: number, options: Record<string, unknown> = {}): number {
        return this.addElement({
            type: 'terrain', id: -1, nodes: [copy(center)], textures: emptyTextures(), textureRotations: emptyRotations(),
            uvTransforms: { terrain: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 } },
            terrainWidth: Math.max(1, width), terrainLength: Math.max(1, length),
            terrainMeshDetail: clamp(numberOption(options.meshDetail, 2), 0.5, 5),
            terrainTriangleLimit: clamp(Math.round(numberOption(options.triangleLimit, 1500)), 100, 5000),
            terrainSmoothingEnabled: options.smoothingEnabled !== false,
            terrainSmoothingRadius: clamp(numberOption(options.smoothingRadius, 4), 0.5, 20),
            terrainMaxSlope: clamp(numberOption(options.maxSlope, 35), 1, 89),
            terrainHeightPaintSpace: 'world', terrainHeightPaint: [],
        });
    }

    public sculptTerrain(center: Vec3, radius: number, heightDelta: number): number {
        const safeRadius = Math.max(0.5, radius);
        let samples = 0;
        for (const element of this.data.elements) {
            if (element.type !== 'terrain') continue;
            const tileCenter = element.nodes[0];
            const halfWidth = Number(element.terrainWidth ?? 20) / 2;
            const halfLength = Number(element.terrainLength ?? 20) / 2;
            if (center.x + safeRadius < tileCenter.x - halfWidth || center.x - safeRadius > tileCenter.x + halfWidth
                || center.z + safeRadius < tileCenter.z - halfLength || center.z - safeRadius > tileCenter.z + halfLength) continue;
            const paint = new Map<string, { gridX: number; gridZ: number; height: number }>();
            for (const item of (element.terrainHeightPaint as Array<{ gridX: number; gridZ: number; height: number }> | undefined) ?? []) {
                paint.set(`${item.gridX},${item.gridZ}`, { ...item });
            }
            for (let x = Math.floor(center.x - safeRadius); x <= Math.ceil(center.x + safeRadius); x++) {
                for (let z = Math.floor(center.z - safeRadius); z <= Math.ceil(center.z + safeRadius); z++) {
                    const distance = Math.hypot(x - center.x, z - center.z);
                    if (distance > safeRadius) continue;
                    const t = clamp(distance / safeRadius, 0, 1);
                    const falloff = 1 - t * t * (3 - 2 * t);
                    const key = `${x},${z}`;
                    const previous = paint.get(key)?.height ?? 0;
                    const height = clamp(previous + heightDelta * falloff, -100, 100);
                    if (Math.abs(height) < 1e-5) paint.delete(key);
                    else paint.set(key, { gridX: x, gridZ: z, height });
                    samples++;
                }
            }
            element.terrainHeightPaint = [...paint.values()];
            element.terrainHeightPaintSpace = 'world';
        }
        return samples;
    }

    public addRoadPath(points: Vec3[], options: RoadOptions = {}): number[] {
        if (points.length < 2) throw new Error('A road path requires at least two points');
        const ids: number[] = [];
        for (let index = 1; index < points.length; index++) {
            const id = this.addElement(makeRoad(points[index - 1], points[index], options));
            ids.push(id);
            if (ids.length > 1) this.connect(ids[ids.length - 2], 1, id, 0);
        }
        return ids;
    }

    public addRiver(points: Vec3[], width = 4, options: Record<string, unknown> = {}): number[] {
        if (points.length < 2) throw new Error('A river path requires at least two points');
        const ids: number[] = [];
        for (let index = 1; index < points.length; index++) {
            const a = points[index - 1];
            const b = points[index];
            const divisions = Math.max(0, Math.round(numberOption(options.divisions, 8)));
            const id = this.addElement({
                type: 'river', id: -1, nodes: [copy(a), copy(b)], textures: emptyTextures(), textureRotations: emptyRotations(),
                width: Math.max(0.1, width), divisions,
                curvePointA: divisions > 0 ? lerp(a, b, 1 / 3) : null,
                curvePointB: divisions > 0 ? lerp(a, b, 2 / 3) : null,
                riverBankSlope: clamp(numberOption(options.bankSlope, 70), 1, 89),
                riverBankSmoothing: clamp(numberOption(options.bankSmoothing, 0.65), 0, 1),
                riverIrregularityLevel: clamp(numberOption(options.irregularity, 0.25), 0, 1),
                riverDetailLevel: clamp(numberOption(options.detail, 1), 0.1, 4),
            });
            ids.push(id);
            if (ids.length > 1) this.connect(ids[ids.length - 2], 1, id, 0);
        }
        return ids;
    }

    public addFencePath(points: Vec3[], options: Record<string, unknown> = {}): number[] {
        if (points.length < 2) throw new Error('A fence path requires at least two points');
        const ids: number[] = [];
        for (let index = 1; index < points.length; index++) {
            const a = points[index - 1];
            const b = points[index];
            const divisions = Math.max(0, Math.round(numberOption(options.divisions, 0)));
            const id = this.addElement({
                type: 'fence', id: -1, nodes: [copy(a), copy(b)], textures: emptyTextures(), textureRotations: emptyRotations(),
                divisions, curvePointA: divisions > 0 ? lerp(a, b, 1 / 3) : null, curvePointB: divisions > 0 ? lerp(a, b, 2 / 3) : null,
                fenceStyle: options.style === 'box' ? 'box' : 'plane',
                fenceHeight: Math.max(0.05, numberOption(options.height, 1.5)),
                fenceThickness: Math.max(0.01, numberOption(options.thickness, 0.08)),
                fencePostSpacing: Math.max(0.1, numberOption(options.postSpacing, 2)),
                fencePostHeight: Math.max(0.05, numberOption(options.postHeight, 1.8)),
                fencePostWidth: Math.max(0.04, numberOption(options.postWidth, 0.14)),
                fencePostShape: options.postShape === 'circle' ? 'circle' : 'box', fencePostSides: 12, fenceMaxAngleStep: 30,
            });
            ids.push(id);
            if (ids.length > 1) this.connect(ids[ids.length - 2], 1, id, 0);
        }
        return ids;
    }

    public addHouse(options: HouseOptions): number {
        const center = copy(options.center);
        const width = Math.max(3, options.width ?? 8);
        const depth = Math.max(3, options.depth ?? 6);
        const wallHeight = Math.max(1.8, options.wallHeight ?? 2.8);
        const roofType = options.roofType ?? 'gable';
        const ridgeHeight = Math.max(0.1, options.roofRidgeHeight ?? 1.6);
        const segments: Array<Record<string, unknown>> = [makeBuildingSegment(center, width, depth, wallHeight, roofType, ridgeHeight)];
        if (options.wing) {
            segments.push(makeBuildingSegment(
                { x: center.x + width * 0.34, y: center.y, z: center.z + depth * 0.42 },
                width * 0.48, depth * 0.72, wallHeight * 0.92, roofType, ridgeHeight * 0.8,
            ));
        }
        const openings = makeHouseOpenings(center, width, depth, wallHeight, options.windowsPerSide ?? 2, options.doorSide ?? 'south');
        return this.addElement({
            type: 'building', id: -1, nodes: [center], textures: emptyTextures(), textureRotations: emptyRotations(),
            uvTransforms: {}, buildingSegments: segments, buildingRoofThickness: 0.15,
            buildingCutInGround: false, buildingOpenings: openings, buildingRoofWindows: [],
        });
    }

    public addIntersection(center: Vec3, nodeCount = 4, width = 4): number {
        const count = clamp(Math.round(nodeCount), 2, 12);
        const nodes: Vec3[] = [];
        for (let i = 0; i < count; i++) {
            const angle = i / count * Math.PI * 2;
            nodes.push({ x: center.x + Math.cos(angle) * width / 2, y: center.y, z: center.z + Math.sin(angle) * width / 2 });
        }
        return this.addElement({
            type: 'intersection', id: -1, nodes, textures: emptyTextures(), textureRotations: emptyRotations(),
            width, length: width, nodeCount: count, edgeType: 'none', sidewalkWidth: 1, curbHeight: 0.15,
            roadTexWidth: 3, roadTexHeight: 3, roadTexOffsetX: 0, roadTexOffsetY: 0,
        });
    }

    public addFoliagePatch(center: Vec3, radius: number, count: number, options: Record<string, unknown> = {}): { typeIndex: number; added: number } {
        const foliage = this.ensureFoliage();
        let typeIndex = typeof options.typeIndex === 'number' ? Math.round(options.typeIndex) : -1;
        if (!foliage.Types[typeIndex]) {
            typeIndex = foliage.Types.length;
            foliage.Types.push(defaultFoliageType(String(options.displayName ?? 'MCP Foliage'), String(options.texturePath ?? '')));
            foliage.Layers.push({ Instances: [] });
        }
        const random = seededRandom(Math.round(numberOption(options.seed, 1)));
        const safeCount = clamp(Math.round(count), 0, 10_000);
        for (let i = 0; i < safeCount; i++) {
            const angle = random() * Math.PI * 2;
            const distance = Math.sqrt(random()) * Math.max(0, radius);
            foliage.Layers[typeIndex].Instances.push({
                Position: { x: center.x + Math.cos(angle) * distance, y: center.y, z: center.z + Math.sin(angle) * distance },
                RotationY: random() * 360, ScaleT: random(), ColorT: random(), TypeIndex: typeIndex,
            });
        }
        return { typeIndex, added: safeCount };
    }

    public updateElement(id: number, patch: Record<string, unknown>): ElementData {
        const element = this.data.elements[id];
        if (!element) throw new Error(`Element ${id} does not exist`);
        const safePatch = copy(patch);
        delete safePatch.id;
        delete safePatch.type;
        delete safePatch['__proto__'];
        delete safePatch['prototype'];
        delete safePatch['constructor'];
        Object.assign(element, safePatch);
        element.id = id;
        return copy(element);
    }

    public deleteElements(ids: number[]): number {
        const remove = new Set(ids.map(Math.round));
        const remap = new Map<number, number>();
        const kept: ElementData[] = [];
        for (let oldId = 0; oldId < this.data.elements.length; oldId++) {
            if (remove.has(oldId)) continue;
            remap.set(oldId, kept.length);
            kept.push(this.data.elements[oldId]);
        }
        this.data.elements = kept;
        this.data.connections = this.data.connections.flatMap((connection) => {
            const elementA = remap.get(connection.elementA);
            const elementB = remap.get(connection.elementB);
            return elementA === undefined || elementB === undefined ? [] : [{ ...connection, elementA, elementB }];
        });
        this.reindex();
        return remove.size - [...remove].filter((id) => id < 0 || id >= kept.length + remove.size).length;
    }

    public connect(elementA: number, nodeA: number, elementB: number, nodeB: number): void {
        if (!this.data.elements[elementA] || !this.data.elements[elementB]) throw new Error('Cannot connect a missing element');
        if (!this.data.elements[elementA].nodes[nodeA] || !this.data.elements[elementB].nodes[nodeB]) throw new Error('Cannot connect a missing node');
        const occupied = this.data.connections.some((connection) =>
            (connection.elementA === elementA && connection.nodeA === nodeA)
            || (connection.elementB === elementA && connection.nodeB === nodeA)
            || (connection.elementA === elementB && connection.nodeA === nodeB)
            || (connection.elementB === elementB && connection.nodeB === nodeB));
        if (occupied) throw new Error('One of the requested nodes is already connected');
        this.data.connections.push({ elementA, nodeA, elementB, nodeB });
    }

    private addElement(element: ElementData): number {
        element.id = this.data.elements.length;
        this.data.elements.push(element);
        return element.id;
    }

    private reindex(): void {
        this.data.elements.forEach((element, id) => { element.id = id; });
    }

    private elementSummary(element: ElementData): ElementSummary {
        return { id: element.id, type: element.type, nodeCount: element.nodes.length, bounds: boundsOf(element.nodes) };
    }

    private ensureFoliage(): NonNullable<ProjectData['foliage']> {
        this.data.foliage ??= { Version: 1, Types: [], Layers: [] };
        return this.data.foliage;
    }
}

export function makeRoad(a: Vec3, b: Vec3, options: RoadOptions = {}): ElementData {
    const divisions = Math.max(0, Math.round(options.divisions ?? 0));
    return {
        type: 'road', id: -1, nodes: [copy(a), copy(b)], textures: emptyTextures(), textureRotations: emptyRotations(),
        uvTransforms: {}, width: Math.max(0.5, options.width ?? 3), lanes: Math.max(1, Math.round(options.lanes ?? 2)),
        divisions, edgeType: options.sidewalk ? 'sidewalk' : 'none', sidewalkWidth: 1, curbHeight: 0.15, roadCrown: 0,
        curvePointA: divisions > 0 ? lerp(a, b, 1 / 3) : null, curvePointB: divisions > 0 ? lerp(a, b, 2 / 3) : null,
        bridgeEnabled: options.bridge ?? false, bridgePillarShape: 'box', bridgePillarSegments: 12,
        bridgePillarDistance: 8, bridgePillarCount: 2, bridgePillarWidth: 0.8, bridgePillarInset: 0.4,
        bridgeDeckThickness: 0.5, bridgeEdgeStyle: 'solid', bridgeEdgeHeight: 0.8, bridgeEdgeWidth: 0.2,
        bridgeEdgeDistance: 3, bridgeEdgeLength: 1, bridgeEdgeCapEnabled: false,
        bridgeEdgeCapHeight: 0.12, bridgeEdgeCapWidth: 0.36, bridgeEdgeCapJoined: false,
    };
}

function makeBuildingSegment(center: Vec3, width: number, depth: number, wallHeight: number, roofType: string, ridgeHeight: number): Record<string, unknown> {
    return {
        ...copy(center), width, depth, wallHeight, roofRidgeHeight: ridgeHeight, roofOverhang: 0.4,
        roofDirection: width >= depth ? 'x' : 'z', roofType, hipRidgeRatio: 0.5,
        gambrelSegments: 2, gambrelRoundness: 0.4, railingEnabled: roofType === 'flat',
        railingHeight: 1, railingThickness: 0.15,
    };
}

function makeHouseOpenings(center: Vec3, width: number, depth: number, wallHeight: number, windowsPerSide: number, doorSide: string): Array<Record<string, unknown>> {
    const openings: Array<Record<string, unknown>> = [];
    const count = clamp(Math.round(windowsPerSide), 0, 6);
    const add = (x: number, z: number, type: 'window' | 'door', y: number): void => {
        openings.push({ x, y, z, type, width: type === 'door' ? 0.9 : 1.2, height: type === 'door' ? 2.05 : 1.2, depth: 0.1 });
    };
    for (let i = 1; i <= count; i++) {
        const tx = i / (count + 1) - 0.5;
        if (doorSide !== 'south' || i !== Math.ceil(count / 2)) add(center.x + tx * width * 0.8, center.z - depth / 2, 'window', center.y + wallHeight * 0.56);
        if (doorSide !== 'north' || i !== Math.ceil(count / 2)) add(center.x + tx * width * 0.8, center.z + depth / 2, 'window', center.y + wallHeight * 0.56);
        const tz = i / (count + 1) - 0.5;
        if (doorSide !== 'west' || i !== Math.ceil(count / 2)) add(center.x - width / 2, center.z + tz * depth * 0.8, 'window', center.y + wallHeight * 0.56);
        if (doorSide !== 'east' || i !== Math.ceil(count / 2)) add(center.x + width / 2, center.z + tz * depth * 0.8, 'window', center.y + wallHeight * 0.56);
    }
    if (doorSide === 'north') add(center.x, center.z + depth / 2, 'door', center.y + 1.025);
    if (doorSide === 'south') add(center.x, center.z - depth / 2, 'door', center.y + 1.025);
    if (doorSide === 'east') add(center.x + width / 2, center.z, 'door', center.y + 1.025);
    if (doorSide === 'west') add(center.x - width / 2, center.z, 'door', center.y + 1.025);
    return openings;
}

function defaultFoliageType(displayName: string, texturePath: string): FoliageTypeData {
    const color = { r: 1, g: 1, b: 1, a: 1 };
    return {
        DisplayName: displayName, TexturePath: texturePath, MinSize: 0.8, MaxSize: 2.2, LengthFactor: 0.75,
        ColorA: { ...color }, ColorB: { r: 0.72, g: 0.86, b: 0.65, a: 1 }, WindEffectiveness: 0.25,
        WindHeightOffset: 1, WindBaseOffset: 0, MaxDrawDistance: 100, AlphaCutoff: 0.5, CastShadows: true,
    };
}

function boundsOf(nodes: Vec3[]): Bounds2 | null {
    if (nodes.length === 0) return null;
    return {
        minX: Math.min(...nodes.map((node) => node.x)), maxX: Math.max(...nodes.map((node) => node.x)),
        minZ: Math.min(...nodes.map((node) => node.z)), maxZ: Math.max(...nodes.map((node) => node.z)),
    };
}

function combineBounds(bounds: Bounds2[]): Bounds2 | null {
    if (bounds.length === 0) return null;
    return {
        minX: Math.min(...bounds.map((item) => item.minX)), maxX: Math.max(...bounds.map((item) => item.maxX)),
        minZ: Math.min(...bounds.map((item) => item.minZ)), maxZ: Math.max(...bounds.map((item) => item.maxZ)),
    };
}

function overlaps(a: Bounds2, b: Bounds2): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function numberOption(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function seededRandom(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
        state = Math.imul(state ^ state >>> 15, 1 | state);
        state ^= state + Math.imul(state ^ state >>> 7, 61 | state);
        return ((state ^ state >>> 14) >>> 0) / 4294967296;
    };
}
