import * as THREE from 'three';
import WorldElement, { type NodeBasis, type GeometryGroup, type ElementData, type OccupiedTriangle } from './WorldElement';
import WorldNode from './WorldNode';
import Config from '../utils/Config';
import { sampleCubicBezier } from '../utils/Bezier';
import type { PropertyDefinition } from '../editor/Properties';
import type { TerrainCutPointInput } from '../terrain/TerrainMesher';
import { getDivisionsForLOD } from '../export/LODLevels';

export const DEFAULT_CUT_SPLINE_RADIUS = 4;

// Sculpts terrain height along a path instead of a single point - each sampled point along
// the curve forces the terrain to that point's height, blending outward over `distance`.
export default class TerrainCutSpline extends WorldElement {
    public get nodeA(): WorldNode { return this.nodes[0]; }
    public get nodeB(): WorldNode { return this.nodes[1]; }

    public distance: number = DEFAULT_CUT_SPLINE_RADIUS;

    private _divisions: number = 0;
    private curvePointA: WorldNode | null = null;
    private curvePointB: WorldNode | null = null;
    private curveLine: THREE.Line | null = null;
    private handleLineA: THREE.Line | null = null;
    private handleLineB: THREE.Line | null = null;

    public get divisions(): number { return this._divisions; }
    public set divisions(value: number) {
        this._divisions = Math.max(0, Math.round(value));
        if (this._divisions > 0) {
            if (!this.curvePointA) {
                const a = this.nodeA.mesh.position;
                const b = this.nodeB.mesh.position;
                this.setCurvePointA(a.clone().lerp(b.clone(), 1 / 3));
            }
            if (!this.curvePointB) {
                const a = this.nodeA.mesh.position;
                const b = this.nodeB.mesh.position;
                this.setCurvePointB(a.clone().lerp(b.clone(), 2 / 3));
            }
        } else {
            this.setCurvePointA(null);
            this.setCurvePointB(null);
        }
        this.update();
    }

    constructor(positionA: THREE.Vector3, positionB: THREE.Vector3) {
        super();
        this.setNode(0, new WorldNode(positionA, Config.editor.terrainCutNodeColor));
        this.setNode(1, new WorldNode(positionB, Config.editor.terrainCutNodeColor));
    }

    public setCurvePointA(point: THREE.Vector3 | null): void {
        if (point) {
            if (!this.curvePointA) {
                this.curvePointA = new WorldNode(point, Config.editor.curveNodeColor);
                this.curvePointA.parent = this;
                this.mesh.add(this.curvePointA.mesh);
            } else {
                this.curvePointA.parent = this;
                this.curvePointA.update(point);
            }
        } else if (this.curvePointA) {
            this.mesh.remove(this.curvePointA.mesh);
            this.curvePointA.dispose();
            this.curvePointA = null;
        }
        this.updateCurveLines();
    }

    public setCurvePointB(point: THREE.Vector3 | null): void {
        if (point) {
            if (!this.curvePointB) {
                this.curvePointB = new WorldNode(point, Config.editor.curveNodeColor);
                this.curvePointB.parent = this;
                this.mesh.add(this.curvePointB.mesh);
            } else {
                this.curvePointB.parent = this;
                this.curvePointB.update(point);
            }
        } else if (this.curvePointB) {
            this.mesh.remove(this.curvePointB.mesh);
            this.curvePointB.dispose();
            this.curvePointB = null;
        }
        this.updateCurveLines();
    }

    public override update(): void {
        this.updateCurveLines();
        super.update();
    }

    private getBezierCurvePoints(divisionsOverride?: number): THREE.Vector3[] {
        return sampleCubicBezier(
            this.nodeA.mesh.position,
            this.curvePointA ? this.curvePointA.mesh.position : this.nodeA.mesh.position,
            this.curvePointB ? this.curvePointB.mesh.position : this.nodeB.mesh.position,
            this.nodeB.mesh.position,
            divisionsOverride ?? this._divisions,
        );
    }

    // Points fed into the terrain mesher to sculpt the surface along this spline. A
    // non-zero lodIndex thins the row count for a coarser terrain LOD - matching how
    // much coarser the terrain mesh itself gets at that level keeps the mesher's point
    // budget and constraint density compatible, instead of forcing a full-resolution
    // string of cut points into a much smaller triangle budget.
    public getSampledCutPoints(lodIndex = 0): TerrainCutPointInput[] {
        const divisions = lodIndex > 0 ? getDivisionsForLOD(this._divisions, lodIndex) : undefined;
        return this.getBezierCurvePoints(divisions).map((point) => ({
            position: point.clone(),
            radius: Math.max(0.1, this.distance),
        }));
    }

    private updateCurveLines(): void {
        this.disposeCurveLines();

        const points = this.getBezierCurvePoints();
        const lineMaterial = new THREE.LineBasicMaterial({ color: Config.editor.terrainCutNodeColor });
        this.curveLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial);
        this.mesh.add(this.curveLine);

        if (this.curvePointA && this.curvePointB) {
            const handleMaterial = new THREE.LineBasicMaterial({ color: Config.editor.curveNodeColor });
            this.handleLineA = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
                this.nodeA.mesh.position.clone(),
                this.curvePointA.mesh.position.clone(),
            ]), handleMaterial);
            this.mesh.add(this.handleLineA);

            this.handleLineB = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
                this.nodeB.mesh.position.clone(),
                this.curvePointB.mesh.position.clone(),
            ]), handleMaterial);
            this.mesh.add(this.handleLineB);
        }
    }

    private disposeCurveLines(): void {
        const lines = [this.curveLine, this.handleLineA, this.handleLineB]
            .filter((line): line is THREE.Line => line !== null);
        const materials = new Set<THREE.Material>();
        for (const line of lines) {
            this.mesh.remove(line);
            line.geometry.dispose();
            const lineMaterials = Array.isArray(line.material) ? line.material : [line.material];
            for (const material of lineMaterials) materials.add(material);
        }
        for (const material of materials) material.dispose();
        this.curveLine = null;
        this.handleLineA = null;
        this.handleLineB = null;
    }

    public override dispose(): void {
        this.disposeCurveLines();
        super.dispose();
    }

    public getNodeBasis(index: number): NodeBasis {
        const points = this.getBezierCurvePoints();
        const up = new THREE.Vector3(0, 1, 0);
        let forward: THREE.Vector3;
        if (index === 0) {
            forward = new THREE.Vector3().subVectors(points[1], points[0]).normalize();
        } else {
            const last = points.length - 1;
            forward = new THREE.Vector3().subVectors(points[last], points[last - 1]).normalize();
        }
        const right = new THREE.Vector3().crossVectors(forward, up).normalize();
        return { forward, right, up };
    }

    public override getOccupiedArea(): OccupiedTriangle[] { return []; }

    protected override getGeometry(): GeometryGroup[] { return []; }

    public override getProperties(): PropertyDefinition {
        const self = this;
        return {
            title: 'Terrain Cut Spline',
            icon: '&#8767;',
            sections: [{
                label: 'Terrain Cut Spline',
                properties: [
                    {
                        type: 'number',
                        label: 'Divisions',
                        get: () => self.divisions,
                        set: (v: number) => { self.divisions = Math.max(0, Math.round(v)); },
                        min: 0,
                        max: 32,
                        step: 1,
                    },
                    {
                        type: 'number',
                        label: 'Distance',
                        get: () => self.distance,
                        set: (v: number) => { self.distance = Math.max(0.1, v); self.update(); },
                        min: 0.1,
                        max: 100,
                        step: 0.1,
                    },
                ],
            }],
        };
    }

    public serialize(id: number): ElementData {
        const curveA = this.curvePointA?.mesh.position;
        const curveB = this.curvePointB?.mesh.position;
        return {
            type: 'terrainCutSpline',
            id,
            nodes: [
                { x: this.nodeA.mesh.position.x, y: this.nodeA.mesh.position.y, z: this.nodeA.mesh.position.z },
                { x: this.nodeB.mesh.position.x, y: this.nodeB.mesh.position.y, z: this.nodeB.mesh.position.z },
            ],
            textures: {},
            textureRotations: {},
            divisions: this.divisions,
            curvePointA: curveA ? { x: curveA.x, y: curveA.y, z: curveA.z } : null,
            curvePointB: curveB ? { x: curveB.x, y: curveB.y, z: curveB.z } : null,
            terrainCutDistance: this.distance,
        };
    }

    public static deserialize(data: ElementData): TerrainCutSpline {
        const a = data.nodes[0] ?? { x: 0, y: 0, z: 0 };
        const b = data.nodes[1] ?? { x: 1, y: 0, z: 0 };
        const spline = new TerrainCutSpline(
            new THREE.Vector3(a.x, a.y, a.z),
            new THREE.Vector3(b.x, b.y, b.z),
        );
        spline.distance = Math.max(0.1, data.terrainCutDistance ?? DEFAULT_CUT_SPLINE_RADIUS);
        if (data.divisions && data.divisions > 0) {
            spline.divisions = data.divisions;
            if (data.curvePointA) spline.setCurvePointA(new THREE.Vector3(data.curvePointA.x, data.curvePointA.y, data.curvePointA.z));
            if (data.curvePointB) spline.setCurvePointB(new THREE.Vector3(data.curvePointB.x, data.curvePointB.y, data.curvePointB.z));
        }
        return spline;
    }
}
