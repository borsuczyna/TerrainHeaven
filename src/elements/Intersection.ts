import * as THREE from 'three';
import WorldElement, { type NodeBasis, type GeometryGroup, type UVTransform, type ElementData, type OccupiedTriangle } from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Config from '../utils/Config';
import type { PropertyDefinition, SectionItem } from '../editor/Properties';

export type EdgeType = 'none' | 'sidewalk';

export default class Intersection extends WorldElement {
    public width: number = 3;
    public length: number = 3;
    private _nodeCount: number = 4;
    public edgeType: EdgeType = 'none';
    public sidewalkWidth: number = 1;
    public curbHeight: number = 0.15;
    public roadTexWidth: number = 3;
    public roadTexHeight: number = 3;
    public roadTexOffsetX: number = 0;
    public roadTexOffsetY: number = 0;

    public override getWidth(): number { return this.width; }
    public override getSidewalkWidth(): number { return this.edgeType === 'sidewalk' ? this.sidewalkWidth : 0; }
    public override getCurbHeight(): number { return this.edgeType === 'sidewalk' ? this.curbHeight : 0; }

    public override getUVGroups(): string[] { return ['road']; }

    public override getUVTransform(group: string): UVTransform {
        if (group === 'road') {
            return {
                offsetX: this.roadTexOffsetX,
                offsetY: this.roadTexOffsetY,
                scaleX: this.roadTexWidth,
                scaleY: this.roadTexHeight,
            };
        }
        return super.getUVTransform(group);
    }

    public override setUVTransform(group: string, t: UVTransform): void {
        if (group === 'road') {
            this.roadTexOffsetX = t.offsetX;
            this.roadTexOffsetY = t.offsetY;
            this.roadTexWidth = Math.max(0.1, t.scaleX);
            this.roadTexHeight = Math.max(0.1, t.scaleY);
            this.update();
        }
    }

    constructor(position: THREE.Vector3, nodeCount: number = 4) {
        super();
        this._nodeCount = nodeCount;
        this.rebuildNodes(position);
    }

    public get nodeCount(): number { return this._nodeCount; }
    public set nodeCount(value: number) {
        if (value < 2) value = 2;
        if (value === this._nodeCount) return;
        const center = this.getCenter();
        this._nodeCount = value;
        this.rebuildNodes(center);
        this.update();
    }

    private getCenter(): THREE.Vector3 {
        if (this.nodes.length === 0) return new THREE.Vector3();
        const center = new THREE.Vector3();
        for (const node of this.nodes) {
            center.add(node.mesh.position);
        }
        return center.divideScalar(this.nodes.length);
    }

    private rebuildNodes(center: THREE.Vector3): void {
        // Disconnect from all connected elements (both sides)
        this.disconnectAll();

        for (const node of this.nodes) {
            this.mesh.remove(node.mesh);
            if (node.parent === this) node.parent = null;
        }
        this.nodes = [];

        // Create nodes evenly spaced around center
        for (let i = 0; i < this._nodeCount; i++) {
            const angle = (i / this._nodeCount) * Math.PI * 2;
            const radius = this.width * 1;
            const offset = new THREE.Vector3(
                Math.cos(angle) * radius,
                0,
                Math.sin(angle) * radius,
            );
            const pos = center.clone().add(offset);
            this.setNode(i, new WorldNode(pos, Config.editor.nodeColor));
        }
    }

    public getNodeBasis(index: number): NodeBasis {
        const center = this.getCenter();
        const nodePos = this.nodes[index].mesh.position;
        const up = new THREE.Vector3(0, 1, 0);

        // Forward points outward from center
        const forward = new THREE.Vector3().subVectors(nodePos, center).normalize();
        if (forward.lengthSq() < 0.001) {
            forward.set(1, 0, 0);
        }

        const right = new THREE.Vector3().crossVectors(forward, up).normalize();
        return { forward, right, up };
    }

    public connectWith(thisNodeIndex: number, other: WorldElement, otherNodeIndex: number): void {
        this.connect(thisNodeIndex, other, otherNodeIndex);
        this.update();
        other.update();
    }

    public override getOccupiedArea(): OccupiedTriangle[] {
        const projected: OccupiedTriangle[] = [];
        const groups = this.getGeometry();

        const triArea2D = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2): number => {
            return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5;
        };

        for (const group of groups) {
            for (const tri of group.triangles) {
                const a = new THREE.Vector2(tri.a.x, tri.a.z);
                const b = new THREE.Vector2(tri.b.x, tri.b.z);
                const c = new THREE.Vector2(tri.c.x, tri.c.z);
                if (triArea2D(a, b, c) < 1e-8) continue;
                projected.push({ a, b, c });
            }
        }

        return projected;
    }

    public override serialize(id: number): ElementData {
        const { textures, textureRotations } = this.collectTextureMaps();
        const nodes = [];
        for (let i = 0; i < this.nodeCount; i++) {
            const p = this.getNode(i).mesh.position;
            nodes.push({ x: p.x, y: p.y, z: p.z });
        }
        return {
            type: 'intersection', id, nodes, textures, textureRotations,
            width: this.width,
            length: this.length,
            nodeCount: this.nodeCount,
            edgeType: this.edgeType,
            sidewalkWidth: this.sidewalkWidth,
            curbHeight: this.curbHeight,
            roadTexWidth: this.roadTexWidth,
            roadTexHeight: this.roadTexHeight,
            roadTexOffsetX: this.roadTexOffsetX,
            roadTexOffsetY: this.roadTexOffsetY,
        };
    }

    public static deserialize(ed: ElementData): Intersection {
        const center = new THREE.Vector3();
        for (const n of ed.nodes) center.add(new THREE.Vector3(n.x, n.y, n.z));
        center.divideScalar(ed.nodes.length);
        const intersection = new Intersection(center, ed.nodeCount ?? 4);
        intersection.width = ed.width ?? 3;
        intersection.length = ed.length ?? 3;
        intersection.edgeType = (ed.edgeType as 'none' | 'sidewalk') ?? 'none';
        intersection.sidewalkWidth = ed.sidewalkWidth ?? 1;
        intersection.curbHeight = ed.curbHeight ?? 0.15;
        intersection.roadTexWidth = ed.roadTexWidth ?? 3;
        intersection.roadTexHeight = ed.roadTexHeight ?? 3;
        intersection.roadTexOffsetX = ed.roadTexOffsetX ?? 0;
        intersection.roadTexOffsetY = ed.roadTexOffsetY ?? 0;
        for (let i = 0; i < ed.nodes.length; i++) {
            const n = ed.nodes[i];
            intersection.getNode(i).update(new THREE.Vector3(n.x, n.y, n.z));
        }
        return intersection;
    }

    public getProperties(): PropertyDefinition {
        const self = this;
        const makeNodeVec3 = (label: string, node: WorldNode) => ({
            type: 'vector3' as const,
            label,
            get: () => node.mesh.position.clone(),
            set: (v: THREE.Vector3) => { node.update(v); },
        });

        const nodeSections = this.nodes.map((node, i) => {
            const props: SectionItem[] = [makeNodeVec3('Position', node)];
            if (this.isConnected(i)) {
                props.push({
                    type: 'button' as const,
                    label: 'Disconnect',
                    onClick: () => { self.disconnect(i); self.onPropertiesChanged?.(); },
                });
            }
            return { label: `Node ${i}`, properties: props };
        });

        return {
            title: 'Intersection',
            icon: '&#11021;',
            sections: [
                {
                    label: 'Intersection',
                    properties: [
                        {
                            type: 'number' as const,
                            label: 'Width',
                            get: () => self.width,
                            set: (v: number) => { self.width = Math.max(0.1, v); self.update(); },
                            min: 0.1,
                            step: 0.1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Length',
                            get: () => self.length,
                            set: (v: number) => { self.length = Math.max(0.1, v); self.update(); },
                            min: 0.1,
                            step: 0.1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Nodes',
                            get: () => self.nodeCount,
                            set: (v: number) => { self.nodeCount = Math.max(2, Math.round(v)); self.onPropertiesChanged?.(); },
                            min: 2,
                            step: 1,
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
                            type: 'number' as const,
                            label: 'Tex Width',
                            get: () => self.roadTexWidth,
                            set: (v: number) => { self.roadTexWidth = Math.max(0.1, v); self.update(); },
                            min: 0.1,
                            step: 0.1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Tex Height',
                            get: () => self.roadTexHeight,
                            set: (v: number) => { self.roadTexHeight = Math.max(0.1, v); self.update(); },
                            min: 0.1,
                            step: 0.1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Offset X',
                            get: () => self.roadTexOffsetX,
                            set: (v: number) => { self.roadTexOffsetX = v; self.update(); },
                            step: 0.1,
                        },
                        {
                            type: 'number' as const,
                            label: 'Offset Y',
                            get: () => self.roadTexOffsetY,
                            set: (v: number) => { self.roadTexOffsetY = v; self.update(); },
                            step: 0.1,
                        },
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
                    ],
                },
                ...nodeSections,
            ],
        };
    }

    protected getGeometry(): GeometryGroup[] {
        const roadTris: Triangle[] = [];
        const swTris: Triangle[] = [];
        const center = this.getCenter();

        const leftEdges: THREE.Vector3[] = [];
        const rightEdges: THREE.Vector3[] = [];

        for (let i = 0; i < this._nodeCount; i++) {
            const nodePos = this.nodes[i].mesh.position;
            const basis = this.getResolvedNodeBasis(i);
            const hw = this.getResolvedHalfWidth(i);
            leftEdges.push(nodePos.clone().sub(basis.right.clone().multiplyScalar(hw)));
            rightEdges.push(nodePos.clone().add(basis.right.clone().multiplyScalar(hw)));
        }

        // Use planar UV based on world XZ relative to center, scaled by tex width/height
        const sw = this.roadTexWidth || 1;
        const sh = this.roadTexHeight || 1;
        const uvOf = (p: THREE.Vector3) => new THREE.Vector2(
            (p.x - center.x) / sw + this.roadTexOffsetX,
            (p.z - center.z) / sh + this.roadTexOffsetY,
        );

        for (let i = 0; i < this._nodeCount; i++) {
            const nextIdx = (i + 1) % this._nodeCount;

            // Road mouth quad at node i
            roadTris.push(new Triangle(center.clone(), rightEdges[i].clone(), leftEdges[i].clone(),
                uvOf(center), uvOf(rightEdges[i]), uvOf(leftEdges[i])));

            // Fill gap between node i's right edge and next node's left edge
            roadTris.push(new Triangle(center.clone(), leftEdges[nextIdx].clone(), rightEdges[i].clone(),
                uvOf(center), uvOf(leftEdges[nextIdx]), uvOf(rightEdges[i])));
        }

        // Sidewalk around the perimeter
        if (this.edgeType === 'sidewalk') {
            for (let i = 0; i < this._nodeCount; i++) {
                const nextIdx = (i + 1) % this._nodeCount;
                const nodePos = this.nodes[i].mesh.position;
                const nextNodePos = this.nodes[nextIdx].mesh.position;
                const basis = this.getResolvedNodeBasis(i);
                const nextBasis = this.getResolvedNodeBasis(nextIdx);
                const hw = this.getResolvedHalfWidth(i);
                const nextHw = this.getResolvedHalfWidth(nextIdx);
                const sw = this.getResolvedSidewalkWidth(i);
                const nextSw = this.getResolvedSidewalkWidth(nextIdx);
                const ch = this.getResolvedCurbHeight(i);
                const nextCh = this.getResolvedCurbHeight(nextIdx);
                const up = new THREE.Vector3(0, 1, 0);

                const innerA = rightEdges[i];
                const innerB = leftEdges[nextIdx];
                const outerA = nodePos.clone().add(basis.right.clone().multiplyScalar(hw + sw));
                const outerB = nextNodePos.clone().sub(nextBasis.right.clone().multiplyScalar(nextHw + nextSw));

                const upA = up.clone().multiplyScalar(ch);
                const upB = up.clone().multiplyScalar(nextCh);

                const innerAUp = innerA.clone().add(upA);
                const innerBUp = innerB.clone().add(upB);
                const outerAUp = outerA.clone().add(upA);
                const outerBUp = outerB.clone().add(upB);

                const edgeLen = innerA.distanceTo(innerB);

                // Curb face
                swTris.push(new Triangle(innerA.clone(), innerBUp.clone(), innerAUp.clone(),
                    new THREE.Vector2(0, 0), new THREE.Vector2(1, edgeLen), new THREE.Vector2(1, 0)));
                swTris.push(new Triangle(innerA.clone(), innerB.clone(), innerBUp.clone(),
                    new THREE.Vector2(0, 0), new THREE.Vector2(0, edgeLen), new THREE.Vector2(1, edgeLen)));

                // Sidewalk top
                swTris.push(new Triangle(innerAUp.clone(), innerBUp.clone(), outerBUp.clone(),
                    new THREE.Vector2(0, 0), new THREE.Vector2(0, edgeLen), new THREE.Vector2(1, edgeLen)));
                swTris.push(new Triangle(innerAUp.clone(), outerBUp.clone(), outerAUp.clone(),
                    new THREE.Vector2(0, 0), new THREE.Vector2(1, edgeLen), new THREE.Vector2(1, 0)));
            }
        }

        const groups: GeometryGroup[] = [{ name: 'road', triangles: roadTris }];
        if (swTris.length > 0) groups.push({ name: 'sidewalk', triangles: swTris });
        return groups;
    }
}
