import * as THREE from 'three';
import WorldElement, { type NodeBasis, type GeometryGroup, type ElementData, type OccupiedTriangle } from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Config from '../utils/Config';
import { sampleCubicBezier } from '../utils/Bezier';
import type { PropertyDefinition } from '../editor/Properties';

const WATER_COLOR = 0x2f6fa8;

// A river works like a Road: nodes, curve points, Divisions, connectable ends, adjustable
// Width. Like a Road it cuts a real hole in the terrain at its full width - but instead of
// leaving that hole for a separate deck mesh, the river's own surface fills it directly at
// the curve's height, so terrain and water always meet with a seamless, matching edge.
export default class RiverSpline extends WorldElement {
    public get nodeA(): WorldNode { return this.nodes[0]; }
    public get nodeB(): WorldNode { return this.nodes[1]; }

    public width: number = 4;

    private _divisions: number = 0;
    private curvePointA: WorldNode | null = null;
    private curvePointB: WorldNode | null = null;
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
        this.setNode(0, new WorldNode(positionA, Config.editor.riverNodeColor));
        this.setNode(1, new WorldNode(positionB, Config.editor.riverNodeColor));
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
        this.applyWaterMaterial();
    }

    private applyWaterMaterial(): void {
        const mats = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
        for (const mat of mats) {
            const material = mat as THREE.MeshStandardMaterial;
            material.color.setHex(WATER_COLOR);
            material.userData.baseColor = material.color.clone();
            material.transparent = true;
            material.opacity = 0.8;
            material.roughness = 0.15;
            material.metalness = 0.05;
            material.needsUpdate = true;
        }
    }

    private getBezierCurvePoints(): THREE.Vector3[] {
        return sampleCubicBezier(
            this.nodeA.mesh.position,
            this.curvePointA ? this.curvePointA.mesh.position : this.nodeA.mesh.position,
            this.curvePointB ? this.curvePointB.mesh.position : this.nodeB.mesh.position,
            this.nodeB.mesh.position,
            this._divisions,
        );
    }

    private getRightAtIndex(points: THREE.Vector3[], index: number): THREE.Vector3 {
        const up = new THREE.Vector3(0, 1, 0);
        if (index === 0) return this.getResolvedNodeBasis(0).right;
        if (index === points.length - 1) return this.getResolvedNodeBasis(1).right;
        const direction = new THREE.Vector3().subVectors(points[index + 1], points[index - 1]).normalize();
        return new THREE.Vector3().crossVectors(direction, up).normalize();
    }

    // Same full-width quad strip as the surface geometry, so getOccupiedArea() below cuts
    // the terrain exactly where the water surface will sit - no gap, no overlap.
    private buildSurfaceTriangles(): Triangle[] {
        const points = this.getBezierCurvePoints();
        if (points.length < 2) return [];

        const halfWidth = Math.max(0.05, this.width / 2);
        const triangles: Triangle[] = [];
        for (let i = 0; i < points.length - 1; i++) {
            const rightA = this.getRightAtIndex(points, i);
            const rightB = this.getRightAtIndex(points, i + 1);
            const aLeft = points[i].clone().addScaledVector(rightA, -halfWidth);
            const aRight = points[i].clone().addScaledVector(rightA, halfWidth);
            const bLeft = points[i + 1].clone().addScaledVector(rightB, -halfWidth);
            const bRight = points[i + 1].clone().addScaledVector(rightB, halfWidth);
            const uA = i / (points.length - 1);
            const uB = (i + 1) / (points.length - 1);
            triangles.push(new Triangle(
                aLeft, aRight, bRight,
                new THREE.Vector2(0, uA), new THREE.Vector2(1, uA), new THREE.Vector2(1, uB),
            ));
            triangles.push(new Triangle(
                aLeft, bRight, bLeft,
                new THREE.Vector2(0, uA), new THREE.Vector2(1, uB), new THREE.Vector2(0, uB),
            ));
        }
        return triangles;
    }

    protected override getGeometry(): GeometryGroup[] {
        return [{ name: 'water', triangles: this.buildSurfaceTriangles() }];
    }

    public override getOccupiedArea(): OccupiedTriangle[] {
        const projected: OccupiedTriangle[] = [];
        for (const tri of this.buildSurfaceTriangles()) {
            const area = Math.abs(
                (tri.b.x - tri.a.x) * (tri.c.z - tri.a.z)
                - (tri.b.z - tri.a.z) * (tri.c.x - tri.a.x),
            ) * 0.5;
            if (area < 1e-8) continue;
            projected.push({ a: tri.a.clone(), b: tri.b.clone(), c: tri.c.clone() });
        }
        return projected;
    }

    private updateCurveLines(): void {
        this.disposeCurveLines();

        if (!this.curvePointA || !this.curvePointB) return;

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

    private disposeCurveLines(): void {
        const lines = [this.handleLineA, this.handleLineB].filter((line): line is THREE.Line => line !== null);
        const materials = new Set<THREE.Material>();
        for (const line of lines) {
            this.mesh.remove(line);
            line.geometry.dispose();
            const lineMaterials = Array.isArray(line.material) ? line.material : [line.material];
            for (const material of lineMaterials) materials.add(material);
        }
        for (const material of materials) material.dispose();
        this.handleLineA = null;
        this.handleLineB = null;
    }

    public override dispose(): void {
        this.disposeCurveLines();
        super.dispose();
    }

    public override getWidth(): number { return this.width; }

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

    public override getProperties(): PropertyDefinition {
        const self = this;
        return {
            title: 'River Spline',
            icon: '&#8776;',
            sections: [{
                label: 'River',
                properties: [
                    {
                        type: 'number',
                        label: 'Width',
                        get: () => self.width,
                        set: (v: number) => { self.width = Math.max(0.1, v); self.update(); },
                        min: 0.1,
                        max: 100,
                        step: 0.1,
                    },
                    {
                        type: 'number',
                        label: 'Divisions',
                        get: () => self.divisions,
                        set: (v: number) => { self.divisions = Math.max(0, Math.round(v)); },
                        min: 0,
                        max: 32,
                        step: 1,
                    },
                ],
            }],
        };
    }

    public serialize(id: number): ElementData {
        const curveA = this.curvePointA?.mesh.position;
        const curveB = this.curvePointB?.mesh.position;
        return {
            type: 'river',
            id,
            nodes: [
                { x: this.nodeA.mesh.position.x, y: this.nodeA.mesh.position.y, z: this.nodeA.mesh.position.z },
                { x: this.nodeB.mesh.position.x, y: this.nodeB.mesh.position.y, z: this.nodeB.mesh.position.z },
            ],
            textures: {},
            textureRotations: {},
            width: this.width,
            divisions: this.divisions,
            curvePointA: curveA ? { x: curveA.x, y: curveA.y, z: curveA.z } : null,
            curvePointB: curveB ? { x: curveB.x, y: curveB.y, z: curveB.z } : null,
        };
    }

    public static deserialize(data: ElementData): RiverSpline {
        const a = data.nodes[0] ?? { x: 0, y: 0, z: 0 };
        const b = data.nodes[1] ?? { x: 1, y: 0, z: 0 };
        const river = new RiverSpline(
            new THREE.Vector3(a.x, a.y, a.z),
            new THREE.Vector3(b.x, b.y, b.z),
        );
        river.width = Math.max(0.1, data.width ?? 4);
        if (data.divisions && data.divisions > 0) {
            river.divisions = data.divisions;
            if (data.curvePointA) river.setCurvePointA(new THREE.Vector3(data.curvePointA.x, data.curvePointA.y, data.curvePointA.z));
            if (data.curvePointB) river.setCurvePointB(new THREE.Vector3(data.curvePointB.x, data.curvePointB.y, data.curvePointB.z));
        }
        return river;
    }
}
