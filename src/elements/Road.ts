import * as THREE from 'three';
import WorldElement, { type NodeBasis } from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Config from '../utils/Config';
import { sampleCubicBezier } from '../utils/Bezier';
import type { PropertyDefinition, SectionItem } from '../editor/Properties';

export default class Road extends WorldElement {
    public get nodeA(): WorldNode { return this.nodes[0]; }
    public get nodeB(): WorldNode { return this.nodes[1]; }

    public width: number = 3;
    public lanes: number = 2;

    public override getWidth(): number { return this.width; }
    private _divisions: number = 0;
    private curvePointA: WorldNode | null = null;
    private curvePointB: WorldNode | null = null;
    private curveLineA: THREE.Line | null = null;
    private curveLineB: THREE.Line | null = null;
    private laneLines: THREE.Line[] = [];

    public get divisions(): number { return this._divisions; }
    public set divisions(value: number) {
        this._divisions = Math.max(0, Math.round(value));
        if (this._divisions > 0) {
            // Auto-create curve points at 1/3 and 2/3 along the line if missing
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
            // Remove curve points when divisions is 0
            this.setCurvePointA(null);
            this.setCurvePointB(null);
        }
        this.updateCurveLines();
    }

    constructor(positionA: THREE.Vector3, positionB: THREE.Vector3) {
        super();
        this.setNode(0, new WorldNode(positionA, Config.editor.nodeColor));
        this.setNode(1, new WorldNode(positionB, Config.editor.nodeColor));
    }

    public setCurvePointA(point: THREE.Vector3 | null): void {
        if (point) {
            if (!this.curvePointA) {
                this.curvePointA = new WorldNode(point, Config.editor.curveNodeColor);
                this.mesh.add(this.curvePointA.mesh);
            } else {
                this.curvePointA.update(point);
            }
        } else if (this.curvePointA) {
            this.mesh.remove(this.curvePointA.mesh);
            this.curvePointA = null;
        }
        this.updateCurveLines();
    }

    public setCurvePointB(point: THREE.Vector3 | null): void {
        if (point) {
            if (!this.curvePointB) {
                this.curvePointB = new WorldNode(point, Config.editor.curveNodeColor);
                this.mesh.add(this.curvePointB.mesh);
            } else {
                this.curvePointB.update(point);
            }
        } else if (this.curvePointB) {
            this.mesh.remove(this.curvePointB.mesh);
            this.curvePointB = null;
        }
        this.updateCurveLines();
    }

    public override update(): void {
        this.updateCurveLines();
        super.update();
    }

    private updateCurveLines(): void {
        if (this.curveLineA) { this.mesh.remove(this.curveLineA); this.curveLineA = null; }
        if (this.curveLineB) { this.mesh.remove(this.curveLineB); this.curveLineB = null; }
        for (const line of this.laneLines) this.mesh.remove(line);
        this.laneLines = [];

        if (!this.curvePointA || !this.curvePointB) return;

        const handleMaterial = new THREE.LineBasicMaterial({ color: Config.editor.curveNodeColor });

        const geoA = new THREE.BufferGeometry().setFromPoints([
            this.nodeA.mesh.position.clone(),
            this.curvePointA.mesh.position.clone(),
        ]);
        this.curveLineA = new THREE.Line(geoA, handleMaterial);
        this.mesh.add(this.curveLineA);

        const geoB = new THREE.BufferGeometry().setFromPoints([
            this.nodeB.mesh.position.clone(),
            this.curvePointB.mesh.position.clone(),
        ]);
        this.curveLineB = new THREE.Line(geoB, handleMaterial);
        this.mesh.add(this.curveLineB);

        const points = this.getBezierCurvePoints();
        const up = new THREE.Vector3(0, 1, 0);
        const halfWidthStart = this.getResolvedHalfWidth(0);
        const halfWidthEnd = this.getResolvedHalfWidth(1);

        const getRightAtIndex = (index: number): THREE.Vector3 => {
            if (index === 0) return this.getResolvedNodeBasis(0).right;
            if (index === points.length - 1) return this.getResolvedNodeBasis(1).right;
            const next = points[index + 1];
            const prev = points[index - 1];
            const direction = new THREE.Vector3().subVectors(next, prev).normalize();
            return new THREE.Vector3().crossVectors(direction, up).normalize();
        };

        // Draw N+1 lane boundary lines (edges + interior dividers)
        for (let b = 0; b <= this.lanes; b++) {
            const frac = b / this.lanes; // 0..1
            const offsetPoints: THREE.Vector3[] = [];
            for (let i = 0; i < points.length; i++) {
                const t = i / (points.length - 1);
                const hw = halfWidthStart + (halfWidthEnd - halfWidthStart) * t;
                const offset = -hw + 2 * hw * frac;
                const right = getRightAtIndex(i);
                offsetPoints.push(points[i].clone().add(right.clone().multiplyScalar(offset)));
            }
            const isEdge = b === 0 || b === this.lanes;
            const mat = new THREE.LineBasicMaterial({ color: isEdge ? 0xffffff : 0x888888 });
            const geo = new THREE.BufferGeometry().setFromPoints(offsetPoints);
            const line = new THREE.Line(geo, mat);
            this.laneLines.push(line);
            this.mesh.add(line);
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

    public connectWith(thisNodeIndex: number, otherRoad: Road, otherNodeIndex: number = 0): void {
        this.connect(thisNodeIndex, otherRoad, otherNodeIndex);
        this.updateCurveLines();
        this.update();
        otherRoad.update();
    }

    public getProperties(): PropertyDefinition {
        const self = this;
        const makeNodeVec3 = (label: string, node: WorldNode) => ({
            type: 'vector3' as const,
            label,
            get: () => node.mesh.position.clone(),
            set: (v: THREE.Vector3) => { node.update(v); },
        });

        const makeNodeSection = (label: string, node: WorldNode, nodeIndex: number) => {
            const props: SectionItem[] = [makeNodeVec3('Position', node)];
            if (this.isConnected(nodeIndex)) {
                props.push({
                    type: 'button' as const,
                    label: 'Disconnect',
                    onClick: () => { self.disconnect(nodeIndex); self.onPropertiesChanged?.(); },
                });
            }
            return { label, properties: props };
        };

        const sections = [
            makeNodeSection('Node A', this.nodeA, 0),
            makeNodeSection('Node B', this.nodeB, 1),
            {
                label: 'Road',
                properties: [
                    {
                        type: 'number' as const,
                        label: 'Width',
                        get: () => self.width,
                        set: (v: number) => { self.width = v; self.update(); },
                        min: 0.1,
                        step: 0.1,
                    },
                    {
                        type: 'number' as const,
                        label: 'Lanes',
                        get: () => self.lanes,
                        set: (v: number) => { self.lanes = Math.max(1, Math.round(v)); self.update(); },
                        min: 1,
                        step: 1,
                    },
                    {
                        type: 'number' as const,
                        label: 'Divisions',
                        get: () => self.divisions,
                        set: (v: number) => { self.divisions = Math.max(0, Math.round(v)); self.update(); },
                        min: 0,
                        step: 1,
                    },
                ],
            },
        ];

        if (this.curvePointA) {
            sections.push({
                label: 'Curve Point A',
                properties: [makeNodeVec3('Position', this.curvePointA)],
            });
        }
        if (this.curvePointB) {
            sections.push({
                label: 'Curve Point B',
                properties: [makeNodeVec3('Position', this.curvePointB)],
            });
        }

        return { title: 'Road', icon: '&#9776;', sections };
    }

    protected getTriangles(): Triangle[] {
        const triangles: Triangle[] = [];
        for (let lane = 0; lane < this.lanes; lane++) {
            triangles.push(...this.getLaneTriangles(lane));
        }
        return triangles;
    }

    private getLaneTriangles(laneIndex: number): Triangle[] {
        const triangles: Triangle[] = [];
        const points = this.getBezierCurvePoints();
        const up = new THREE.Vector3(0, 1, 0);
        const halfWidthStart = this.getResolvedHalfWidth(0);
        const halfWidthEnd = this.getResolvedHalfWidth(1);

        const getRightAtIndex = (index: number): THREE.Vector3 => {
            if (index === 0) return this.getResolvedNodeBasis(0).right;
            if (index === points.length - 1) return this.getResolvedNodeBasis(1).right;
            const next = points[index + 1];
            const prev = points[index - 1];
            const direction = new THREE.Vector3().subVectors(next, prev).normalize();
            return new THREE.Vector3().crossVectors(direction, up).normalize();
        };

        // Lane goes from laneIndex/lanes to (laneIndex+1)/lanes across the width
        // Map from [-halfWidth, +halfWidth] so lane 0 is leftmost
        const laneLeftFrac = laneIndex / this.lanes;       // 0..1
        const laneRightFrac = (laneIndex + 1) / this.lanes; // 0..1

        for (let i = 0; i < points.length - 1; i++) {
            const curr = points[i];
            const next = points[i + 1];

            const tCurr = i / (points.length - 1);
            const tNext = (i + 1) / (points.length - 1);
            const hwCurr = halfWidthStart + (halfWidthEnd - halfWidthStart) * tCurr;
            const hwNext = halfWidthStart + (halfWidthEnd - halfWidthStart) * tNext;

            const rightCurr = getRightAtIndex(i);
            const rightNext = getRightAtIndex(i + 1);

            // Left/right offsets for this lane at current and next points
            const currLeft = rightCurr.clone().multiplyScalar(-hwCurr + 2 * hwCurr * laneLeftFrac);
            const currRight = rightCurr.clone().multiplyScalar(-hwCurr + 2 * hwCurr * laneRightFrac);
            const nextLeft = rightNext.clone().multiplyScalar(-hwNext + 2 * hwNext * laneLeftFrac);
            const nextRight = rightNext.clone().multiplyScalar(-hwNext + 2 * hwNext * laneRightFrac);

            const bl = curr.clone().add(currLeft);
            const br = curr.clone().add(currRight);
            const tl = next.clone().add(nextLeft);
            const tr = next.clone().add(nextRight);

            triangles.push(new Triangle(bl, br, tr));
            triangles.push(new Triangle(bl, tr, tl));
        }

        return triangles;
    }
}