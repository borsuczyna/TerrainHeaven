import * as THREE from 'three';
import { container } from 'tsyringe';
import WorldElement, { type NodeBasis, type GeometryGroup, type ElementData, type OccupiedTriangle } from './WorldElement';
import Triangle from './Vertex';
import type { PropertyDefinition } from '../editor/Properties';
import BooleanManager from '../editor/BooleanManager';
import SceneManager from '../editor/SceneManager';

export default class Terrain extends WorldElement {
    public center: THREE.Vector3;
    public width: number;
    public length: number;
    public gridEnabled: boolean = false;
    public gridSize: number = 1;

    constructor(center: THREE.Vector3, width: number = 20, length: number = 20) {
        super();
        this.center = center.clone();
        this.width = width;
        this.length = length;
    }

    public override update(): void {
        super.update();
        const mats = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
        for (const mat of mats) {
            const m = mat as THREE.MeshStandardMaterial;
            m.side = THREE.DoubleSide;
            m.needsUpdate = true;
        }
    }

    public override translate(delta: THREE.Vector3): void {
        this.center.add(delta);
        this.update();
    }

    public override getNodeBasis(_index: number): NodeBasis {
        return {
            forward: new THREE.Vector3(1, 0, 0),
            right: new THREE.Vector3(0, 0, 1),
            up: new THREE.Vector3(0, 1, 0),
        };
    }

    public override getOccupiedArea(): OccupiedTriangle[] {
        const hw = this.width / 2;
        const hh = this.length / 2;
        const bl = new THREE.Vector3(this.center.x - hw, this.center.y, this.center.z - hh);
        const br = new THREE.Vector3(this.center.x + hw, this.center.y, this.center.z - hh);
        const tr = new THREE.Vector3(this.center.x + hw, this.center.y, this.center.z + hh);
        const tl = new THREE.Vector3(this.center.x - hw, this.center.y, this.center.z + hh);

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
            terrainWidth: this.width,
            terrainLength: this.length,
            terrainGridEnabled: this.gridEnabled,
            terrainGridSize: this.gridSize,
        };
    }

    public static deserialize(ed: ElementData): Terrain {
        const n = ed.nodes[0] ?? { x: 0, y: 0, z: 0 };
        const terrain = new Terrain(
            new THREE.Vector3(n.x, n.y, n.z),
            ed.terrainWidth ?? 20,
            ed.terrainLength ?? 20,
        );
        terrain.gridEnabled = ed.terrainGridEnabled ?? false;
        terrain.gridSize = Math.max(0.01, ed.terrainGridSize ?? 1);
        return terrain;
    }

    public override getProperties(): PropertyDefinition {
        const self = this;
        return {
            title: 'Terrain',
            icon: '&#9633;',
            sections: [
                {
                    label: 'Transform',
                    properties: [
                        {
                            type: 'vector3',
                            label: 'Center',
                            get: () => self.center.clone(),
                            set: (v: THREE.Vector3) => {
                                self.center.copy(v);
                                self.update();
                            },
                        },
                    ],
                },
                {
                    label: 'Terrain',
                    properties: [
                        {
                            type: 'number',
                            label: 'Width',
                            get: () => self.width,
                            set: (v: number) => {
                                self.width = Math.max(0.1, v);
                                self.update();
                            },
                            min: 10,
                            max: 50,
                            step: 0.1,
                        },
                        {
                            type: 'number',
                            label: 'Length',
                            get: () => self.length,
                            set: (v: number) => {
                                self.length = Math.max(0.1, v);
                                self.update();
                            },
                            min: 10,
                            max: 50,
                            step: 0.1,
                        },
                        {
                            type: 'boolean',
                            label: 'Enable Grid',
                            get: () => self.gridEnabled,
                            set: (v: boolean) => {
                                self.gridEnabled = v;
                                self.update();
                                self.onPropertiesChanged?.();
                            },
                        },
                        ...(self.gridEnabled ? [{
                            type: 'number' as const,
                            label: 'Grid Size',
                            get: () => self.gridSize,
                            set: (v: number) => {
                                self.gridSize = Math.max(0.01, v);
                                self.update();
                            },
                            min: 0.5,
                            step: 0.1,
                        }] : []),
                    ],
                },
            ],
        };
    }

    protected override getGeometry(): GeometryGroup[] {
        const scene = container.resolve(SceneManager);
        const booleanManager = container.resolve(BooleanManager);
        const elements = scene.getElements();
        const area = !this.gridEnabled
            ? booleanManager.cutTerrainSurface(this, elements)
            : this.getGridOccupiedArea(booleanManager, booleanManager.getTerrainCutAreas(this, elements));

        const triangles: Triangle[] = [];
        const w = Math.max(0.0001, this.width);
        const l = Math.max(0.0001, this.length);
        for (const tri of area) {
            const a = tri.a.clone();
            const b = tri.b.clone();
            const c = tri.c.clone();

            const uvA = new THREE.Vector2((tri.a.x - this.center.x) / w + 0.5, (tri.a.z - this.center.z) / l + 0.5);
            const uvB = new THREE.Vector2((tri.b.x - this.center.x) / w + 0.5, (tri.b.z - this.center.z) / l + 0.5);
            const uvC = new THREE.Vector2((tri.c.x - this.center.x) / w + 0.5, (tri.c.z - this.center.z) / l + 0.5);
            triangles.push(new Triangle(a, b, c, uvA, uvB, uvC));
        }

        return [{ name: 'terrain', triangles }];
    }

    private getGridOccupiedArea(booleanManager: BooleanManager, cutAreas: OccupiedTriangle[]): OccupiedTriangle[] {
        const { regular, filler } = this.partitionGridOccupiedArea(cutAreas);
        const retriangulatedRegular = regular.length > 0
            ? booleanManager.cutOccupiedSurface(regular, [])
            : [];

        if (filler.length === 0) {
            return retriangulatedRegular;
        }

        return [...retriangulatedRegular, ...booleanManager.cutOccupiedSurface(filler, cutAreas)];
    }

    private partitionGridOccupiedArea(cutAreas: OccupiedTriangle[]): {
        regular: OccupiedTriangle[];
        filler: OccupiedTriangle[];
    } {
        const cellSize = Math.max(0.01, this.gridSize);
        const startX = this.center.x - this.width / 2;
        const startZ = this.center.z - this.length / 2;
        const endX = startX + this.width;
        const endZ = startZ + this.length;
        const padding = cellSize * 1;
        const regular: OccupiedTriangle[] = [];
        const filler: OccupiedTriangle[] = [];

        for (let x = startX; x < endX - 1e-8; x += cellSize) {
            const x1 = Math.min(x + cellSize, endX);
            for (let z = startZ; z < endZ - 1e-8; z += cellSize) {
                const z1 = Math.min(z + cellSize, endZ);
                const target = this.shouldCullGridCell(x, x1, z, z1, cutAreas, padding) ? filler : regular;

                const bl = new THREE.Vector3(x, this.center.y, z);
                const br = new THREE.Vector3(x1, this.center.y, z);
                const tr = new THREE.Vector3(x1, this.center.y, z1);
                const tl = new THREE.Vector3(x, this.center.y, z1);
                target.push({ a: bl, b: br, c: tr });
                target.push({ a: bl.clone(), b: tr.clone(), c: tl });
            }
        }

        return { regular, filler };
    }

    private shouldCullGridCell(
        minX: number,
        maxX: number,
        minZ: number,
        maxZ: number,
        cutAreas: OccupiedTriangle[],
        padding: number,
    ): boolean {
        for (const tri of cutAreas) {
            const triMinX = Math.min(tri.a.x, tri.b.x, tri.c.x);
            const triMaxX = Math.max(tri.a.x, tri.b.x, tri.c.x);
            const triMinZ = Math.min(tri.a.z, tri.b.z, tri.c.z);
            const triMaxZ = Math.max(tri.a.z, tri.b.z, tri.c.z);

            if (triMaxX < minX - padding || triMinX > maxX + padding) continue;
            if (triMaxZ < minZ - padding || triMinZ > maxZ + padding) continue;
            return true;
        }

        return false;
    }
}
