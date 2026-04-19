import * as THREE from 'three';
import WorldElement, { type NodeBasis } from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Config from '../utils/Config';
import { sampleCubicBezier } from '../utils/Bezier';

export default class Road extends WorldElement {
    public get nodeA(): WorldNode { return this.nodes[0]; }
    public get nodeB(): WorldNode { return this.nodes[1]; }

    public width: number = 3;
    private _divisions: number = 3;
    private curvePointA: WorldNode | null = null;
    private curvePointB: WorldNode | null = null;
    private curveLineA: THREE.Line | null = null;
    private curveLineB: THREE.Line | null = null;
    private bezierLine: THREE.Line | null = null;

    public get divisions(): number { return this._divisions; }
    public set divisions(value: number) { this._divisions = value; this.updateCurveLines(); }

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
        if (this.bezierLine) { this.mesh.remove(this.bezierLine); this.bezierLine = null; }

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
        const bezierGeo = new THREE.BufferGeometry().setFromPoints(points);
        this.bezierLine = new THREE.Line(bezierGeo, new THREE.LineBasicMaterial({ color: 0xffffff }));
        this.mesh.add(this.bezierLine);
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

    protected getTriangles(): Triangle[] {
        const triangles: Triangle[] = [];
        const points = this.getBezierCurvePoints();
        const halfWidth = this.width / 2;
        const up = new THREE.Vector3(0, 1, 0);

        const getRightAtIndex = (index: number): THREE.Vector3 => {
            // At endpoints, use resolved basis (accounts for connections)
            if (index === 0) return this.getResolvedNodeBasis(0).right;
            if (index === points.length - 1) return this.getResolvedNodeBasis(1).right;

            // Interior points: compute from neighbors
            const next = points[index + 1];
            const prev = points[index - 1];
            const direction = new THREE.Vector3().subVectors(next, prev).normalize();
            return new THREE.Vector3().crossVectors(direction, up).normalize();
        };

        for (let i = 0; i < points.length - 1; i++) {
            const curr = points[i];
            const next = points[i + 1];
            const rightCurr = getRightAtIndex(i).multiplyScalar(halfWidth);
            const rightNext = getRightAtIndex(i + 1).multiplyScalar(halfWidth);

            const bl = curr.clone().sub(rightCurr);
            const br = curr.clone().add(rightCurr);
            const tl = next.clone().sub(rightNext);
            const tr = next.clone().add(rightNext);

            triangles.push(new Triangle(bl, br, tr));
            triangles.push(new Triangle(bl, tr, tl));
        }

        return triangles;
    }
}