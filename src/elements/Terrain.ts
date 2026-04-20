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
    public height: number;

    constructor(center: THREE.Vector3, width: number = 20, height: number = 20) {
        super();
        this.center = center.clone();
        this.width = width;
        this.height = height;
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
        const hh = this.height / 2;
        const bl = new THREE.Vector2(this.center.x - hw, this.center.z - hh);
        const br = new THREE.Vector2(this.center.x + hw, this.center.z - hh);
        const tr = new THREE.Vector2(this.center.x + hw, this.center.z + hh);
        const tl = new THREE.Vector2(this.center.x - hw, this.center.z + hh);

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
            terrainHeight: this.height,
        };
    }

    public static deserialize(ed: ElementData): Terrain {
        const n = ed.nodes[0] ?? { x: 0, y: 0, z: 0 };
        return new Terrain(
            new THREE.Vector3(n.x, n.y, n.z),
            ed.terrainWidth ?? 20,
            ed.terrainHeight ?? 20,
        );
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
                            min: 0.1,
                            step: 0.1,
                        },
                        {
                            type: 'number',
                            label: 'Height',
                            get: () => self.height,
                            set: (v: number) => {
                                self.height = Math.max(0.1, v);
                                self.update();
                            },
                            min: 0.1,
                            step: 0.1,
                        },
                    ],
                },
            ],
        };
    }

    protected override getGeometry(): GeometryGroup[] {
        const scene = container.resolve(SceneManager);
        const booleanManager = container.resolve(BooleanManager);
        const area = booleanManager.cutTerrainSurface(this, scene.getElements());

        const triangles: Triangle[] = [];
        const w = Math.max(0.0001, this.width);
        const h = Math.max(0.0001, this.height);
        for (const tri of area) {
            const a = new THREE.Vector3(tri.a.x, this.center.y, tri.a.y);
            const b = new THREE.Vector3(tri.b.x, this.center.y, tri.b.y);
            const c = new THREE.Vector3(tri.c.x, this.center.y, tri.c.y);

            const uvA = new THREE.Vector2((tri.a.x - this.center.x) / w + 0.5, (tri.a.y - this.center.z) / h + 0.5);
            const uvB = new THREE.Vector2((tri.b.x - this.center.x) / w + 0.5, (tri.b.y - this.center.z) / h + 0.5);
            const uvC = new THREE.Vector2((tri.c.x - this.center.x) / w + 0.5, (tri.c.y - this.center.z) / h + 0.5);
            triangles.push(new Triangle(a, b, c, uvA, uvB, uvC));
        }

        return [{ name: 'terrain', triangles }];
    }
}
