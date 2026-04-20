import * as THREE from 'three';
import WorldElement, { type NodeBasis, type GeometryGroup, type ElementData, type OccupiedTriangle } from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Config from '../utils/Config';
import { sampleCubicBezier } from '../utils/Bezier';
import type { PropertyDefinition, SectionItem } from '../editor/Properties';

export type EdgeType = 'none' | 'sidewalk';

export default class Road extends WorldElement {
    public get nodeA(): WorldNode { return this.nodes[0]; }
    public get nodeB(): WorldNode { return this.nodes[1]; }

    public width: number = 3;
    public lanes: number = 2;
    public edgeType: EdgeType = 'none';
    public sidewalkWidth: number = 1;
    public curbHeight: number = 0.15;
    public roadTexStretch: number = 1;
    public sidewalkTexStretch: number = 1;
    public roadCrown: number = 0;

    public override getWidth(): number { return this.width; }
    public override getSidewalkWidth(): number { return this.edgeType === 'sidewalk' ? this.sidewalkWidth : 0; }
    public override getCurbHeight(): number { return this.edgeType === 'sidewalk' ? this.curbHeight : 0; }
    private _divisions: number = 0;
    private curvePointA: WorldNode | null = null;
    private curvePointB: WorldNode | null = null;

    public getCurvePointAPosition(): THREE.Vector3 | null {
        return this.curvePointA ? this.curvePointA.mesh.position.clone() : null;
    }

    public getCurvePointBPosition(): THREE.Vector3 | null {
        return this.curvePointB ? this.curvePointB.mesh.position.clone() : null;
    }
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

    private getEndCrown(nodeIndex: number): number {
        const conn = this.connections.get(nodeIndex);
        if (!conn) return this.roadCrown;
        if (!(conn.element instanceof Road)) return 0;
        // Average both crowns so each road produces the same junction height
        return (this.roadCrown + conn.element.roadCrown) / 2;
    }

    public connectWith(thisNodeIndex: number, otherRoad: Road, otherNodeIndex: number = 0): void {
        this.connect(thisNodeIndex, otherRoad, otherNodeIndex);
        this.updateCurveLines();
        this.update();
        otherRoad.update();
    }

    public override getOccupiedArea(): OccupiedTriangle[] {
        const edge = this.computeEdgeData();
        const triangles: OccupiedTriangle[] = [];
        const swStart = this.getResolvedSidewalkWidth(0);
        const swEnd = this.getResolvedSidewalkWidth(1);

        for (let i = 0; i < edge.points.length - 1; i++) {
            const tCurr = i / (edge.points.length - 1);
            const tNext = (i + 1) / (edge.points.length - 1);
            const swCurr = swStart + (swEnd - swStart) * tCurr;
            const swNext = swStart + (swEnd - swStart) * tNext;
            const extraCurr = this.edgeType === 'sidewalk' ? swCurr : 0;
            const extraNext = this.edgeType === 'sidewalk' ? swNext : 0;

            const hwCurr = edge.halfWidths[i] + extraCurr;
            const hwNext = edge.halfWidths[i + 1] + extraNext;

            const curr = edge.points[i];
            const next = edge.points[i + 1];
            const rightCurr = edge.rightVecs[i];
            const rightNext = edge.rightVecs[i + 1];

            const bl = curr.clone().sub(rightCurr.clone().multiplyScalar(hwCurr));
            const br = curr.clone().add(rightCurr.clone().multiplyScalar(hwCurr));
            const tl = next.clone().sub(rightNext.clone().multiplyScalar(hwNext));
            const tr = next.clone().add(rightNext.clone().multiplyScalar(hwNext));

            triangles.push({
                a: new THREE.Vector2(bl.x, bl.z),
                b: new THREE.Vector2(br.x, br.z),
                c: new THREE.Vector2(tr.x, tr.z),
            });
            triangles.push({
                a: new THREE.Vector2(bl.x, bl.z),
                b: new THREE.Vector2(tr.x, tr.z),
                c: new THREE.Vector2(tl.x, tl.z),
            });
        }

        return triangles;
    }

    public override serialize(id: number): ElementData {
        const { textures, textureRotations } = this.collectTextureMaps();
        const nodes = [
            { x: this.getNode(0).mesh.position.x, y: this.getNode(0).mesh.position.y, z: this.getNode(0).mesh.position.z },
            { x: this.getNode(1).mesh.position.x, y: this.getNode(1).mesh.position.y, z: this.getNode(1).mesh.position.z },
        ];
        let curvePointA: { x: number; y: number; z: number } | null = null;
        let curvePointB: { x: number; y: number; z: number } | null = null;
        if (this.divisions > 0) {
            const cpA = this.getCurvePointAPosition();
            const cpB = this.getCurvePointBPosition();
            if (cpA) curvePointA = { x: cpA.x, y: cpA.y, z: cpA.z };
            if (cpB) curvePointB = { x: cpB.x, y: cpB.y, z: cpB.z };
        }
        return {
            type: 'road', id, nodes, textures, textureRotations,
            width: this.width,
            lanes: this.lanes,
            divisions: this.divisions,
            edgeType: this.edgeType,
            sidewalkWidth: this.sidewalkWidth,
            curbHeight: this.curbHeight,
            roadCrown: this.roadCrown,
            curvePointA,
            curvePointB,
        };
    }

    public static deserialize(ed: ElementData): Road {
        const posA = new THREE.Vector3(ed.nodes[0].x, ed.nodes[0].y, ed.nodes[0].z);
        const posB = new THREE.Vector3(ed.nodes[1].x, ed.nodes[1].y, ed.nodes[1].z);
        const road = new Road(posA, posB);
        road.width = ed.width ?? 3;
        road.lanes = ed.lanes ?? 2;
        road.edgeType = (ed.edgeType as 'none' | 'sidewalk') ?? 'none';
        road.sidewalkWidth = ed.sidewalkWidth ?? 1;
        road.curbHeight = ed.curbHeight ?? 0.15;
        road.roadCrown = ed.roadCrown ?? 0;
        if (ed.divisions && ed.divisions > 0) {
            road.divisions = ed.divisions;
            if (ed.curvePointA) road.setCurvePointA(new THREE.Vector3(ed.curvePointA.x, ed.curvePointA.y, ed.curvePointA.z));
            if (ed.curvePointB) road.setCurvePointB(new THREE.Vector3(ed.curvePointB.x, ed.curvePointB.y, ed.curvePointB.z));
        }
        return road;
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
                    {
                        type: 'number' as const,
                        label: 'Crown',
                        get: () => self.roadCrown,
                        set: (v: number) => { self.roadCrown = v; self.update(); },
                        min: 0,
                        step: 0.01,
                    },
                ],
            },
            {
                label: 'Edges',
                properties: [
                    {
                        type: 'select' as const,
                        label: 'Type',
                        options: [
                            { label: 'None', value: 'none' },
                            { label: 'Sidewalk', value: 'sidewalk' },
                        ],
                        get: () => self.edgeType,
                        set: (v: string) => { self.edgeType = v as EdgeType; self.update(); self.onPropertiesChanged?.(); },
                    },
                    ...(self.edgeType === 'sidewalk' ? [
                        {
                            type: 'number' as const,
                            label: 'Sidewalk Width',
                            get: () => self.sidewalkWidth,
                            set: (v: number) => { self.sidewalkWidth = Math.max(0.1, v); self.update(); },
                            min: 0.1,
                            step: 0.1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Curb Height',
                            get: () => self.curbHeight,
                            set: (v: number) => { self.curbHeight = Math.max(0, v); self.update(); },
                            min: 0,
                            step: 0.05,
                        },
                    ] : []),
                ],
            },
            {
                label: 'Textures',
                properties: [
                    {
                        type: 'select' as const,
                        label: 'Road Rot.',
                        options: [
                            { label: '0°', value: '0' },
                            { label: '90°', value: '90' },
                            { label: '180°', value: '180' },
                            { label: '270°', value: '270' },
                        ],
                        get: () => String(self.textureRotations.get('road') ?? 0),
                        set: (v: string) => { self.setTextureRotation('road', Number(v)); },
                    },
                    {
                        type: 'number' as const,
                        label: 'Road Stretch',
                        get: () => self.roadTexStretch,
                        set: (v: number) => { self.roadTexStretch = Math.max(0.1, v); self.update(); },
                        min: 0.1,
                        step: 0.1,
                    },
                    {
                        type: 'select' as const,
                        label: 'Sidewalk Rot.',
                        options: [
                            { label: '0°', value: '0' },
                            { label: '90°', value: '90' },
                            { label: '180°', value: '180' },
                            { label: '270°', value: '270' },
                        ],
                        get: () => String(self.textureRotations.get('sidewalk') ?? 0),
                        set: (v: string) => { self.setTextureRotation('sidewalk', Number(v)); },
                    },
                    {
                        type: 'number' as const,
                        label: 'Sidewalk Stretch',
                        get: () => self.sidewalkTexStretch,
                        set: (v: number) => { self.sidewalkTexStretch = Math.max(0.1, v); self.update(); },
                        min: 0.1,
                        step: 0.1,
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

    protected getGeometry(): GeometryGroup[] {
        const edge = this.computeEdgeData();
        const roadTris: Triangle[] = [];
        for (let lane = 0; lane < this.lanes; lane++) {
            roadTris.push(...this.getLaneTriangles(lane, edge));
        }
        const groups: GeometryGroup[] = [{ name: 'road', triangles: roadTris }];
        if (this.edgeType === 'sidewalk') {
            const swTris: Triangle[] = [];
            swTris.push(...this.getSidewalkTriangles(-1, edge));
            swTris.push(...this.getSidewalkTriangles(1, edge));
            groups.push({ name: 'sidewalk', triangles: swTris });
        }
        return groups;
    }

    private computeEdgeData() {
        const points = this.getBezierCurvePoints();
        const up = new THREE.Vector3(0, 1, 0);
        const halfWidthStart = this.getResolvedHalfWidth(0);
        const halfWidthEnd = this.getResolvedHalfWidth(1);

        const rightVecs: THREE.Vector3[] = [];
        const halfWidths: number[] = [];

        for (let i = 0; i < points.length; i++) {
            const t = i / (points.length - 1);
            halfWidths.push(halfWidthStart + (halfWidthEnd - halfWidthStart) * t);

            if (i === 0) rightVecs.push(this.getResolvedNodeBasis(0).right);
            else if (i === points.length - 1) rightVecs.push(this.getResolvedNodeBasis(1).right);
            else {
                const next = points[i + 1];
                const prev = points[i - 1];
                const direction = new THREE.Vector3().subVectors(next, prev).normalize();
                rightVecs.push(new THREE.Vector3().crossVectors(direction, up).normalize());
            }
        }

        // Compute left/right edge positions
        const leftEdgePos: THREE.Vector3[] = [];
        const rightEdgePos: THREE.Vector3[] = [];
        for (let i = 0; i < points.length; i++) {
            leftEdgePos.push(points[i].clone().add(rightVecs[i].clone().multiplyScalar(-halfWidths[i])));
            rightEdgePos.push(points[i].clone().add(rightVecs[i].clone().multiplyScalar(halfWidths[i])));
        }

        // Cumulative distances along each edge
        const leftCumDist = [0];
        const rightCumDist = [0];
        for (let i = 1; i < points.length; i++) {
            leftCumDist.push(leftCumDist[i - 1] + leftEdgePos[i].distanceTo(leftEdgePos[i - 1]));
            rightCumDist.push(rightCumDist[i - 1] + rightEdgePos[i].distanceTo(rightEdgePos[i - 1]));
        }

        const leftTotal = leftCumDist[leftCumDist.length - 1];
        const rightTotal = rightCumDist[rightCumDist.length - 1];
        const maxEdgeLen = Math.min(leftTotal, rightTotal);

        // Normalize so both edges end at maxEdgeLen
        for (let i = 0; i < leftCumDist.length; i++) {
            leftCumDist[i] = leftTotal > 0 ? (leftCumDist[i] / leftTotal) * maxEdgeLen : 0;
        }
        for (let i = 0; i < rightCumDist.length; i++) {
            rightCumDist[i] = rightTotal > 0 ? (rightCumDist[i] / rightTotal) * maxEdgeLen : 0;
        }

        return { points, rightVecs, halfWidths, leftCumDist, rightCumDist, maxEdgeLen };
    }

    private getLaneTriangles(laneIndex: number, edge: ReturnType<Road['computeEdgeData']>): Triangle[] {
        const triangles: Triangle[] = [];
        const { points, rightVecs, halfWidths, leftCumDist, rightCumDist } = edge;

        const laneLeftFrac = laneIndex / this.lanes;
        const laneRightFrac = (laneIndex + 1) / this.lanes;
        const crownA = this.getEndCrown(0);
        const crownB = this.getEndCrown(1);
        const crownAtT = (t: number): number => t < 0.5
            ? crownA + (this.roadCrown - crownA) * t * 2
            : this.roadCrown + (crownB - this.roadCrown) * (t - 0.5) * 2;

        for (let i = 0; i < points.length - 1; i++) {
            const curr = points[i];
            const next = points[i + 1];
            const hwCurr = halfWidths[i];
            const hwNext = halfWidths[i + 1];
            const rightCurr = rightVecs[i];
            const rightNext = rightVecs[i + 1];

            const currLeft = rightCurr.clone().multiplyScalar(-hwCurr + 2 * hwCurr * laneLeftFrac);
            const currRight = rightCurr.clone().multiplyScalar(-hwCurr + 2 * hwCurr * laneRightFrac);
            const nextLeft = rightNext.clone().multiplyScalar(-hwNext + 2 * hwNext * laneLeftFrac);
            const nextRight = rightNext.clone().multiplyScalar(-hwNext + 2 * hwNext * laneRightFrac);

            const crown = (f: number, ti: number) => new THREE.Vector3(0, crownAtT(ti) * (1 - Math.abs(2 * f - 1)), 0);

            const tCurr = i / (points.length - 1);
            const tNext = (i + 1) / (points.length - 1);
            const bl = curr.clone().add(currLeft).add(crown(laneLeftFrac, tCurr));
            const br = curr.clone().add(currRight).add(crown(laneRightFrac, tCurr));
            const tl = next.clone().add(nextLeft).add(crown(laneLeftFrac, tNext));
            const tr = next.clone().add(nextRight).add(crown(laneRightFrac, tNext));

            // UV: U = 0..1 per lane (full texture width per lane), V along length (edge-length proportional)
            // Every second lane is inverted (180° rotated)
            const vBL = leftCumDist[i] + (rightCumDist[i] - leftCumDist[i]) * laneLeftFrac;
            const vBR = leftCumDist[i] + (rightCumDist[i] - leftCumDist[i]) * laneRightFrac;
            const vTL = leftCumDist[i + 1] + (rightCumDist[i + 1] - leftCumDist[i + 1]) * laneLeftFrac;
            const vTR = leftCumDist[i + 1] + (rightCumDist[i + 1] - leftCumDist[i + 1]) * laneRightFrac;

            const invert = laneIndex % 2 === 1;
            const maxV = edge.maxEdgeLen * 2;
            const uL = invert ? 1 : 0;
            const uR = invert ? 0 : 1;
            const fvBL = (invert ? maxV - vBL : vBL) * this.roadTexStretch;
            const fvBR = (invert ? maxV - vBR : vBR) * this.roadTexStretch;
            const fvTL = (invert ? maxV - vTL : vTL) * this.roadTexStretch;
            const fvTR = (invert ? maxV - vTR : vTR) * this.roadTexStretch;

            triangles.push(new Triangle(bl, br, tr,
                new THREE.Vector2(uL, fvBL),
                new THREE.Vector2(uR, fvBR),
                new THREE.Vector2(uR, fvTR),
            ));
            triangles.push(new Triangle(bl, tr, tl,
                new THREE.Vector2(uL, fvBL),
                new THREE.Vector2(uR, fvTR),
                new THREE.Vector2(uL, fvTL),
            ));
        }

        return triangles;
    }

    private getSidewalkTriangles(side: number, edge: ReturnType<Road['computeEdgeData']>): Triangle[] {
        const triangles: Triangle[] = [];
        const { points, rightVecs, halfWidths, leftCumDist, rightCumDist } = edge;
        const up = new THREE.Vector3(0, 1, 0);
        const swStart = this.getResolvedSidewalkWidth(0);
        const swEnd = this.getResolvedSidewalkWidth(1);
        const chStart = this.getResolvedCurbHeight(0);
        const chEnd = this.getResolvedCurbHeight(1);

        for (let i = 0; i < points.length - 1; i++) {
            const curr = points[i];
            const next = points[i + 1];
            const hwCurr = halfWidths[i];
            const hwNext = halfWidths[i + 1];
            const tCurr = i / (points.length - 1);
            const tNext = (i + 1) / (points.length - 1);
            const swCurr = swStart + (swEnd - swStart) * tCurr;
            const swNext = swStart + (swEnd - swStart) * tNext;
            const chCurr = chStart + (chEnd - chStart) * tCurr;
            const chNext = chStart + (chEnd - chStart) * tNext;

            const rightCurr = rightVecs[i];
            const rightNext = rightVecs[i + 1];

            const innerCurr = curr.clone().add(rightCurr.clone().multiplyScalar(side * hwCurr));
            const innerNext = next.clone().add(rightNext.clone().multiplyScalar(side * hwNext));
            const outerCurr = curr.clone().add(rightCurr.clone().multiplyScalar(side * (hwCurr + swCurr)));
            const outerNext = next.clone().add(rightNext.clone().multiplyScalar(side * (hwNext + swNext)));

            const upCurr = up.clone().multiplyScalar(chCurr);
            const upNext = up.clone().multiplyScalar(chNext);
            const innerCurrUp = innerCurr.clone().add(upCurr);
            const innerNextUp = innerNext.clone().add(upNext);
            const outerCurrUp = outerCurr.clone().add(upCurr);
            const outerNextUp = outerNext.clone().add(upNext);

            // V along length — use the edge cumDist on the side of the road
            const vCurr = (side > 0 ? rightCumDist[i] : leftCumDist[i]) * this.sidewalkTexStretch;
            const vNext = (side > 0 ? rightCumDist[i + 1] : leftCumDist[i + 1]) * this.sidewalkTexStretch;

            // Curb face (vertical wall): U = 0 at bottom, 1 at top
            if (side > 0) {
                triangles.push(new Triangle(innerCurr.clone(), innerCurrUp.clone(), innerNextUp.clone(),
                    new THREE.Vector2(0, vCurr), new THREE.Vector2(1, vCurr), new THREE.Vector2(1, vNext)));
                triangles.push(new Triangle(innerCurr.clone(), innerNextUp.clone(), innerNext.clone(),
                    new THREE.Vector2(0, vCurr), new THREE.Vector2(1, vNext), new THREE.Vector2(0, vNext)));
            } else {
                triangles.push(new Triangle(innerCurr.clone(), innerNextUp.clone(), innerCurrUp.clone(),
                    new THREE.Vector2(0, vCurr), new THREE.Vector2(1, vNext), new THREE.Vector2(1, vCurr)));
                triangles.push(new Triangle(innerCurr.clone(), innerNext.clone(), innerNextUp.clone(),
                    new THREE.Vector2(0, vCurr), new THREE.Vector2(0, vNext), new THREE.Vector2(1, vNext)));
            }

            // Sidewalk top (raised flat): U = 0 at inner, 1 at outer
            if (side > 0) {
                triangles.push(new Triangle(innerCurrUp.clone(), outerCurrUp.clone(), outerNextUp.clone(),
                    new THREE.Vector2(0, vCurr), new THREE.Vector2(1, vCurr), new THREE.Vector2(1, vNext)));
                triangles.push(new Triangle(innerCurrUp.clone(), outerNextUp.clone(), innerNextUp.clone(),
                    new THREE.Vector2(0, vCurr), new THREE.Vector2(1, vNext), new THREE.Vector2(0, vNext)));
            } else {
                triangles.push(new Triangle(innerCurrUp.clone(), outerNextUp.clone(), outerCurrUp.clone(),
                    new THREE.Vector2(0, vCurr), new THREE.Vector2(1, vNext), new THREE.Vector2(1, vCurr)));
                triangles.push(new Triangle(innerCurrUp.clone(), innerNextUp.clone(), outerNextUp.clone(),
                    new THREE.Vector2(0, vCurr), new THREE.Vector2(0, vNext), new THREE.Vector2(1, vNext)));
            }
        }

        return triangles;
    }
}