import * as THREE from 'three';
import { container } from 'tsyringe';
import WorldElement, { type NodeBasis, type GeometryGroup, type ElementData, type OccupiedTriangle, type UVTransform } from './WorldElement';
import Triangle from './Vertex';
import type { PropertyDefinition } from '../editor/Properties';
import BooleanManager from '../editor/BooleanManager';
import SceneManager from '../editor/SceneManager';
import TerrainCutPointManager from '../editor/TerrainCutPointManager';
import TerrainMesher from '../terrain/TerrainMesher';

export default class Terrain extends WorldElement {
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
    private readonly terrainMesher = new TerrainMesher();

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
            const material = mat as THREE.MeshStandardMaterial;
            material.side = THREE.DoubleSide;
            material.needsUpdate = true;
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
                            max: 50,
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
                            max: 50,
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
        const scene = container.resolve(SceneManager);
        const booleanManager = container.resolve(BooleanManager);
        const cutPointManager = container.resolve(TerrainCutPointManager);
        const cutAreas = booleanManager.getTerrainCutAreas(this, scene.getElements());
        const area = this.terrainMesher.build({
            center: this.center,
            width: this.width,
            length: this.length,
            cutAreas,
            cutPoints: cutPointManager.getPoints().map((node) => node.mesh.position.clone()),
            settings: {
                meshDetail: this.meshDetail,
                triangleLimit: this.triangleLimit,
                smoothingEnabled: this.smoothingEnabled,
                smoothingRadius: this.smoothingRadius,
                maxSlopeDegrees: this.maxSlopeDegrees,
            },
        });

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
}
