import * as THREE from 'three';
import WorldElement, { type NodeBasis, type GeometryGroup, type UVTransform, type ElementData, type OccupiedTriangle } from './WorldElement';
import WorldNode from './WorldNode';
import Triangle from './Vertex';
import Config from '../utils/Config';
import type { PropertyDefinition, SectionItem } from '../editor/Properties';

export type EdgeType = 'none' | 'sidewalk';

// A paved junction where 2+ roads meet: a flat surface fanned out from the average of its
// own nodes, one per connected road end. Deliberately NOT built via a general polygon
// union/triangulation library (polygon-clipping, poly2tri, THREE.ShapeUtils) - every one of
// those was tried here and each produced a self-intersecting or incomplete result for some
// real (not contrived) arm arrangement, because a union of arbitrarily-angled rotated
// rectangles is a genuinely hard general computational-geometry problem, and general
// polygon triangulators are not reliably robust against the reflex-vertex, near-parallel-
// edge, and near-duplicate-vertex cases that arrangement produces.
//
// Instead: the boundary ring (each node's own road-mouth edge, connected straight across to
// the next node's mouth edge, going around in angle order) is star-shaped around the
// junction's own center by construction - direct geometric consequence of connecting
// angularly-adjacent mouths in angular order - so it can ALWAYS be triangulated by a plain
// fan of triangles from center to each boundary edge. No external triangulator, nothing
// that can throw or silently produce a wrong/incomplete result. The tradeoff versus a true
// rectangle-union shape is a chamfered (not squared-off) corner wherever two arms meet at
// very different widths or angles - a real limitation, not a bug, and worth revisiting with
// a purpose-built mitred-corner construction if it matters later, but this can never be
// broken the way the previous two attempts were.
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
    // Unlike the road group's flat world-XZ planar projection, the sidewalk group's raw UV
    // (see getGeometry) is already strip-relative world units - height/width in meters
    // across, distance-along-the-gap in meters along - matching Road's own sidewalk UV
    // convention exactly, so a connected road's sidewalk texture continues at the correct
    // scale and orientation into the intersection's own gap-fill piece instead of the old
    // flat projection, which stretched and rotated with the gap's own angle. These fields
    // divide that raw UV down (same "world units per texture repeat" convention roadTexWidth
    // already uses), defaulting to 1:1 so it matches an unmodified Road's own default scale.
    public sidewalkTexWidth: number = 1;
    public sidewalkTexHeight: number = 1;
    public sidewalkTexOffsetX: number = 0;
    public sidewalkTexOffsetY: number = 0;

    public override getWidth(): number { return this.width; }
    public override getSidewalkWidth(): number { return this.edgeType === 'sidewalk' ? this.sidewalkWidth : 0; }
    public override getCurbHeight(): number { return this.edgeType === 'sidewalk' ? this.curbHeight : 0; }

    public override getUVGroups(): string[] {
        return this.edgeType === 'sidewalk' ? ['road', 'sidewalk'] : ['road'];
    }

    public override getUVTransform(group: string): UVTransform {
        if (group === 'road') {
            return {
                offsetX: this.roadTexOffsetX,
                offsetY: this.roadTexOffsetY,
                scaleX: this.roadTexWidth,
                scaleY: this.roadTexHeight,
            };
        }
        if (group === 'sidewalk') {
            return {
                offsetX: this.sidewalkTexOffsetX,
                offsetY: this.sidewalkTexOffsetY,
                scaleX: this.sidewalkTexWidth,
                scaleY: this.sidewalkTexHeight,
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
        } else if (group === 'sidewalk') {
            this.sidewalkTexOffsetX = t.offsetX;
            this.sidewalkTexOffsetY = t.offsetY;
            this.sidewalkTexWidth = Math.max(0.1, t.scaleX);
            this.sidewalkTexHeight = Math.max(0.1, t.scaleY);
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
            sidewalkTexWidth: this.sidewalkTexWidth,
            sidewalkTexHeight: this.sidewalkTexHeight,
            sidewalkTexOffsetX: this.sidewalkTexOffsetX,
            sidewalkTexOffsetY: this.sidewalkTexOffsetY,
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
        intersection.sidewalkTexWidth = ed.sidewalkTexWidth ?? 1;
        intersection.sidewalkTexHeight = ed.sidewalkTexHeight ?? 1;
        intersection.sidewalkTexOffsetX = ed.sidewalkTexOffsetX ?? 0;
        intersection.sidewalkTexOffsetY = ed.sidewalkTexOffsetY ?? 0;
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
            // node.update(v) alone only moves the WorldNode itself - nothing rebuilds this
            // Intersection's own mesh (getGeometry() reads the node's live position, but
            // that only happens inside update()). Dragging a node's position from this
            // panel used to move the node while leaving the intersection's own paved
            // surface rendered at its old shape until something else (like the viewport
            // gizmo, which does call update() for the same node move) forced a rebuild.
            set: (v: THREE.Vector3) => { node.update(v); self.update(); },
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

    // Winding isn't guaranteed to face +Y by construction - correct each triangle
    // individually rather than assuming a fixed vertex order, same defensive pattern
    // used throughout this project for any footprint-to-3D triangulation.
    private addFlatTriangle(
        out: Triangle[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
        uvOf: (p: THREE.Vector3) => THREE.Vector2,
        labels?: [string, string, string],
    ): void {
        let labelA = labels?.[0], labelB = labels?.[1], labelC = labels?.[2];
        const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
        if (normal.y < 0) {
            const tmp = b; b = c; c = tmp;
            const tmpLabel = labelB; labelB = labelC; labelC = tmpLabel;
        }
        const tri = new Triangle(a, b, c, uvOf(a), uvOf(b), uvOf(c));
        tri.labelA = labelA; tri.labelB = labelB; tri.labelC = labelC;
        out.push(tri);
    }

    // Same winding correction as addFlatTriangle, but for triangles whose 3 corners need
    // independently-chosen UVs rather than one shared planar projection - used by the
    // sidewalk strip, where the very same 3D vertex plays a different UV role (e.g. "top of
    // the curb face" vs "inner edge of the top surface") depending on which triangle it
    // appears in, exactly like Road's own per-segment sidewalk UVs.
    private addFlatTriangleUV(
        out: Triangle[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
        uvA: THREE.Vector2, uvB: THREE.Vector2, uvC: THREE.Vector2,
        labels?: [string, string, string],
    ): void {
        let labelA = labels?.[0], labelB = labels?.[1], labelC = labels?.[2];
        const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
        if (normal.y < 0) {
            const tmpV = b; b = c; c = tmpV;
            const tmpUV = uvB; uvB = uvC; uvC = tmpUV;
            const tmpLabel = labelB; labelB = labelC; labelC = tmpLabel;
        }
        const tri = new Triangle(a, b, c, uvA, uvB, uvC);
        tri.labelA = labelA; tri.labelB = labelB; tri.labelC = labelC;
        out.push(tri);
    }

    // Intersects two lines in the XZ plane (roads are flat) - aPoint+t*aDir and
    // bPoint+s*bDir - to find a true mitred (sharp) corner between two adjacent arms' own
    // edge lines, instead of the flat chamfer between their two raw mouth points. Returns
    // null when the lines are too close to parallel to have a well-defined intersection -
    // this also naturally covers a fully collinear straight through-road, which doesn't
    // need a mitred corner at all. A non-null result still isn't blindly trusted by the
    // caller - see getGeometry's own validation of where it lands.
    private mitreCorner(
        aPoint: THREE.Vector3, aDir: THREE.Vector3,
        bPoint: THREE.Vector3, bDir: THREE.Vector3,
    ): THREE.Vector3 | null {
        const denom = aDir.x * bDir.z - aDir.z * bDir.x;
        if (Math.abs(denom) < 1e-4) return null;
        const dx = bPoint.x - aPoint.x;
        const dz = bPoint.z - aPoint.z;
        const t = (dx * bDir.z - dz * bDir.x) / denom;
        return new THREE.Vector3(aPoint.x + t * aDir.x, aPoint.y, aPoint.z + t * aDir.z);
    }

    protected getGeometry(): GeometryGroup[] {
        const roadTris: Triangle[] = [];
        const swTris: Triangle[] = [];
        if (this._nodeCount < 2) return [{ name: 'road', triangles: roadTris }];

        const center = this.getCenter();
        const centerFlat = new THREE.Vector3(center.x, center.y, center.z);

        // Use planar UV based on world XZ relative to center, scaled by tex width/height
        const texW = this.roadTexWidth || 1;
        const texH = this.roadTexHeight || 1;
        const uvOf = (p: THREE.Vector3): THREE.Vector2 => new THREE.Vector2(
            (p.x - center.x) / texW + this.roadTexOffsetX,
            (p.z - center.z) / texH + this.roadTexOffsetY,
        );

        // Perimeter order by angle around center, not raw node index - the constructor's
        // own circular layout starts out angle-sorted, but nothing keeps a node's array
        // index matching its actual angular position once it's been dragged (merged onto
        // a real road) away from that original circle.
        const order = [...Array(this._nodeCount).keys()].sort((i, j) => {
            const a = this.nodes[i].mesh.position;
            const b = this.nodes[j].mesh.position;
            return Math.atan2(a.z - center.z, a.x - center.x) - Math.atan2(b.z - center.z, b.x - center.x);
        });

        // Each arm's own two mouth points. basis.right = forward rotated +90 CCW (see
        // getNodeBasis), so walked in this increasing-angle order, an arm's own rightEdge
        // faces the NEXT arm and its leftEdge faces the PREVIOUS one - the gap edge closing
        // arm i to arm i+1 is therefore rightEdge[i] -> leftEdge[i+1].
        const arms = order.map((i) => {
            const nodePos = this.nodes[i].mesh.position;
            const basis = this.getResolvedNodeBasis(i);
            const hw = this.getResolvedHalfWidth(i);
            const offset = basis.right.clone().multiplyScalar(hw);
            return {
                i,
                nodePos: nodePos.clone(),
                right: basis.right.clone(),
                forward: basis.forward.clone(),
                leftEdge: nodePos.clone().sub(offset),
                rightEdge: nodePos.clone().add(offset),
                sidewalkWidth: this.getResolvedSidewalkWidth(i),
                curbHeight: this.getResolvedCurbHeight(i),
            };
        });

        const n = arms.length;

        // For each gap, try a true mitred corner - where arm a's own right-edge LINE
        // (extended) crosses arm b's own left-edge line - instead of always drawing a flat
        // chamfer between their two raw mouth points. A flat chamfer is simple and always
        // safe, but visibly cuts the corner off wherever two arms don't meet at a very wide
        // angle, which reads as a diamond/rhombus instead of a square-ish junction. Mitring
        // gives a sharp corner there instead. Each candidate is validated before use and
        // falls back to the original flat chamfer whenever it isn't well-defined (near-
        // parallel edges - this is also what a straight, fully collinear through-road
        // naturally hits, where a chamfer is already exactly correct) or would land outside
        // the angular sweep from a to b around center, which would tear the star-shaped
        // boundary the rest of this method's fan triangulation depends on to never self-
        // intersect.
        type GapCorner = { mitred: true; point: THREE.Vector3 } | { mitred: false };
        const gaps: GapCorner[] = arms.map((a, k) => {
            const b = arms[(k + 1) % n];
            const mitre = this.mitreCorner(a.rightEdge, a.forward, b.leftEdge, b.forward);
            if (!mitre) return { mitred: false };

            const refDist = (a.rightEdge.distanceTo(centerFlat) + b.leftEdge.distanceTo(centerFlat)) / 2;
            const mitreDist = mitre.distanceTo(centerFlat);
            if (mitreDist > refDist * 3 || mitreDist < 1e-4) return { mitred: false };

            const dirA = new THREE.Vector2(a.nodePos.x - center.x, a.nodePos.z - center.z);
            const dirB = new THREE.Vector2(b.nodePos.x - center.x, b.nodePos.z - center.z);
            const dirM = new THREE.Vector2(mitre.x - center.x, mitre.z - center.z);
            const crossAM = dirA.x * dirM.y - dirA.y * dirM.x;
            const crossMB = dirM.x * dirB.y - dirM.y * dirB.x;
            if (crossAM < -1e-6 || crossMB < -1e-6) return { mitred: false };

            return { mitred: true, point: mitre };
        });

        for (let k = 0; k < n; k++) {
            const a = arms[k];
            const b = arms[(k + 1) % n];
            const gap = gaps[k];
            const prevGap = gaps[(k - 1 + n) % n];

            // This arm's own mouth, using the mitred corner shared with each neighbor where
            // one was found, otherwise its own raw edge point.
            const rightCorner = gap.mitred ? gap.point : a.rightEdge;
            const leftCorner = prevGap.mitred ? prevGap.point : a.leftEdge;
            this.addFlatTriangle(roadTris, centerFlat, rightCorner, leftCorner, uvOf,
                ['center', `arm${a.i}.rightCorner`, `arm${a.i}.leftCorner`]);

            // The gap between this arm and the next one is only its own separate triangle
            // when NOT mitred - a.rightEdge (the side of arm a that faces arm b) straight
            // across to b.leftEdge (the side of arm b that faces back at arm a). Using
            // a.leftEdge/b.rightEdge here (the sides facing AWAY from each other) was an
            // earlier bug: that gap edge cut clean across the junction toward whichever arm
            // was on the OTHER side instead of connecting to its own genuinely adjacent
            // neighbor. When mitred, rightCorner and leftCorner above already coincide at
            // the shared mitre point, so there is no gap left to fill.
            if (!gap.mitred) {
                this.addFlatTriangle(roadTris, centerFlat, b.leftEdge, a.rightEdge, uvOf,
                    ['center', `arm${b.i}.leftEdge`, `arm${a.i}.rightEdge`]);
            }

            // Sidewalk strip along that same gap, only where both arms actually have one -
            // no sidewalk at all if either connected road lacks one, same rule an ordinary
            // two-road junction already applies. Unlike an earlier version of this, width
            // and curb height are NOT collapsed to a single Math.min() value for the whole
            // piece - innerA/outerA use arm a's own resolved values and innerB/outerB use
            // arm b's own, so each end lines up exactly with whatever that specific
            // connected road actually built at that exact shared point, even when the two
            // roads bordering this gap have different sidewalk widths or curb heights.
            // Using one uniform value for the whole piece was the actual bug behind
            // "the intersection's sidewalk renders under the road's own sidewalk": at
            // whichever end had the taller/wider road, this piece's corner sat at a
            // different height/position than that road's own sidewalk mesh already had
            // there.
            if (a.sidewalkWidth <= 0 || b.sidewalkWidth <= 0) continue;
            const innerA = gap.mitred ? gap.point : a.rightEdge;
            const innerB = gap.mitred ? gap.point : b.leftEdge;

            // Extend outward along each arm's OWN right-vector, not a shared "gap
            // perpendicular" direction (the old approach). A connected Road builds its own
            // sidewalk by offsetting along that exact same resolvedNodeBasis.right at this
            // shared node (see Road's sweepGeometryLine/getGeometryLine) - a single shared
            // outward direction for both ends only happened to line up with that for a
            // perfectly symmetric junction, and diverged from the real connected road's own
            // outer sidewalk corner everywhere else, which is what left a visible seam
            // between the intersection's own sidewalk and each road's own sidewalk mesh.
            // arm b's own right points from its leftEdge toward its rightEdge, i.e. AWAY
            // from this gap, so its own sidewalk extends along -right here.
            const outerA = innerA.clone().addScaledVector(a.right, a.sidewalkWidth);
            const outerB = innerB.clone().addScaledVector(b.right, -b.sidewalkWidth);
            outerA.y += a.curbHeight;
            outerB.y += b.curbHeight;
            const innerAUp = innerA.clone(); innerAUp.y += a.curbHeight;
            const innerBUp = innerB.clone(); innerBUp.y += b.curbHeight;

            // Curb face (vertical) then the sidewalk's own top face. UVs are strip-relative
            // world units - across = height/width in meters (curb face, then the top face,
            // each restarting its own U at the inner edge), along = ground-level distance
            // from innerA to innerB in meters - the exact same convention Road's own
            // sidewalk sweep uses (see getGeometryLine), instead of the flat world-XZ
            // planar projection the "road" group above uses. A flat projection stretches
            // and rotates with this gap's own angle, which is what left the connected
            // road's brick/stone texture looking stretched right where it meets the
            // intersection's own paved corner.
            const swU = (u: number) => u / this.sidewalkTexWidth + this.sidewalkTexOffsetX;
            const swV = (v: number) => v / this.sidewalkTexHeight + this.sidewalkTexOffsetY;
            const alongLen = innerA.distanceTo(innerB);
            const uv0A = new THREE.Vector2(swU(0), swV(0));
            const uv0B = new THREE.Vector2(swU(0), swV(alongLen));
            const uvCurbA = new THREE.Vector2(swU(a.curbHeight), swV(0));
            const uvCurbB = new THREE.Vector2(swU(b.curbHeight), swV(alongLen));
            const uvOuterA = new THREE.Vector2(swU(a.sidewalkWidth), swV(0));
            const uvOuterB = new THREE.Vector2(swU(b.sidewalkWidth), swV(alongLen));

            const gapId = `gap[arm${a.i}->arm${b.i}]`;
            // When mitred, innerA and innerB are the exact same point (by construction, see
            // above) - this first triangle would be degenerate (two identical corners), so
            // skip it; the other three still matter whenever curb height or sidewalk width
            // differs between the two arms even though their inner corner now coincides.
            if (innerA.distanceToSquared(innerB) >= 1e-8) {
                this.addFlatTriangleUV(swTris, innerA, innerB, innerBUp, uv0A, uv0B, uvCurbB,
                    [`${gapId}.innerA`, `${gapId}.innerB`, `${gapId}.innerBUp`]);
            }
            this.addFlatTriangleUV(swTris, innerA, innerBUp, innerAUp, uv0A, uvCurbB, uvCurbA,
                [`${gapId}.innerA`, `${gapId}.innerBUp`, `${gapId}.innerAUp`]);
            this.addFlatTriangleUV(swTris, innerAUp, innerBUp, outerB, uv0A, uv0B, uvOuterB,
                [`${gapId}.innerAUp`, `${gapId}.innerBUp`, `${gapId}.outerB`]);
            this.addFlatTriangleUV(swTris, innerAUp, outerB, outerA, uv0A, uvOuterB, uvOuterA,
                [`${gapId}.innerAUp`, `${gapId}.outerB`, `${gapId}.outerA`]);
        }

        const groups: GeometryGroup[] = [{ name: 'road', triangles: roadTris }];
        if (swTris.length > 0) groups.push({ name: 'sidewalk', triangles: swTris });
        return groups;
    }
}
