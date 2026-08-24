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

        const triArea2D = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number => {
            return Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) * 0.5;
        };

        for (const group of groups) {
            for (const tri of group.triangles) {
                if (triArea2D(tri.a, tri.b, tri.c) < 1e-8) continue;
                projected.push({
                    a: tri.a.clone(),
                    b: tri.b.clone(),
                    c: tri.c.clone(),
                });
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

    // Intersections have no density knob to coarsen, so every LOD level is identical -
    // the exporter still calls this for consistency with Terrain/Road/RiverSpline.
    public getExportGeometry(_lodIndex: number): GeometryGroup[] {
        return this.getGeometry();
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

        // Perimeter order by angle around center, not raw node index - the constructor's
        // own circular layout happens to start out angle-sorted, but a junction merged onto
        // real, differently-angled roads gets its nodes dragged away from that circle, and
        // nothing keeps their array indices in perimeter order afterward. Using raw index
        // order here produced a self-crossing ring for exactly that (the normal, expected)
        // case, which is what made the road/sidewalk triangulation below fail/degenerate.
        const order = [...Array(this._nodeCount).keys()].sort((i, j) => {
            const angleI = Math.atan2(this.nodes[i].mesh.position.z - center.z, this.nodes[i].mesh.position.x - center.x);
            const angleJ = Math.atan2(this.nodes[j].mesh.position.z - center.z, this.nodes[j].mesh.position.x - center.x);
            return angleI - angleJ;
        });

        // The paved surface is the polygon that walks each node's own mouth (leftEdge to
        // rightEdge) then straight across to the next node's leftEdge - triangulated as one
        // simple polygon, not fanned out from an external "center" point. center is only
        // the average of the node positions, and for anything other than a perfectly even
        // circle (any junction whose nodes have actually been dragged onto real, unevenly-
        // spaced road ends - which is every junction merged onto real roads) that average
        // can land outside the polygon the nodes actually bound. Fanning triangles from a
        // point outside the polygon is exactly what produced the self-intersecting spike
        // this replaces - poking down through the surface wherever center fell on the wrong
        // side of an edge.
        //
        // leftEdge-then-rightEdge (not the other way around) matters: right/left come from
        // basis.right = forward rotated +90 CCW (see getNodeBasis), so for arms walked in
        // increasing-angle (CCW) order, each arm's rightEdge is the side facing the NEXT
        // arm and its leftEdge faces the PREVIOUS one. The gap edge connecting arm i to
        // arm i+1 therefore has to be rightEdge[i] -> leftEdge[i+1] - pushing rightEdge
        // first put that gap edge backwards (leftEdge[i] -> rightEdge[i+1]), which crossed
        // the opposite gap edge for any junction whose arms aren't evenly spread around a
        // circle (i.e. every junction actually merged onto real, unevenly-angled roads).
        const ring: THREE.Vector3[] = [];
        for (const i of order) {
            ring.push(leftEdges[i], rightEdges[i]);
        }
        const ringContour = ring.map((p) => new THREE.Vector2(p.x, p.z));
        const ringIndices = THREE.ShapeUtils.triangulateShape(ringContour, []);
        for (const [ia, ib, ic] of ringIndices) {
            let a = ring[ia];
            let b = ring[ib];
            let c = ring[ic];
            // Winding isn't guaranteed by triangulateShape to face +Y for every contour
            // orientation - correct each triangle individually rather than assuming the
            // whole ring is wound one particular way.
            const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
            if (normal.y < 0) { const tmp = b; b = c; c = tmp; }
            roadTris.push(new Triangle(a.clone(), b.clone(), c.clone(), uvOf(a), uvOf(b), uvOf(c)));
        }

        // Sidewalk around the perimeter - same angle-sorted adjacency as the road ring
        // above, so a sidewalk segment always connects genuinely neighboring arms.
        if (this.edgeType === 'sidewalk') {
            for (let k = 0; k < this._nodeCount; k++) {
                const i = order[k];
                const nextIdx = order[(k + 1) % this._nodeCount];
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
