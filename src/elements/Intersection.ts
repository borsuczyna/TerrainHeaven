import * as THREE from 'three';
import WorldElement, {
    type ConnectionProfile, type ElementData, type GeometryGroup, type NodeBasis,
    type OccupiedTriangle, type UVTransform,
} from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Config from '../utils/Config';
import type { PropertyDefinition, SectionItem } from '../editor/Properties';

export type EdgeType = 'none' | 'sidewalk';

type Point2 = { x: number; z: number };
type Rect2 = { minX: number; maxX: number; minZ: number; maxZ: number };
type BoundaryEdge = { start: Point2; end: Point2; outward: Point2; mouth: boolean };

const UP = new THREE.Vector3(0, 1, 0);
const EPS = 1e-7;

/** Fixed-footprint T/cross junction. Connections never affect its geometry. */
export default class Intersection extends WorldElement {
    private center: THREE.Vector3;
    private _nodeCount: 3 | 4;

    public width = 8;
    public length = 8;
    public outletWidth = 4;
    public outletLength = 2;
    public rotation = 0;
    public edgeType: EdgeType = 'none';
    public sidewalkWidth = 1;
    public curbHeight = 0.15;
    public roadTexWidth = 3;
    public roadTexHeight = 3;
    public roadTexOffsetX = 0;
    public roadTexOffsetY = 0;
    public sidewalkTexWidth = 1;
    public sidewalkTexHeight = 1;
    public sidewalkTexOffsetX = 0;
    public sidewalkTexOffsetY = 0;

    // 3-way = west/east/north. Rotation selects which direction has no outlet.
    private static readonly NORMALS: readonly Point2[] = [
        { x: -1, z: 0 }, { x: 1, z: 0 }, { x: 0, z: -1 }, { x: 0, z: 1 },
    ];
    private static readonly LABELS = ['West', 'East', 'North', 'South'] as const;

    constructor(position: THREE.Vector3, nodeCount = 4) {
        super();
        this.center = position.clone();
        this._nodeCount = this.clampNodeCount(nodeCount);
        this.rebuildNodes();
    }

    private clampNodeCount(value: number): 3 | 4 { return Math.round(value) <= 3 ? 3 : 4; }
    private get effectiveOutletWidth(): number {
        return THREE.MathUtils.clamp(this.outletWidth, 0.2, Math.min(this.width, this.length));
    }

    public get nodeCount(): number { return this._nodeCount; }
    public set nodeCount(value: number) {
        const next = this.clampNodeCount(value);
        if (next === this._nodeCount) return;
        this._nodeCount = next;
        this.rebuildNodes();
        this.refreshLayout();
    }

    public override getWidth(): number { return this.effectiveOutletWidth; }
    public override getSidewalkWidth(): number { return this.edgeType === 'sidewalk' ? this.sidewalkWidth : 0; }
    public override getCurbHeight(): number { return this.edgeType === 'sidewalk' ? this.curbHeight : 0; }
    public override getFixedConnectionProfile(_index: number): ConnectionProfile {
        return {
            halfWidth: this.effectiveOutletWidth / 2,
            sidewalkWidth: this.getSidewalkWidth(),
            curbHeight: this.getCurbHeight(),
        };
    }

    public override getUVGroups(): string[] {
        return this.edgeType === 'sidewalk' ? ['road', 'sidewalk'] : ['road'];
    }
    public override getUVTransform(group: string): UVTransform {
        if (group === 'road') return {
            offsetX: this.roadTexOffsetX, offsetY: this.roadTexOffsetY,
            scaleX: this.roadTexWidth, scaleY: this.roadTexHeight,
        };
        if (group === 'sidewalk') return {
            offsetX: this.sidewalkTexOffsetX, offsetY: this.sidewalkTexOffsetY,
            scaleX: this.sidewalkTexWidth, scaleY: this.sidewalkTexHeight,
        };
        return super.getUVTransform(group);
    }
    public override setUVTransform(group: string, transform: UVTransform): void {
        if (group === 'road') {
            this.roadTexOffsetX = transform.offsetX;
            this.roadTexOffsetY = transform.offsetY;
            this.roadTexWidth = Math.max(0.1, transform.scaleX);
            this.roadTexHeight = Math.max(0.1, transform.scaleY);
        } else if (group === 'sidewalk') {
            this.sidewalkTexOffsetX = transform.offsetX;
            this.sidewalkTexOffsetY = transform.offsetY;
            this.sidewalkTexWidth = Math.max(0.1, transform.scaleX);
            this.sidewalkTexHeight = Math.max(0.1, transform.scaleY);
        } else return;
        super.update();
    }

    private localToWorld(point: Point2, height = 0): THREE.Vector3 {
        return new THREE.Vector3(point.x, height, point.z)
            .applyAxisAngle(UP, THREE.MathUtils.degToRad(this.rotation)).add(this.center);
    }
    private outletLocal(index: number): Point2 {
        const hx = this.width / 2;
        const hz = this.length / 2;
        if (index === 0) return { x: -hx - this.outletLength, z: 0 };
        if (index === 1) return { x: hx + this.outletLength, z: 0 };
        if (index === 2) return { x: 0, z: -hz - this.outletLength };
        return { x: 0, z: hz + this.outletLength };
    }
    private outletWorld(index: number): THREE.Vector3 { return this.localToWorld(this.outletLocal(index)); }

    private rebuildNodes(): void {
        this.disconnectAll();
        for (const node of this.nodes) {
            this.mesh.remove(node.mesh);
            node.dispose();
        }
        this.nodes = [];
        for (let index = 0; index < this._nodeCount; index++) {
            this.setNode(index, new WorldNode(this.outletWorld(index), Config.editor.nodeColor));
        }
    }

    private syncNodes(): boolean {
        let changed = false;
        for (let index = 0; index < this._nodeCount; index++) {
            const target = this.outletWorld(index);
            if (this.nodes[index].mesh.position.distanceToSquared(target) <= EPS * EPS) continue;
            this.nodes[index].mesh.position.copy(target);
            changed = true;
        }
        return changed;
    }
    private refreshLayout(): void {
        this.syncNodes();
        super.update();
        for (const connection of this.connections.values()) connection.element.update();
    }

    /** Accept a rigid whole-element gizmo transform, but reject deformation of one outlet. */
    public override update(): void {
        const expected = this.nodes.map((_node, index) => this.outletWorld(index));
        const actual = this.nodes.map((node) => node.mesh.position.clone());
        if (expected.some((point, index) => point.distanceToSquared(actual[index]) > EPS * EPS)) {
            const expectedMean = expected.reduce((sum, point) => sum.add(point), new THREE.Vector3())
                .divideScalar(expected.length);
            const actualMean = actual.reduce((sum, point) => sum.add(point), new THREE.Vector3())
                .divideScalar(actual.length);
            let dot = 0;
            let cross = 0;
            for (let index = 0; index < expected.length; index++) {
                const ex = expected[index].x - expectedMean.x;
                const ez = expected[index].z - expectedMean.z;
                const ax = actual[index].x - actualMean.x;
                const az = actual[index].z - actualMean.z;
                dot += ex * ax + ez * az;
                cross += ex * az - ez * ax;
            }
            const deltaAngle = Math.atan2(-cross, dot);
            const oldCenter = this.center.clone();
            const oldRotation = this.rotation;
            const meanOffset = expectedMean.clone().sub(this.center).applyAxisAngle(UP, deltaAngle);
            this.center.copy(actualMean).sub(meanOffset);
            this.rotation += THREE.MathUtils.radToDeg(deltaAngle);
            const rigid = actual.every((point, index) =>
                point.distanceToSquared(this.outletWorld(index)) < 1e-8);
            if (!rigid) {
                this.center.copy(oldCenter);
                this.rotation = oldRotation;
            }
        }
        const corrected = this.syncNodes();
        super.update();
        if (corrected) for (const connection of this.connections.values()) connection.element.update();
    }

    public getNodeBasis(index: number): NodeBasis {
        const normal = Intersection.NORMALS[index];
        const forward = new THREE.Vector3(normal.x, 0, normal.z)
            .applyAxisAngle(UP, THREE.MathUtils.degToRad(this.rotation));
        return { forward, right: new THREE.Vector3().crossVectors(forward, UP).normalize(), up: UP.clone() };
    }
    public connectWith(thisNodeIndex: number, other: WorldElement, otherNodeIndex: number): void {
        this.connect(thisNodeIndex, other, otherNodeIndex);
    }

    public override getOccupiedArea(): OccupiedTriangle[] {
        return this.getGeometry().flatMap((group) => group.triangles).filter((triangle) => Math.abs(
            (triangle.b.x - triangle.a.x) * (triangle.c.z - triangle.a.z)
            - (triangle.b.z - triangle.a.z) * (triangle.c.x - triangle.a.x),
        ) > 1e-8).map((triangle) => ({
            a: triangle.a.clone(), b: triangle.b.clone(), c: triangle.c.clone(),
        }));
    }

    public override serialize(id: number): ElementData {
        const { textures, textureRotations } = this.collectTextureMaps();
        return {
            type: 'intersection', id,
            nodes: [{ x: this.center.x, y: this.center.y, z: this.center.z }],
            textures, textureRotations,
            width: this.width, length: this.length, rotation: this.rotation,
            nodeCount: this.nodeCount, outletWidth: this.outletWidth, outletLength: this.outletLength,
            edgeType: this.edgeType, sidewalkWidth: this.sidewalkWidth, curbHeight: this.curbHeight,
            roadTexWidth: this.roadTexWidth, roadTexHeight: this.roadTexHeight,
            roadTexOffsetX: this.roadTexOffsetX, roadTexOffsetY: this.roadTexOffsetY,
            sidewalkTexWidth: this.sidewalkTexWidth, sidewalkTexHeight: this.sidewalkTexHeight,
            sidewalkTexOffsetX: this.sidewalkTexOffsetX, sidewalkTexOffsetY: this.sidewalkTexOffsetY,
        };
    }
    public static deserialize(data: ElementData): Intersection {
        const center = data.nodes.reduce<THREE.Vector3>((sum, node) =>
            sum.add(new THREE.Vector3(node.x, node.y, node.z)), new THREE.Vector3())
            .divideScalar(Math.max(1, data.nodes.length));
        const value = new Intersection(center, data.nodeCount ?? 4);
        value.width = data.width ?? 8;
        value.length = data.length ?? 8;
        value.rotation = data.rotation ?? 0;
        value.outletWidth = data.outletWidth ?? Math.min(value.width, value.length, 4);
        value.outletLength = data.outletLength ?? 2;
        value.edgeType = (data.edgeType as EdgeType) ?? 'none';
        value.sidewalkWidth = data.sidewalkWidth ?? 1;
        value.curbHeight = data.curbHeight ?? 0.15;
        value.roadTexWidth = data.roadTexWidth ?? 3;
        value.roadTexHeight = data.roadTexHeight ?? 3;
        value.roadTexOffsetX = data.roadTexOffsetX ?? 0;
        value.roadTexOffsetY = data.roadTexOffsetY ?? 0;
        value.sidewalkTexWidth = data.sidewalkTexWidth ?? 1;
        value.sidewalkTexHeight = data.sidewalkTexHeight ?? 1;
        value.sidewalkTexOffsetX = data.sidewalkTexOffsetX ?? 0;
        value.sidewalkTexOffsetY = data.sidewalkTexOffsetY ?? 0;
        value.refreshLayout();
        return value;
    }

    public getProperties(): PropertyDefinition {
        const numberProperty = (
            label: string, get: () => number, set: (value: number) => void, min: number, step = 0.1,
        ): SectionItem => ({ type: 'number', label, get, set, min, step });
        const outletSections = this.nodes.map((_node, index) => ({
            label: `Outlet ${Intersection.LABELS[index]}`,
            properties: [{
                type: 'button' as const,
                label: this.isConnected(index) ? 'Disconnect' : 'Not connected',
                onClick: () => {
                    if (this.isConnected(index)) this.disconnect(index);
                    this.onPropertiesChanged?.();
                },
            }],
        }));
        return {
            title: 'Intersection', icon: '&#11021;', sections: [
                { label: 'Intersection', properties: [
                    { type: 'vector3', label: 'Position', get: () => this.center.clone(),
                        set: (value: THREE.Vector3) => { this.center.copy(value); this.refreshLayout(); } },
                    { type: 'select', label: 'Outlets', options: [
                        { label: '3 (T junction)', value: '3' },
                        { label: '4 (crossroads)', value: '4' },
                    ], get: () => String(this.nodeCount), set: (value: string) => {
                        this.nodeCount = Number(value); this.onPropertiesChanged?.();
                    } },
                    numberProperty('Center Width', () => this.width, (value) => {
                        this.width = Math.max(0.5, value); this.refreshLayout();
                    }, 0.5),
                    numberProperty('Center Length', () => this.length, (value) => {
                        this.length = Math.max(0.5, value); this.refreshLayout();
                    }, 0.5),
                    numberProperty('Outlet Width', () => this.outletWidth, (value) => {
                        this.outletWidth = Math.max(0.2, value); this.refreshLayout();
                    }, 0.2),
                    numberProperty('Outlet Length', () => this.outletLength, (value) => {
                        this.outletLength = Math.max(0.1, value); this.refreshLayout();
                    }, 0.1),
                    numberProperty('Rotation', () => this.rotation, (value) => {
                        this.rotation = value; this.refreshLayout();
                    }, -360, 1),
                ] },
                { label: 'Edges', properties: [
                    { type: 'select', label: 'Type', options: [
                        { label: 'None', value: 'none' }, { label: 'Sidewalk', value: 'sidewalk' },
                    ], get: () => this.edgeType, set: (value: string) => {
                        this.edgeType = value as EdgeType; this.refreshLayout(); this.onPropertiesChanged?.();
                    } },
                    ...(this.edgeType === 'sidewalk' ? [
                        numberProperty('Sidewalk Width', () => this.sidewalkWidth, (value) => {
                            this.sidewalkWidth = Math.max(0.1, value); this.refreshLayout();
                        }, 0.1),
                        numberProperty('Curb Height', () => this.curbHeight, (value) => {
                            this.curbHeight = Math.max(0, value); this.refreshLayout();
                        }, 0, 0.05),
                    ] : []),
                ] },
                { label: 'Textures', properties: [
                    this.rotationProperty('Road Rot.', 'road'), this.rotationProperty('Sidewalk Rot.', 'sidewalk'),
                ] },
                ...outletSections,
            ],
        };
    }
    private rotationProperty(label: string, group: string): SectionItem {
        return { type: 'select', label, options: [0, 90, 180, 270].map((value) => ({
            label: `${value}°`, value: String(value),
        })), get: () => String(this.textureRotations.get(group) ?? 0),
        set: (value: string) => { this.setTextureRotation(group, Number(value)); } };
    }

    public getExportGeometry(_lodIndex: number): GeometryGroup[] { return this.getGeometry(); }

    private footprintRects(): Rect2[] {
        const hx = this.width / 2;
        const hz = this.length / 2;
        const outletHalf = this.effectiveOutletWidth / 2;
        const tipX = hx + this.outletLength;
        const tipZ = hz + this.outletLength;

        // The asphalt follows the same clean inner edges as the sidewalk corners: one
        // horizontal road corridor and one vertical corridor. A large centre rectangle
        // used here previously protruded into every outer corner beyond the L-shaped
        // sidewalks, leaving four visible asphalt squares.
        const rects: Rect2[] = [{
            minX: -tipX,
            maxX: tipX,
            minZ: -outletHalf,
            maxZ: outletHalf,
        }];
        rects.push({
            minX: -outletHalf,
            maxX: outletHalf,
            minZ: -tipZ,
            maxZ: this._nodeCount === 4 ? tipZ : outletHalf,
        });
        return rects;
    }
    private pointKey(point: Point2): string { return `${point.x.toFixed(8)},${point.z.toFixed(8)}`; }
    private isMouth(start: Point2, end: Point2): boolean {
        const tipX = this.width / 2 + this.outletLength;
        const tipZ = this.length / 2 + this.outletLength;
        const vertical = Math.abs(start.x - end.x) < EPS;
        const horizontal = Math.abs(start.z - end.z) < EPS;
        if (vertical && Math.abs(Math.abs(start.x) - tipX) < EPS) return true;
        if (horizontal && Math.abs(start.z + tipZ) < EPS) return true;
        return this._nodeCount === 4 && horizontal && Math.abs(start.z - tipZ) < EPS;
    }

    /** Split the rectangle union on a tiny coordinate grid, yielding a deterministic mesh and outline. */
    private cellsAndBoundary(): { cells: Rect2[]; boundary: BoundaryEdge[] } {
        const rects = this.footprintRects();
        const xs = [...new Set(rects.flatMap((rect) => [rect.minX, rect.maxX]))].sort((a, b) => a - b);
        const zs = [...new Set(rects.flatMap((rect) => [rect.minZ, rect.maxZ]))].sort((a, b) => a - b);
        const cells: Rect2[] = [];
        const edges = new Map<string, BoundaryEdge>();
        const addEdge = (start: Point2, end: Point2, outward: Point2): void => {
            const key = `${this.pointKey(start)}>${this.pointKey(end)}`;
            const reverse = `${this.pointKey(end)}>${this.pointKey(start)}`;
            if (edges.has(reverse)) edges.delete(reverse);
            else edges.set(key, { start, end, outward, mouth: this.isMouth(start, end) });
        };
        for (let x = 0; x < xs.length - 1; x++) for (let z = 0; z < zs.length - 1; z++) {
            const cell = { minX: xs[x], maxX: xs[x + 1], minZ: zs[z], maxZ: zs[z + 1] };
            const mx = (cell.minX + cell.maxX) / 2;
            const mz = (cell.minZ + cell.maxZ) / 2;
            if (!rects.some((rect) => mx > rect.minX - EPS && mx < rect.maxX + EPS
                && mz > rect.minZ - EPS && mz < rect.maxZ + EPS)) continue;
            cells.push(cell);
            addEdge({ x: cell.minX, z: cell.minZ }, { x: cell.maxX, z: cell.minZ }, { x: 0, z: -1 });
            addEdge({ x: cell.maxX, z: cell.minZ }, { x: cell.maxX, z: cell.maxZ }, { x: 1, z: 0 });
            addEdge({ x: cell.maxX, z: cell.maxZ }, { x: cell.minX, z: cell.maxZ }, { x: 0, z: 1 });
            addEdge({ x: cell.minX, z: cell.maxZ }, { x: cell.minX, z: cell.minZ }, { x: -1, z: 0 });
        }
        const remaining = [...edges.values()];
        if (remaining.length === 0) return { cells, boundary: [] };
        const nextByStart = new Map(remaining.map((edge) => [this.pointKey(edge.start), edge]));
        const boundary: BoundaryEdge[] = [];
        let edge: BoundaryEdge | undefined = remaining[0];
        while (edge && boundary.length < remaining.length) {
            boundary.push(edge);
            edge = nextByStart.get(this.pointKey(edge.end));
        }
        return { cells, boundary };
    }

    private addTriangle(output: Triangle[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
        uvA: THREE.Vector2, uvB: THREE.Vector2, uvC: THREE.Vector2): void {
        const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
        output.push(normal.y < -EPS ? new Triangle(a, c, b, uvA, uvC, uvB) : new Triangle(a, b, c, uvA, uvB, uvC));
    }
    private addSidewalkStrip(
        output: Triangle[], innerA2: Point2, innerB2: Point2, outerA2: Point2, outerB2: Point2,
    ): void {
        const innerLength = Math.hypot(innerB2.x - innerA2.x, innerB2.z - innerA2.z);
        const outerLength = Math.hypot(outerB2.x - outerA2.x, outerB2.z - outerA2.z);
        if (innerLength < EPS || outerLength < EPS) return;
        const u0 = this.sidewalkTexOffsetX;
        const curbU = u0 + this.curbHeight / this.sidewalkTexWidth;
        const outerU = u0 + this.sidewalkWidth / this.sidewalkTexWidth;
        const v0 = this.sidewalkTexOffsetY;
        const v1 = v0 + innerLength / this.sidewalkTexHeight;
        const innerA = this.localToWorld(innerA2);
        const innerB = this.localToWorld(innerB2);
        const innerAUp = this.localToWorld(innerA2, this.curbHeight);
        const innerBUp = this.localToWorld(innerB2, this.curbHeight);
        const outerA = this.localToWorld(outerA2, this.curbHeight);
        const outerB = this.localToWorld(outerB2, this.curbHeight);

        const tangent = innerB.clone().sub(innerA);
        const outward = outerA.clone().sub(innerAUp);
        const currentNormal = tangent.clone().cross(UP);
        if (currentNormal.dot(outward) <= 0) {
            this.addTriangle(output, innerA, innerB, innerBUp,
                new THREE.Vector2(u0, v0), new THREE.Vector2(u0, v1), new THREE.Vector2(curbU, v1));
            this.addTriangle(output, innerA, innerBUp, innerAUp,
                new THREE.Vector2(u0, v0), new THREE.Vector2(curbU, v1), new THREE.Vector2(curbU, v0));
        } else {
            this.addTriangle(output, innerB, innerA, innerAUp,
                new THREE.Vector2(u0, v1), new THREE.Vector2(u0, v0), new THREE.Vector2(curbU, v0));
            this.addTriangle(output, innerB, innerAUp, innerBUp,
                new THREE.Vector2(u0, v1), new THREE.Vector2(curbU, v0), new THREE.Vector2(curbU, v1));
        }
        if (innerLength > outerLength + EPS) {
            // A mitred elbow has a longer inner edge than outer edge. Split the long
            // trapezoid into a rectangular strip plus one small 45-degree corner triangle;
            // mapping the entire trapezoid as two triangles sheared the texture over the
            // full arm length and produced the visibly stretched bricks at the bend.
            const ratio = outerLength / innerLength;
            const tangent2 = {
                x: innerA2.x + (innerB2.x - innerA2.x) * ratio,
                z: innerA2.z + (innerB2.z - innerA2.z) * ratio,
            };
            const tangentUp = this.localToWorld(tangent2, this.curbHeight);
            const tangentV = v0 + outerLength / this.sidewalkTexHeight;
            this.addTriangle(output, innerAUp, tangentUp, outerB,
                new THREE.Vector2(u0, v0), new THREE.Vector2(u0, tangentV), new THREE.Vector2(outerU, tangentV));
            this.addTriangle(output, innerAUp, outerB, outerA,
                new THREE.Vector2(u0, v0), new THREE.Vector2(outerU, tangentV), new THREE.Vector2(outerU, v0));
            this.addTriangle(output, tangentUp, innerBUp, outerB,
                new THREE.Vector2(u0, tangentV), new THREE.Vector2(u0, v1), new THREE.Vector2(outerU, tangentV));
        } else {
            this.addTriangle(output, innerAUp, innerBUp, outerB,
                new THREE.Vector2(u0, v0), new THREE.Vector2(u0, v1), new THREE.Vector2(outerU, v1));
            this.addTriangle(output, innerAUp, outerB, outerA,
                new THREE.Vector2(u0, v0), new THREE.Vector2(outerU, v1), new THREE.Vector2(outerU, v0));
        }
    }

    // Join two perpendicular road sidewalks with one clean L-shaped corner. Extending the
    // two road-edge lines to their shared mitre avoids the stepped pieces produced by
    // following the central rectangle + outlet-stub outline.
    private addSidewalkCorner(output: Triangle[], sideA: number, sideB: number): void {
        const normalA = Intersection.NORMALS[sideA];
        const normalB = Intersection.NORMALS[sideB];
        const nodeA = this.outletLocal(sideA);
        const nodeB = this.outletLocal(sideB);
        const halfWidth = this.effectiveOutletWidth / 2;
        const outerDistance = halfWidth + this.sidewalkWidth;
        const innerA = { x: nodeA.x + normalB.x * halfWidth, z: nodeA.z + normalB.z * halfWidth };
        const innerB = { x: nodeB.x + normalA.x * halfWidth, z: nodeB.z + normalA.z * halfWidth };
        const innerMitre = {
            x: (normalA.x + normalB.x) * halfWidth,
            z: (normalA.z + normalB.z) * halfWidth,
        };
        const outerA = { x: nodeA.x + normalB.x * outerDistance, z: nodeA.z + normalB.z * outerDistance };
        const outerB = { x: nodeB.x + normalA.x * outerDistance, z: nodeB.z + normalA.z * outerDistance };
        const outerMitre = {
            x: (normalA.x + normalB.x) * outerDistance,
            z: (normalA.z + normalB.z) * outerDistance,
        };
        this.addSidewalkStrip(output, innerA, innerMitre, outerA, outerMitre);
        // Start both strips at their road mouths, so the rectangular UV section always
        // ends at the elbow and only the final one-width triangle receives the mitre UVs.
        this.addSidewalkStrip(output, innerB, innerMitre, outerB, outerMitre);
    }

    private addThreeWayClosedSidewalk(output: Triangle[]): void {
        const south = Intersection.NORMALS[3];
        const west = this.outletLocal(0);
        const east = this.outletLocal(1);
        const halfWidth = this.effectiveOutletWidth / 2;
        const outerDistance = halfWidth + this.sidewalkWidth;
        this.addSidewalkStrip(output,
            { x: west.x + south.x * halfWidth, z: west.z + south.z * halfWidth },
            { x: east.x + south.x * halfWidth, z: east.z + south.z * halfWidth },
            { x: west.x + south.x * outerDistance, z: west.z + south.z * outerDistance },
            { x: east.x + south.x * outerDistance, z: east.z + south.z * outerDistance });
    }

    protected getGeometry(): GeometryGroup[] {
        const { cells } = this.cellsAndBoundary();
        const road: Triangle[] = [];
        const sidewalk: Triangle[] = [];
        const roadUV = (point: THREE.Vector3) => new THREE.Vector2(
            (point.x - this.center.x) / this.roadTexWidth + this.roadTexOffsetX,
            (point.z - this.center.z) / this.roadTexHeight + this.roadTexOffsetY);
        for (const cell of cells) {
            const nw = this.localToWorld({ x: cell.minX, z: cell.minZ });
            const ne = this.localToWorld({ x: cell.maxX, z: cell.minZ });
            const se = this.localToWorld({ x: cell.maxX, z: cell.maxZ });
            const sw = this.localToWorld({ x: cell.minX, z: cell.maxZ });
            this.addTriangle(road, nw, ne, se, roadUV(nw), roadUV(ne), roadUV(se));
            this.addTriangle(road, nw, se, sw, roadUV(nw), roadUV(se), roadUV(sw));
        }
        if (this.edgeType === 'sidewalk') {
            this.addSidewalkCorner(sidewalk, 0, 2); // north-west
            this.addSidewalkCorner(sidewalk, 2, 1); // north-east
            if (this._nodeCount === 4) {
                this.addSidewalkCorner(sidewalk, 1, 3); // south-east
                this.addSidewalkCorner(sidewalk, 3, 0); // south-west
            } else {
                this.addThreeWayClosedSidewalk(sidewalk);
            }
        }
        const groups: GeometryGroup[] = [{ name: 'road', triangles: road }];
        if (sidewalk.length > 0) groups.push({ name: 'sidewalk', triangles: sidewalk });
        return groups;
    }
}
