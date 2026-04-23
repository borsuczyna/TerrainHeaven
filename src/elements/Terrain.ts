import * as THREE from 'three';
import { container } from 'tsyringe';
import WorldElement, { type NodeBasis, type GeometryGroup, type ElementData, type OccupiedTriangle, type UVTransform } from './WorldElement';
import Triangle from './Vertex';
import type { PropertyDefinition } from '../editor/Properties';
import BooleanManager from '../editor/BooleanManager';
import SceneManager from '../editor/SceneManager';
import TerrainCutPointManager from '../editor/TerrainCutPointManager';

export default class Terrain extends WorldElement {
    public center: THREE.Vector3;
    public width: number;
    public length: number;
    public gridEnabled: boolean = false;
    public gridSize: number = 1;
    private terrainUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

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

    public override getUVGroups(): string[] {
        return ['terrain'];
    }

    public override getUVTransform(group: string): UVTransform {
        if (group === 'terrain') {
            return {
                offsetX: this.terrainUV.offsetX,
                offsetY: this.terrainUV.offsetY,
                scaleX: this.terrainUV.scaleX,
                scaleY: this.terrainUV.scaleY,
            };
        }
        return super.getUVTransform(group);
    }

    public override setUVTransform(group: string, t: UVTransform): void {
        if (group === 'terrain') {
            this.terrainUV = {
                offsetX: Number.isFinite(t.offsetX) ? t.offsetX : 0,
                offsetY: Number.isFinite(t.offsetY) ? t.offsetY : 0,
                scaleX: Number.isFinite(t.scaleX) ? Math.max(0.1, t.scaleX) : 1,
                scaleY: Number.isFinite(t.scaleY) ? Math.max(0.1, t.scaleY) : 1,
            };
            this.update();
            return;
        }
        super.setUVTransform(group, t);
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
            uvTransforms: {
                terrain: {
                    offsetX: this.terrainUV.offsetX,
                    offsetY: this.terrainUV.offsetY,
                    scaleX: this.terrainUV.scaleX,
                    scaleY: this.terrainUV.scaleY,
                },
            },
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
        const terrainUV = ed.uvTransforms?.terrain;
        if (terrainUV) {
            terrain.setUVTransform('terrain', terrainUV);
        }
        return terrain;
    }

    public override getProperties(): PropertyDefinition {
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
                            get: () => this.center.clone(),
                            set: (v: THREE.Vector3) => {
                                this.center.copy(v);
                                this.update();
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
                            get: () => this.width,
                            set: (v: number) => {
                                this.width = Math.max(0.1, v);
                                this.update();
                            },
                            min: 10,
                            max: 50,
                            step: 0.1,
                        },
                        {
                            type: 'number',
                            label: 'Length',
                            get: () => this.length,
                            set: (v: number) => {
                                this.length = Math.max(0.1, v);
                                this.update();
                            },
                            min: 10,
                            max: 50,
                            step: 0.1,
                        },
                        {
                            type: 'boolean',
                            label: 'Enable Grid',
                            get: () => this.gridEnabled,
                            set: (v: boolean) => {
                                this.gridEnabled = v;
                                this.update();
                                this.onPropertiesChanged?.();
                            },
                        },
                        ...(this.gridEnabled ? [{
                            type: 'number' as const,
                            label: 'Grid Size',
                            get: () => this.gridSize,
                            set: (v: number) => {
                                this.gridSize = Math.max(0.01, v);
                                this.update();
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
        const refinedArea = this.applyCutPoints(area);

        const triangles: Triangle[] = [];
        const w = Math.max(0.0001, this.width);
        const l = Math.max(0.0001, this.length);
        const uv = this.terrainUV;
        for (const tri of refinedArea) {
            const a = tri.a.clone();
            const b = tri.b.clone();
            const c = tri.c.clone();

            const baseUA = (tri.a.x - this.center.x) / w + 0.5;
            const baseVA = (tri.a.z - this.center.z) / l + 0.5;
            const baseUB = (tri.b.x - this.center.x) / w + 0.5;
            const baseVB = (tri.b.z - this.center.z) / l + 0.5;
            const baseUC = (tri.c.x - this.center.x) / w + 0.5;
            const baseVC = (tri.c.z - this.center.z) / l + 0.5;

            const uvA = new THREE.Vector2(baseUA * uv.scaleX + uv.offsetX, baseVA * uv.scaleY + uv.offsetY);
            const uvB = new THREE.Vector2(baseUB * uv.scaleX + uv.offsetX, baseVB * uv.scaleY + uv.offsetY);
            const uvC = new THREE.Vector2(baseUC * uv.scaleX + uv.offsetX, baseVC * uv.scaleY + uv.offsetY);
            triangles.push(new Triangle(a, b, c, uvA, uvB, uvC));
        }

        return [{ name: 'terrain', triangles }];
    }

    private applyCutPoints(area: OccupiedTriangle[]): OccupiedTriangle[] {
        const cutPoints = container.resolve(TerrainCutPointManager).getPoints();
        if (cutPoints.length === 0 || area.length === 0) {
            return area;
        }

        const refined = area.map((tri) => ({
            a: tri.a.clone(),
            b: tri.b.clone(),
            c: tri.c.clone(),
        }));

        for (const node of cutPoints) {
            const point = node.mesh.position.clone();
            const insertion = this.findCutPointInsertion(refined, point);
            if (!insertion) continue;

            const tri = refined[insertion.index];
            refined.splice(insertion.index, 1, ...this.splitTriangleWithPoint(tri, insertion.point));
        }

        return refined;
    }

    private findCutPointInsertion(
        triangles: OccupiedTriangle[],
        point: THREE.Vector3,
    ): { index: number; point: THREE.Vector3 } | null {
        for (let index = 0; index < triangles.length; index++) {
            if (this.canInsertCutPoint(point, triangles[index])) {
                return { index, point };
            }
        }

        for (let index = 0; index < triangles.length; index++) {
            const adjusted = this.getAdjustedEdgeInsertionPoint(point, triangles[index]);
            if (adjusted) {
                return { index, point: adjusted };
            }
        }

        return null;
    }

    private canInsertCutPoint(point: THREE.Vector3, tri: OccupiedTriangle): boolean {
        const barycentric = this.getBarycentricXZ(point, tri);
        if (!barycentric) return false;
        const edgeEpsilon = 1e-4;
        return barycentric.u > edgeEpsilon && barycentric.v > edgeEpsilon && barycentric.w > edgeEpsilon;
    }

    private getAdjustedEdgeInsertionPoint(point: THREE.Vector3, tri: OccupiedTriangle): THREE.Vector3 | null {
        const barycentric = this.getBarycentricXZ(point, tri);
        if (!barycentric) return null;

        const epsilon = 1e-4;
        if (barycentric.u > epsilon && barycentric.v > epsilon && barycentric.w > epsilon) {
            return point;
        }

        const centroid = tri.a.clone().add(tri.b).add(tri.c).multiplyScalar(1 / 3);
        const adjusted = point.clone();
        adjusted.x += (centroid.x - adjusted.x) * 1e-3;
        adjusted.z += (centroid.z - adjusted.z) * 1e-3;

        return this.canInsertCutPoint(adjusted, tri) ? adjusted : null;
    }

    private splitTriangleWithPoint(tri: OccupiedTriangle, point: THREE.Vector3): OccupiedTriangle[] {
        const sourceSign = Math.sign(this.getSignedAreaXZ(tri.a, tri.b, tri.c)) || 1;
        return [
            this.orientTriangle({ a: tri.a.clone(), b: tri.b.clone(), c: point.clone() }, sourceSign),
            this.orientTriangle({ a: tri.b.clone(), b: tri.c.clone(), c: point.clone() }, sourceSign),
            this.orientTriangle({ a: tri.c.clone(), b: tri.a.clone(), c: point.clone() }, sourceSign),
        ];
    }

    private orientTriangle(tri: OccupiedTriangle, expectedSign: number): OccupiedTriangle {
        const sign = Math.sign(this.getSignedAreaXZ(tri.a, tri.b, tri.c)) || expectedSign;
        if (sign === expectedSign) return tri;
        return { a: tri.a, b: tri.c, c: tri.b };
    }

    private getSignedAreaXZ(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
        return ((b.x - a.x) * (c.z - a.z)) - ((b.z - a.z) * (c.x - a.x));
    }

    private getBarycentricXZ(point: THREE.Vector3, tri: OccupiedTriangle): { u: number; v: number; w: number } | null {
        const ax = tri.a.x;
        const az = tri.a.z;
        const bx = tri.b.x;
        const bz = tri.b.z;
        const cx = tri.c.x;
        const cz = tri.c.z;
        const denominator = ((bz - cz) * (ax - cx)) + ((cx - bx) * (az - cz));
        if (Math.abs(denominator) < 1e-8) return null;

        const u = (((bz - cz) * (point.x - cx)) + ((cx - bx) * (point.z - cz))) / denominator;
        const v = (((cz - az) * (point.x - cx)) + ((ax - cx) * (point.z - cz))) / denominator;
        const w = 1 - u - v;
        const epsilon = 1e-5;
        if (u < -epsilon || v < -epsilon || w < -epsilon) return null;
        if (u > 1 + epsilon || v > 1 + epsilon || w > 1 + epsilon) return null;

        return { u, v, w };
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
