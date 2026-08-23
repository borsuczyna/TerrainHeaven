import * as THREE from 'three';
import WorldElement, {
    type ElementData,
    type GeometryGroup,
    type NodeBasis,
    type OccupiedTriangle,
    type UVTransform,
} from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Config from '../utils/Config';
import type { PropertyDefinition, SectionItem } from '../editor/Properties';

// A terrain patch shaped by an arbitrary closed polygon instead of a rectangle. Every
// vertex's own Y always drives the surface directly - dragging one vertex (a single node
// selection) shapes just that corner, dragging the whole shape (every node moving by the
// same delta) carries the whole surface with it, and nothing has to guess which of those
// two a given drag was. It also, like every other cutter element, carves a hole out of any
// rectangular Terrain tile it overlaps via the default getOccupiedArea()/
// cutsTerrainSurface() pipeline - no extra plumbing required.
export default class PolygonTerrain extends WorldElement {
    private terrainUV: UVTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

    constructor(points: THREE.Vector3[]) {
        super();
        this.mesh.castShadow = true;
        points.forEach((point, index) => this.setNode(index, new WorldNode(point.clone(), Config.editor.nodeColor)));
    }

    public get pointCount(): number {
        return this.nodes.length;
    }

    public getPoint(index: number): THREE.Vector3 {
        return this.nodes[index].mesh.position;
    }

    public addPoint(point: THREE.Vector3): void {
        this.setNode(this.nodes.length, new WorldNode(point.clone(), Config.editor.nodeColor));
        this.update();
    }

    public removeLastPoint(): boolean {
        const index = this.nodes.length - 1;
        if (index < 0) return false;
        const node = this.nodes[index];
        this.nodes.length = index;
        this.mesh.remove(node.mesh);
        node.dispose();
        this.update();
        return true;
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

    // One-shot action rather than a persistent mode: levels every vertex to their current
    // average height. Nothing keeps enforcing flatness afterward, so a later single-vertex
    // drag just shapes that one corner again, same as any other vertex edit.
    public flattenToAverageHeight(): void {
        if (this.nodes.length === 0) return;
        const average = this.nodes.reduce((sum, node) => sum + node.mesh.position.y, 0) / this.nodes.length;
        for (const node of this.nodes) node.mesh.position.y = average;
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
        return this.buildGeometry()[0].triangles.map((tri) => ({ a: tri.a.clone(), b: tri.b.clone(), c: tri.c.clone() }));
    }

    protected override getGeometry(): GeometryGroup[] {
        return this.buildGeometry();
    }

    // No LOD variance - a hand-placed polygon patch is already low enough triangle count
    // that collapsing it further isn't worth the complexity.
    public getExportGeometry(_lodIndex: number): GeometryGroup[] {
        return this.buildGeometry();
    }

    private buildGeometry(): GeometryGroup[] {
        const positions = this.nodes.map((node) => node.mesh.position);
        if (positions.length < 3) return [{ name: 'terrain', triangles: [] }];

        const points2D = positions.map((point) => new THREE.Vector2(point.x, point.z));
        const indices = THREE.ShapeUtils.triangulateShape(points2D, []);
        if (indices.length === 0) return [{ name: 'terrain', triangles: [] }];

        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        for (const point of positions) {
            minX = Math.min(minX, point.x);
            maxX = Math.max(maxX, point.x);
            minZ = Math.min(minZ, point.z);
            maxZ = Math.max(maxZ, point.z);
        }
        const width = Math.max(0.0001, maxX - minX);
        const length = Math.max(0.0001, maxZ - minZ);
        const uv = this.terrainUV;
        const uvFor = (point: THREE.Vector3): THREE.Vector2 => new THREE.Vector2(
            ((point.x - minX) / width) * uv.scaleX + uv.offsetX,
            ((point.z - minZ) / length) * uv.scaleY + uv.offsetY,
        );

        const vertexAt = (index: number): THREE.Vector3 => positions[index].clone();

        const triangles: Triangle[] = [];
        for (const [ia, ib, ic] of indices) {
            const a = vertexAt(ia);
            const b = vertexAt(ib);
            const c = vertexAt(ic);
            // Matches the winding-fix TerrainMesher applies to its own (x,z) triangles, so a
            // polygon terrain patch faces the same way as every rectangular tile around it.
            if (this.signedArea2D(points2D[ia], points2D[ib], points2D[ic]) > 0) {
                triangles.push(new Triangle(a, c, b, uvFor(a), uvFor(c), uvFor(b)));
            } else {
                triangles.push(new Triangle(a, b, c, uvFor(a), uvFor(b), uvFor(c)));
            }
        }
        return [{ name: 'terrain', triangles }];
    }

    private signedArea2D(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2): number {
        return ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }

    public override serialize(id: number): ElementData {
        const { textures, textureRotations } = this.collectTextureMaps();
        return {
            type: 'terrainPolygon',
            id,
            nodes: this.nodes.map((node) => ({ x: node.mesh.position.x, y: node.mesh.position.y, z: node.mesh.position.z })),
            textures,
            textureRotations,
            uvTransforms: { terrain: { ...this.terrainUV } },
        };
    }

    public static deserialize(data: ElementData): PolygonTerrain {
        const points = (data.nodes.length >= 3 ? data.nodes : [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }])
            .map((node) => new THREE.Vector3(node.x, node.y, node.z));
        const polygon = new PolygonTerrain(points);
        const uv = data.uvTransforms?.terrain;
        if (uv) polygon.terrainUV = { ...uv };
        return polygon;
    }

    public override getProperties(): PropertyDefinition {
        const self = this;
        const pointProperties: SectionItem[] = this.nodes.map((node, index) => ({
            type: 'vector3' as const,
            label: `Point ${index + 1}`,
            get: () => node.mesh.position.clone(),
            set: (value: THREE.Vector3) => { node.update(value); self.update(); },
        }));

        return {
            title: 'Polygon Terrain',
            icon: '&#9733;',
            sections: [
                { label: 'Points', properties: pointProperties },
                {
                    label: 'Terrain',
                    properties: [
                        {
                            type: 'button',
                            label: 'Flatten Terrain',
                            onClick: () => self.flattenToAverageHeight(),
                        },
                        {
                            type: 'number',
                            label: 'UV Size',
                            get: () => self.terrainUV.scaleX,
                            set: (value: number) => {
                                const size = THREE.MathUtils.clamp(value, 0.1, 100);
                                self.terrainUV.scaleX = size;
                                self.terrainUV.scaleY = size;
                                self.update();
                            },
                            min: 0.1,
                            max: 100,
                            step: 0.1,
                        },
                    ],
                },
            ],
        };
    }
}
