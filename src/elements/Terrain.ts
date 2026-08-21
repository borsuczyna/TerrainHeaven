import * as THREE from 'three';
import { container } from 'tsyringe';
import WorldElement, { type NodeBasis, type GeometryGroup, type ElementData, type OccupiedTriangle, type UVTransform } from './WorldElement';
import Triangle from './Vertex';
import type { PropertyDefinition } from '../editor/Properties';
import TerrainGroupMesher from '../terrain/TerrainGroupMesher';
import type { TerrainPaintHeightInput, TerrainRect } from '../terrain/TerrainMesher';
import type RiverSpline from './RiverSpline';
import LODPreviewManager from '../editor/LODPreviewManager';

export default class Terrain extends WorldElement {
    public static readonly PAINT_CELL_SIZE = 1;
    // Painted heights live on one world-aligned lattice instead of a per-tile grid, so
    // two neighbours always sample the exact same height field along a shared edge.
    // The margin keeps one ring of cells past every edge, so a bilinear read taken on
    // the seam never falls back to zero on one side of it.
    private static readonly PAINT_EDGE_MARGIN = 1;
    // Slack for deciding whether a paint cell sits inside a tile's footprint.
    private static readonly CELL_EPSILON = 1e-5;
    public override isTerrainSurface(): boolean { return true; }
    public center: THREE.Vector3;
    public width: number;
    public length: number;
    public meshDetail: number = 2;
    public triangleLimit: number = 1500;
    public smoothingEnabled: boolean = true;
    public smoothingRadius: number = 4;
    public maxSlopeDegrees: number = 35;
    private terrainUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    private readonly paintedHeights = new Map<string, TerrainPaintHeightInput>();

    constructor(center: THREE.Vector3, width: number = 20, length: number = 20) {
        super();
        // One low-poly terrain caster gives hills readable self-shadowing without
        // paying the cost of rendering every road/intersection into the shadow map.
        this.mesh.castShadow = true;
        this.center = center.clone();
        this.width = width;
        this.length = length;
    }

    public override update(): void {
        super.update();
        const mats = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
        for (const mat of mats) {
            const material = mat as THREE.MeshStandardMaterial;
            material.side = THREE.DoubleSide;
            material.needsUpdate = true;
        }
    }

    public override translate(delta: THREE.Vector3): void {
        this.center.add(delta);
        this.shiftPaintedHeights(delta);
        this.update();
    }

    public paintHeight(worldPosition: THREE.Vector3, radius: number, amount: number): boolean {
        const cellSize = Terrain.PAINT_CELL_SIZE;
        const bounds = this.getPaintBounds();
        const safeRadius = Math.max(cellSize * 0.5, radius);
        const firstX = Math.max(Math.ceil(bounds.minX / cellSize), Math.floor((worldPosition.x - safeRadius) / cellSize));
        const lastX = Math.min(Math.floor(bounds.maxX / cellSize), Math.ceil((worldPosition.x + safeRadius) / cellSize));
        const firstZ = Math.max(Math.ceil(bounds.minZ / cellSize), Math.floor((worldPosition.z - safeRadius) / cellSize));
        const lastZ = Math.min(Math.floor(bounds.maxZ / cellSize), Math.ceil((worldPosition.z + safeRadius) / cellSize));
        let changed = false;

        for (let gridX = firstX; gridX <= lastX; gridX++) {
            for (let gridZ = firstZ; gridZ <= lastZ; gridZ++) {
                const dx = gridX * cellSize - worldPosition.x;
                const dz = gridZ * cellSize - worldPosition.z;
                const distance = Math.hypot(dx, dz);
                if (distance > safeRadius) continue;
                const t = THREE.MathUtils.clamp(distance / safeRadius, 0, 1);
                const falloff = 1 - t * t * (3 - 2 * t);
                const key = `${gridX},${gridZ}`;
                const previous = this.paintedHeights.get(key)?.height ?? 0;
                const height = THREE.MathUtils.clamp(previous + amount * falloff, -100, 100);
                if (Math.abs(height - previous) <= 1e-6) continue;
                if (Math.abs(height) <= 1e-5) this.paintedHeights.delete(key);
                else this.paintedHeights.set(key, { gridX, gridZ, height });
                changed = true;
            }
        }
        return changed;
    }

    // A third paint mode: blends each cell toward the average of its 3x3 neighbourhood
    // instead of pushing height up or down, smoothing out painted bumps within the brush
    // rather than aiming for any particular height.
    //
    // Static (not per-tile) because a naive per-tile version - each tile reading the
    // shared field and writing its own cells in turn - lets a seam cell come out
    // differently depending on which tile happened to process it first (the second tile
    // to run would already see the first tile's smoothed value as its "current" state,
    // biasing the blend). Computing every affected tile's updates from one snapshot of
    // the untouched field, then applying them all afterward, keeps a seam cell's result
    // independent of tile order - confirmed by a regression test that failed under the
    // naive per-tile version.
    public static smoothHeight(worldPosition: THREE.Vector3, radius: number, strength: number, terrains: Terrain[]): boolean {
        const cellSize = Terrain.PAINT_CELL_SIZE;
        const safeRadius = Math.max(cellSize * 0.5, radius);
        const blendStrength = THREE.MathUtils.clamp(strength, 0, 1);

        const affected = terrains.filter((terrain) => terrain.intersectsPaintBrush(worldPosition, safeRadius));
        if (affected.length === 0) return false;

        // The combined cell range across every affected tile's own padded footprint - a
        // cell right on a seam must be considered once, not once per bordering tile.
        let firstX = Number.POSITIVE_INFINITY;
        let lastX = Number.NEGATIVE_INFINITY;
        let firstZ = Number.POSITIVE_INFINITY;
        let lastZ = Number.NEGATIVE_INFINITY;
        for (const terrain of affected) {
            const bounds = terrain.getPaintBounds();
            firstX = Math.min(firstX, Math.max(Math.ceil(bounds.minX / cellSize), Math.floor((worldPosition.x - safeRadius) / cellSize)));
            lastX = Math.max(lastX, Math.min(Math.floor(bounds.maxX / cellSize), Math.ceil((worldPosition.x + safeRadius) / cellSize)));
            firstZ = Math.min(firstZ, Math.max(Math.ceil(bounds.minZ / cellSize), Math.floor((worldPosition.z - safeRadius) / cellSize)));
            lastZ = Math.max(lastZ, Math.min(Math.floor(bounds.maxZ / cellSize), Math.ceil((worldPosition.z + safeRadius) / cellSize)));
        }

        const updates = new Map<string, number>();
        for (let gridX = firstX; gridX <= lastX; gridX++) {
            for (let gridZ = firstZ; gridZ <= lastZ; gridZ++) {
                const dx = gridX * cellSize - worldPosition.x;
                const dz = gridZ * cellSize - worldPosition.z;
                const distance = Math.hypot(dx, dz);
                if (distance > safeRadius) continue;
                const t = THREE.MathUtils.clamp(distance / safeRadius, 0, 1);
                const falloff = 1 - t * t * (3 - 2 * t);

                let sum = 0;
                for (let ox = -1; ox <= 1; ox++) {
                    for (let oz = -1; oz <= 1; oz++) sum += Terrain.readPaintCell(terrains, gridX + ox, gridZ + oz);
                }
                const average = sum / 9;
                const current = Terrain.readPaintCell(terrains, gridX, gridZ);
                const next = THREE.MathUtils.clamp(
                    THREE.MathUtils.lerp(current, average, blendStrength * falloff),
                    -100,
                    100,
                );
                if (Math.abs(next - current) > 1e-6) updates.set(`${gridX},${gridZ}`, next);
            }
        }

        if (updates.size === 0) return false;
        const margin = Terrain.PAINT_EDGE_MARGIN * cellSize;
        for (const [key, height] of updates) {
            const [gridX, gridZ] = key.split(',').map(Number);
            const x = gridX * cellSize;
            const z = gridZ * cellSize;
            // A cell on a shared edge is stored by every bordering tile (that's what
            // lets readPaintCell fall back to a neighbour's copy at all) - writing the
            // same computed value into every tile that stores it keeps them numerically
            // identical, so which one a later read happens to ask first can't matter.
            // Writing to only the single "owner" left the other tile's stale prior copy
            // in place, which a query starting from that tile would still see.
            for (const terrain of affected) {
                if (!Terrain.isWithinBounds(terrain.getBounds(), x, z, margin)) continue;
                if (Math.abs(height) <= 1e-5) terrain.paintedHeights.delete(key);
                else terrain.paintedHeights.set(key, { gridX, gridZ, height });
            }
        }
        return true;
    }

    public clearPaintedHeight(): boolean {
        if (this.paintedHeights.size === 0) return false;
        this.paintedHeights.clear();
        this.update();
        return true;
    }

    // Mirrors the padded footprint paintHeight writes into: a brush reaching a
    // neighbour's margin cells has to paint that neighbour too, or the two tiles end up
    // holding different values for cells they both read.
    public intersectsPaintBrush(worldPosition: THREE.Vector3, radius: number): boolean {
        const bounds = this.getPaintBounds();
        const closestX = THREE.MathUtils.clamp(worldPosition.x, bounds.minX, bounds.maxX);
        const closestZ = THREE.MathUtils.clamp(worldPosition.z, bounds.minZ, bounds.maxZ);
        return Math.hypot(worldPosition.x - closestX, worldPosition.z - closestZ) <= radius;
    }

    // The painted offset is one field spanning every tile, so a point on a shared edge
    // resolves to the same height no matter which tile is asking. That is what keeps a
    // seam flat: the tiles no longer have to agree on an average, they read one value.
    public static getPaintedHeightOffsetAt(terrains: Terrain[], worldX: number, worldZ: number): number {
        const cellSize = Terrain.PAINT_CELL_SIZE;
        const gridX = worldX / cellSize;
        const gridZ = worldZ / cellSize;
        const x0 = Math.floor(gridX);
        const z0 = Math.floor(gridZ);
        const tx = gridX - x0;
        const tz = gridZ - z0;
        const read = (x: number, z: number): number => Terrain.readPaintCell(terrains, x, z);
        const bottom = THREE.MathUtils.lerp(read(x0, z0), read(x0 + 1, z0), tx);
        const top = THREE.MathUtils.lerp(read(x0, z0 + 1), read(x0 + 1, z0 + 1), tx);
        return THREE.MathUtils.lerp(bottom, top, tz);
    }

    private getPaintBounds(): TerrainRect {
        const bounds = this.getBounds();
        const margin = Terrain.PAINT_EDGE_MARGIN * Terrain.PAINT_CELL_SIZE;
        return {
            minX: bounds.minX - margin,
            maxX: bounds.maxX + margin,
            minZ: bounds.minZ - margin,
            maxZ: bounds.maxZ + margin,
        };
    }

    private static isWithinBounds(
        bounds: TerrainRect,
        x: number,
        z: number,
        margin: number,
    ): boolean {
        const slack = margin + Terrain.CELL_EPSILON;
        return x >= bounds.minX - slack && x <= bounds.maxX + slack
            && z >= bounds.minZ - slack && z <= bounds.maxZ + slack;
    }

    // Whichever tile holds the cell answers for it, so a tile that was never painted
    // (added after its neighbours, or cleared on its own) still follows the hill that
    // runs through its edge instead of tearing away from it. A cell on a shared edge is
    // held by both neighbours, and the tiles actually covering it win, so a stale margin
    // cell cannot outvote the tile the cell really sits on. Cells left outside a tile's
    // footprint by a move or a resize are ignored.
    private static readPaintCell(terrains: Terrain[], gridX: number, gridZ: number): number {
        const key = `${gridX},${gridZ}`;
        const x = gridX * Terrain.PAINT_CELL_SIZE;
        const z = gridZ * Terrain.PAINT_CELL_SIZE;
        const margin = Terrain.PAINT_EDGE_MARGIN * Terrain.PAINT_CELL_SIZE;
        let borrowed: number | null = null;
        for (const terrain of terrains) {
            const stored = terrain.paintedHeights.get(key);
            if (stored === undefined) continue;
            const bounds = terrain.getBounds();
            if (!Terrain.isWithinBounds(bounds, x, z, margin)) continue;
            if (Terrain.isWithinBounds(bounds, x, z, 0)) return stored.height;
            borrowed ??= stored.height;
        }
        return borrowed ?? 0;
    }

    // The resolved field over a group's footprint, following the same owner-first
    // precedence as readPaintCell so the mesher samples exactly what the field says.
    public static collectPaintSamples(terrains: Terrain[], footprint: TerrainRect[]): TerrainPaintHeightInput[] {
        const cellSize = Terrain.PAINT_CELL_SIZE;
        const margin = Terrain.PAINT_EDGE_MARGIN * cellSize;
        const owned = new Map<string, TerrainPaintHeightInput>();
        const borrowed = new Map<string, TerrainPaintHeightInput>();
        for (const terrain of terrains) {
            const bounds = terrain.getBounds();
            for (const sample of terrain.paintedHeights.values()) {
                const x = sample.gridX * cellSize;
                const z = sample.gridZ * cellSize;
                if (!footprint.some((rect) => Terrain.isWithinBounds(rect, x, z, margin))) continue;
                if (!Terrain.isWithinBounds(bounds, x, z, margin)) continue;
                const key = `${sample.gridX},${sample.gridZ}`;
                const target = Terrain.isWithinBounds(bounds, x, z, 0) ? owned : borrowed;
                if (!target.has(key)) target.set(key, { ...sample });
            }
        }
        for (const [key, sample] of borrowed) if (!owned.has(key)) owned.set(key, sample);
        return [...owned.values()];
    }

    // The lattice is world-aligned, so a moved tile has to carry its samples over to
    // the cells that now sit underneath it, snapped to the nearest cell.
    private shiftPaintedHeights(delta: THREE.Vector3): void {
        const cellSize = Terrain.PAINT_CELL_SIZE;
        const shiftX = Math.round(delta.x / cellSize);
        const shiftZ = Math.round(delta.z / cellSize);
        if (this.paintedHeights.size === 0 || (shiftX === 0 && shiftZ === 0)) return;
        const moved = [...this.paintedHeights.values()].map((sample) => ({
            gridX: sample.gridX + shiftX,
            gridZ: sample.gridZ + shiftZ,
            height: sample.height,
        }));
        this.paintedHeights.clear();
        for (const sample of moved) this.paintedHeights.set(`${sample.gridX},${sample.gridZ}`, sample);
    }

    public override getNodeBasis(_index: number): NodeBasis {
        return {
            forward: new THREE.Vector3(1, 0, 0),
            right: new THREE.Vector3(0, 0, 1),
            up: new THREE.Vector3(0, 1, 0),
        };
    }

    public override getUVGroups(): string[] {
        return ['terrain'];
    }

    public override getUVTransform(group: string): UVTransform {
        if (group === 'terrain') return { ...this.terrainUV };
        return super.getUVTransform(group);
    }

    public override setUVTransform(group: string, transform: UVTransform): void {
        if (group !== 'terrain') {
            super.setUVTransform(group, transform);
            return;
        }
        this.terrainUV = {
            offsetX: Number.isFinite(transform.offsetX) ? transform.offsetX : 0,
            offsetY: Number.isFinite(transform.offsetY) ? transform.offsetY : 0,
            scaleX: Number.isFinite(transform.scaleX) ? Math.max(0.1, transform.scaleX) : 1,
            scaleY: Number.isFinite(transform.scaleY) ? Math.max(0.1, transform.scaleY) : 1,
        };
        this.update();
    }

    public override getOccupiedArea(): OccupiedTriangle[] {
        const halfWidth = this.width / 2;
        const halfLength = this.length / 2;
        const bl = new THREE.Vector3(this.center.x - halfWidth, this.center.y, this.center.z - halfLength);
        const br = new THREE.Vector3(this.center.x + halfWidth, this.center.y, this.center.z - halfLength);
        const tr = new THREE.Vector3(this.center.x + halfWidth, this.center.y, this.center.z + halfLength);
        const tl = new THREE.Vector3(this.center.x - halfWidth, this.center.y, this.center.z + halfLength);
        return [
            { a: bl, b: br, c: tr },
            { a: bl.clone(), b: tr.clone(), c: tl },
        ];
    }

    public override serialize(id: number): ElementData {
        const { textures, textureRotations } = this.collectTextureMaps();
        return {
            type: 'terrain',
            id,
            nodes: [{ x: this.center.x, y: this.center.y, z: this.center.z }],
            textures,
            textureRotations,
            uvTransforms: { terrain: { ...this.terrainUV } },
            terrainWidth: this.width,
            terrainLength: this.length,
            terrainMeshDetail: this.meshDetail,
            terrainTriangleLimit: this.triangleLimit,
            terrainSmoothingEnabled: this.smoothingEnabled,
            terrainSmoothingRadius: this.smoothingRadius,
            terrainMaxSlope: this.maxSlopeDegrees,
            terrainHeightPaintSpace: 'world',
            terrainHeightPaint: [...this.paintedHeights.values()]
                .sort((a, b) => a.gridZ - b.gridZ || a.gridX - b.gridX)
                .map((sample) => ({ ...sample })),
        };
    }

    public static deserialize(data: ElementData): Terrain {
        const node = data.nodes[0] ?? { x: 0, y: 0, z: 0 };
        const terrain = new Terrain(
            new THREE.Vector3(node.x, node.y, node.z),
            data.terrainWidth ?? 20,
            data.terrainLength ?? 20,
        );
        const legacyDetail = data.terrainGridEnabled ? data.terrainGridSize : undefined;
        terrain.meshDetail = THREE.MathUtils.clamp(data.terrainMeshDetail ?? legacyDetail ?? 2, 0.5, 5);
        terrain.triangleLimit = Math.round(THREE.MathUtils.clamp(data.terrainTriangleLimit ?? 1500, 100, 5000));
        terrain.smoothingEnabled = data.terrainSmoothingEnabled ?? true;
        terrain.smoothingRadius = THREE.MathUtils.clamp(data.terrainSmoothingRadius ?? 4, 0.5, 20);
        terrain.maxSlopeDegrees = THREE.MathUtils.clamp(data.terrainMaxSlope ?? 35, 1, 89);
        // Scenes saved before the lattice became world-aligned stored cells relative to
        // the tile centre, so shift those onto the shared lattice while loading.
        const legacyPaint = (data.terrainHeightPaintSpace ?? 'local') !== 'world';
        const legacyShiftX = legacyPaint ? Math.round(node.x / Terrain.PAINT_CELL_SIZE) : 0;
        const legacyShiftZ = legacyPaint ? Math.round(node.z / Terrain.PAINT_CELL_SIZE) : 0;
        for (const sample of data.terrainHeightPaint ?? []) {
            if (!Number.isFinite(sample.gridX) || !Number.isFinite(sample.gridZ) || !Number.isFinite(sample.height)) continue;
            const gridX = Math.round(sample.gridX) + legacyShiftX;
            const gridZ = Math.round(sample.gridZ) + legacyShiftZ;
            const height = THREE.MathUtils.clamp(sample.height, -100, 100);
            if (Math.abs(height) > 1e-5) terrain.paintedHeights.set(`${gridX},${gridZ}`, { gridX, gridZ, height });
        }
        const uv = data.uvTransforms?.terrain;
        if (uv) terrain.terrainUV = { ...uv };
        return terrain;
    }

    public override getProperties(): PropertyDefinition {
        return {
            title: 'Terrain',
            icon: '&#9633;',
            sections: [
                {
                    label: 'Transform',
                    properties: [{
                        type: 'vector3',
                        label: 'Center',
                        get: () => this.center.clone(),
                        set: (value: THREE.Vector3) => {
                            this.center.copy(value);
                            this.update();
                        },
                    }],
                },
                {
                    label: 'Terrain',
                    properties: [
                        {
                            type: 'number',
                            label: 'Width',
                            get: () => this.width,
                            set: (value: number) => {
                                this.width = Math.max(0.1, value);
                                this.update();
                            },
                            min: 10,
                            max: 500,
                            step: 0.1,
                        },
                        {
                            type: 'number',
                            label: 'Length',
                            get: () => this.length,
                            set: (value: number) => {
                                this.length = Math.max(0.1, value);
                                this.update();
                            },
                            min: 10,
                            max: 500,
                            step: 0.1,
                        },
                        {
                            type: 'number',
                            label: 'UV Size',
                            get: () => this.terrainUV.scaleX,
                            set: (value: number) => {
                                const size = THREE.MathUtils.clamp(value, 0.1, 100);
                                this.terrainUV.scaleX = size;
                                this.terrainUV.scaleY = size;
                                this.update();
                            },
                            min: 0.1,
                            max: 100,
                            step: 0.1,
                        },
                        {
                            type: 'number',
                            label: 'Mesh Detail',
                            get: () => this.meshDetail,
                            set: (value: number) => {
                                this.meshDetail = THREE.MathUtils.clamp(value, 0.5, 5);
                                this.update();
                            },
                            min: 0.5,
                            max: 5,
                            step: 0.25,
                        },
                        {
                            type: 'number',
                            label: 'Triangle Limit',
                            get: () => this.triangleLimit,
                            set: (value: number) => {
                                this.triangleLimit = Math.round(THREE.MathUtils.clamp(value, 100, 5000));
                                this.update();
                            },
                            min: 100,
                            max: 5000,
                            step: 100,
                        },
                        {
                            type: 'boolean',
                            label: 'Terrain Smoothing',
                            get: () => this.smoothingEnabled,
                            set: (value: boolean) => {
                                this.smoothingEnabled = value;
                                this.update();
                                this.onPropertiesChanged?.();
                            },
                        },
                        ...(this.smoothingEnabled ? [
                            {
                                type: 'number' as const,
                                label: 'Smoothing Radius',
                                get: () => this.smoothingRadius,
                                set: (value: number) => {
                                    this.smoothingRadius = THREE.MathUtils.clamp(value, 0.5, 20);
                                    this.update();
                                },
                                min: 0.5,
                                max: 20,
                                step: 0.5,
                            },
                            {
                                type: 'number' as const,
                                label: 'Max Slope',
                                get: () => this.maxSlopeDegrees,
                                set: (value: number) => {
                                    this.maxSlopeDegrees = THREE.MathUtils.clamp(value, 1, 89);
                                    this.update();
                                },
                                min: 1,
                                max: 89,
                                step: 1,
                            },
                        ] : []),
                    ],
                },
            ],
        };
    }

    protected override getGeometry(): GeometryGroup[] {
        return this.buildGeometry(container.resolve(LODPreviewManager).level);
    }

    // Geometry at a specific Unity-export LOD level, without touching the live element
    // or the LOD Preview setting - used by the exporter to build every LOD level's mesh
    // for this tile.
    public getExportGeometry(lodIndex: number): GeometryGroup[] {
        return this.buildGeometry(lodIndex);
    }

    private buildGeometry(lodIndex: number): GeometryGroup[] {
        // The whole group of touching tiles is meshed as one surface and then cut along
        // the tile borders, so this tile only has to skin its own share of it.
        const area = container.resolve(TerrainGroupMesher).buildLODSurface(this, lodIndex);

        const width = Math.max(0.0001, this.width);
        const length = Math.max(0.0001, this.length);
        const uv = this.terrainUV;
        const uvFor = (point: THREE.Vector3): THREE.Vector2 => new THREE.Vector2(
            ((point.x - this.center.x) / width + 0.5) * uv.scaleX + uv.offsetX,
            ((point.z - this.center.z) / length + 0.5) * uv.scaleY + uv.offsetY,
        );
        const triangles = area.map((tri) => new Triangle(
            tri.a.clone(), tri.b.clone(), tri.c.clone(),
            uvFor(tri.a), uvFor(tri.b), uvFor(tri.c),
        ));
        return [{ name: 'terrain', triangles }];
    }

    // Every tile a river touches has to agree on one water surface, so it is derived
    // from the river's own footprint rather than from whichever tile is asking.
    public static getSharedRiverSurfaceHeight(river: RiverSpline, terrains: Terrain[]): number {
        const occupied = river.getOccupiedArea();
        if (occupied.length === 0 || terrains.length === 0) return terrains[0]?.center.y ?? 0;
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        for (const triangle of occupied) {
            minX = Math.min(minX, triangle.a.x, triangle.b.x, triangle.c.x);
            maxX = Math.max(maxX, triangle.a.x, triangle.b.x, triangle.c.x);
            minZ = Math.min(minZ, triangle.a.z, triangle.b.z, triangle.c.z);
            maxZ = Math.max(maxZ, triangle.a.z, triangle.b.z, triangle.c.z);
        }
        const centerX = (minX + maxX) / 2;
        const centerZ = (minZ + maxZ) / 2;
        const affected = terrains.filter((terrain) => {
            const bounds = terrain.getBounds();
            return maxX >= bounds.minX && minX <= bounds.maxX && maxZ >= bounds.minZ && minZ <= bounds.maxZ;
        });
        const authority = affected[0] ?? terrains[0];
        const bounds = authority.getBounds();
        const x = THREE.MathUtils.clamp(centerX, bounds.minX, bounds.maxX);
        const z = THREE.MathUtils.clamp(centerZ, bounds.minZ, bounds.maxZ);
        return authority.center.y + Terrain.getPaintedHeightOffsetAt(terrains, x, z);
    }

    public getBounds(): TerrainRect {
        return {
            minX: this.center.x - this.width / 2,
            maxX: this.center.x + this.width / 2,
            minZ: this.center.z - this.length / 2,
            maxZ: this.center.z + this.length / 2,
        };
    }
}
